use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub content: String,
    pub revision: u64,
    pub workspace_generation: u64,
    pub dirty: bool,
    #[serde(skip)]
    pub disk_hash: String,
}
#[derive(Deserialize)]
pub struct Delta {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}
pub struct Documents {
    sync_backups: HashMap<String, Document>,
    pub open: HashMap<String, Document>,
    pub db: Connection,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl Documents {
    pub fn clear(&mut self) {
        self.open.clear();
        self.sync_backups.clear();
    }

    pub fn close(&mut self, path: &str, revision: u64) -> Result<bool, String> {
        let Some(document) = self.open.get(path) else {
            return Ok(true);
        };
        if document.revision != revision {
            return Err("Document changed while closing".into());
        }
        // Closed unsaved buffers still participate in semantic analysis and recovery.
        if document.dirty {
            return Ok(false);
        }
        self.open.remove(path);
        self.sync_backups.remove(path);
        Ok(true)
    }
    pub fn new(data: &Path) -> Result<Self, String> {
        fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let db = Connection::open(data.join("workspace.sqlite")).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS recovery(path TEXT PRIMARY KEY, content TEXT NOT NULL, disk_hash TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, path TEXT NOT NULL, timestamp INTEGER NOT NULL, content TEXT NOT NULL); CREATE INDEX IF NOT EXISTS history_path ON history(path, timestamp); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e|e.to_string())?;
        Ok(Self {
            sync_backups: HashMap::new(),
            open: HashMap::new(),
            db,
        })
    }
    pub fn open(&mut self, path: &Path, generation: u64) -> Result<Document, String> {
        let path = path.to_string_lossy().into_owned();
        if let Some(doc) = self.open.get(&path) {
            return Ok(doc.clone());
        }
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        if metadata.len() > 16 * 1024 * 1024 {
            return Err("File exceeds the 16 MiB editable-file limit".into());
        }
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Cannot open as UTF-8 text: {e}"))?;
        if content.contains('\0') {
            return Err("Binary files cannot be opened in the text editor".into());
        }
        let mut doc = Document {
            path: path.clone(),
            disk_hash: hash(content.as_bytes()),
            content,
            revision: 1,
            workspace_generation: generation,
            dirty: false,
        };
        let recovered: Result<(String, String, i64), _> = self.db.query_row(
            "SELECT content,disk_hash,revision FROM recovery WHERE path=?1",
            [&path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );
        if let Ok((content, disk_hash, revision)) = recovered {
            doc.content = content;
            doc.disk_hash = disk_hash;
            doc.revision = revision as u64;
            doc.dirty = true;
        }
        self.open.insert(path, doc.clone());
        Ok(doc)
    }
    pub fn change(
        &mut self,
        path: &str,
        revision: u64,
        mut changes: Vec<Delta>,
    ) -> Result<serde_json::Value, String> {
        let doc = self.open.get_mut(path).ok_or("Document is not open")?;
        if doc.revision != revision {
            return Err("Document revision changed; synchronize the buffer before editing".into());
        }
        changes.sort_by_key(|change| std::cmp::Reverse(change.from));
        let mut content = doc.content.clone();
        let mut previous = content.encode_utf16().count();
        for change in changes {
            if change.from > change.to || change.to > previous {
                return Err("Invalid or overlapping edit ranges".into());
            }
            let from = utf16_byte(&content, change.from)?;
            let to = utf16_byte(&content, change.to)?;
            content.replace_range(from..to, &change.insert);
            previous = change.from;
        }
        let next = doc.revision + 1;
        self.db.execute("INSERT INTO recovery(path,content,disk_hash,revision) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET content=excluded.content,disk_hash=excluded.disk_hash,revision=excluded.revision",params![path,content,doc.disk_hash,next as i64]).map_err(|e|e.to_string())?;
        doc.content = content;
        doc.revision = next;
        doc.dirty = true;
        Ok(
            serde_json::json!({"path":doc.path,"revision":doc.revision,"workspaceGeneration":doc.workspace_generation,"dirty":true}),
        )
    }
    pub fn save(&mut self, path: &str, revision: u64) -> Result<Document, String> {
        let doc = self.open.get_mut(path).ok_or("Document is not open")?;
        if doc.revision != revision {
            return Err("Save rejected: buffer revision changed".into());
        }
        let original = fs::read(path).map_err(|e| e.to_string())?;
        if hash(&original) != doc.disk_hash {
            return Err("File changed on disk. Your unsaved buffer is preserved; reconcile the external changes before saving.".into());
        }
        if !doc.dirty {
            return Ok(doc.clone());
        }
        self.db
            .execute(
                "INSERT INTO history(path,timestamp,content) VALUES(?1,?2,?3)",
                params![path, now(), String::from_utf8_lossy(&original)],
            )
            .map_err(|e| e.to_string())?;
        let parent = Path::new(path).parent().ok_or("Missing parent directory")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temporary
            .as_file()
            .set_permissions(fs::metadata(path).map_err(|e| e.to_string())?.permissions())
            .map_err(|e| e.to_string())?;
        temporary
            .write_all(doc.content.as_bytes())
            .map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(path).map_err(|e| e.to_string())?;
        doc.disk_hash = hash(doc.content.as_bytes());
        doc.dirty = false;
        self.db
            .execute("DELETE FROM recovery WHERE path=?1", [path])
            .map_err(|e| e.to_string())?;
        // Recovery is separate and never aged out. History is bounded by age and bytes.
        let history: String = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='history'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "{}".into());
        let settings: serde_json::Value = serde_json::from_str(&history).unwrap_or_default();
        let days = settings["retentionDays"]
            .as_i64()
            .unwrap_or(7)
            .clamp(1, 365);
        let bytes = settings["maxBytes"]
            .as_i64()
            .unwrap_or(64 * 1024 * 1024)
            .clamp(16 * 1024 * 1024, 1024 * 1024 * 1024);
        self.db
            .execute(
                "DELETE FROM history WHERE timestamp < ?1",
                [now().saturating_sub(days * 24 * 3600)],
            )
            .map_err(|e| e.to_string())?;
        self.db.execute("DELETE FROM history WHERE id IN (SELECT id FROM (SELECT id,SUM(length(CAST(content AS BLOB))) OVER (ORDER BY id DESC) AS total FROM history) WHERE total>?1)",[bytes]).map_err(|e|e.to_string())?;
        Ok(doc.clone())
    }
    pub fn sync(&mut self, path: &str) -> Result<serde_json::Value, String> {
        let doc = self.open.get_mut(path).ok_or("Document is not open")?;
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => {
                return Ok(serde_json::json!({"document":doc,"changed":true,"conflict":true}))
            }
        };
        let disk_hash = hash(content.as_bytes());
        if disk_hash == doc.disk_hash {
            return Ok(serde_json::json!({"document":doc,"changed":false,"conflict":false}));
        }
        if doc.dirty {
            return Ok(serde_json::json!({"document":doc,"changed":true,"conflict":true}));
        }
        self.sync_backups.insert(path.into(), doc.clone());
        doc.content = content;
        doc.disk_hash = disk_hash;
        doc.revision += 1;
        Ok(
            serde_json::json!({"rollbackRevision":doc.revision,"document":doc,"changed":true,"conflict":false}),
        )
    }
    pub fn reject_sync(&mut self, path: &str, revision: u64) -> Result<serde_json::Value, String> {
        let current = self.open.get(path).ok_or("Document is not open")?;
        if current.revision != revision {
            return Err("Sync rollback revision is stale; buffer remains preserved".into());
        }
        let mut previous = self
            .sync_backups
            .get(path)
            .ok_or("Sync rollback expired")?
            .clone();
        previous.revision = revision + 1;
        previous.dirty = true;
        self.db.execute("INSERT INTO recovery(path,content,disk_hash,revision) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET content=excluded.content,disk_hash=excluded.disk_hash,revision=excluded.revision",params![path,previous.content,previous.disk_hash,previous.revision as i64]).map_err(|e|e.to_string())?;
        let result = serde_json::to_value(&previous).map_err(|e| e.to_string())?;
        self.open.insert(path.into(), previous);
        self.sync_backups.remove(path);
        Ok(result)
    }
    pub fn history(&self, path: &str) -> Result<serde_json::Value, String> {
        let mut stmt = self
            .db
            .prepare(
                "SELECT id,timestamp,content FROM history WHERE path=?1 ORDER BY id DESC LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows=stmt.query_map([path],|row|Ok(serde_json::json!({"id":row.get::<_,i64>(0)?,"timestamp":row.get::<_,i64>(1)?,"content":row.get::<_,String>(2)?,"path":path}))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map(serde_json::Value::from)
            .map_err(|e| e.to_string())
    }
    pub fn ensure_writable(path: &Path, root: &str) -> Result<(), String> {
        if path.starts_with(PathBuf::from(root)) {
            Ok(())
        } else {
            Err("Dependency source outside this workspace is read-only".into())
        }
    }
}
fn utf16_byte(text: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units == offset {
            return Ok(byte);
        }
        units += c.len_utf16();
        if units > offset {
            return Err("Edit splits a UTF-16 surrogate pair".into());
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err("Edit offset is outside the document".into())
    }
}
