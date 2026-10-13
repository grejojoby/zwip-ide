use crate::documents::{hash, Document, Documents};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::Path,
};

#[derive(Clone, Deserialize)]
pub struct Position {
    line: usize,
    character: usize,
}
#[derive(Clone, Deserialize)]
pub struct Range {
    start: Position,
    end: Position,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    path: String,
    revision: Option<u64>,
    file_hash: Option<String>,
    range: Range,
    new_text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    path: String,
    before: String,
    after: String,
    revision: u64,
    file_hash: String,
    #[serde(skip)]
    disk_hash: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    workspace_generation: u64,
    files: Vec<File>,
}
#[derive(Default)]
pub struct Edits {
    next: u64,
    previews: HashMap<String, Preview>,
}
impl Edits {
    pub fn preview(
        &mut self,
        edits: Vec<Edit>,
        docs: &mut Documents,
        root: &str,
        generation: u64,
    ) -> Result<Preview, String> {
        if edits.is_empty() {
            return Err("There are no edits to apply".into());
        }
        let mut grouped = BTreeMap::<String, Vec<Edit>>::new();
        for mut edit in edits {
            let path = Path::new(&edit.path)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            Documents::ensure_writable(&path, root)?;
            edit.path = path.to_string_lossy().into_owned();
            grouped.entry(edit.path.clone()).or_default().push(edit);
        }
        let mut files = Vec::new();
        for (path, edits) in grouped {
            let document = docs.open(Path::new(&path), generation)?;
            let file_hash = hash(document.content.as_bytes());
            let disk_hash = hash(&fs::read(&path).map_err(|e| e.to_string())?);
            if disk_hash != document.disk_hash {
                return Err(format!("{path} changed on disk; reconcile it first"));
            }
            let mut replacements = Vec::new();
            for edit in edits {
                if edit
                    .revision
                    .is_some_and(|r| r != 0 && r != document.revision)
                    || edit.file_hash.as_ref().is_some_and(|h| h != &file_hash)
                {
                    return Err(format!(
                        "{path} changed since analysis; request the operation again"
                    ));
                }
                if edit.revision.unwrap_or(0) == 0 && edit.file_hash.is_none() {
                    return Err(format!(
                        "Provider omitted the content precondition for {path}"
                    ));
                }
                let from = byte_position(&document.content, &edit.range.start)?;
                let to = byte_position(&document.content, &edit.range.end)?;
                if from > to {
                    return Err("Edit range is reversed".into());
                }
                replacements.push((from, to, edit.new_text));
            }
            replacements.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
            replacements.dedup();
            let mut after = document.content.clone();
            let mut previous = after.len();
            for (from, to, text) in replacements {
                if to > previous {
                    return Err(format!("Provider returned overlapping edits for {path}"));
                }
                after.replace_range(from..to, &text);
                previous = from;
            }
            if after != document.content {
                files.push(File {
                    path,
                    before: document.content,
                    after,
                    revision: document.revision,
                    file_hash,
                    disk_hash,
                });
            }
        }
        self.next += 1;
        let preview = Preview {
            id: format!("edit-{}", self.next),
            workspace_generation: generation,
            files,
        };
        // Only the most recent review is actionable; large preview text is bounded by that lifetime.
        self.previews.clear();
        self.previews.insert(preview.id.clone(), preview.clone());
        Ok(preview)
    }
    pub fn apply(
        &mut self,
        id: &str,
        docs: &mut Documents,
        generation: u64,
    ) -> Result<Vec<Document>, String> {
        let preview = self
            .previews
            .get(id)
            .ok_or("Edit preview expired; review the operation again")?;
        if preview.workspace_generation != generation {
            return Err("Workspace changed since edit preview".into());
        }
        for file in &preview.files {
            let doc = docs
                .open
                .get(&file.path)
                .ok_or("An affected document was closed")?;
            if doc.revision != file.revision
                || hash(doc.content.as_bytes()) != file.file_hash
                || hash(&fs::read(&file.path).map_err(|e| e.to_string())?) != file.disk_hash
            {
                return Err(format!(
                    "{} changed since preview; no edits were applied",
                    file.path
                ));
            }
        }
        let tx = docs.db.transaction().map_err(|e| e.to_string())?;
        for file in &preview.files {
            tx.execute("INSERT INTO recovery(path,content,disk_hash,revision) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET content=excluded.content,disk_hash=excluded.disk_hash,revision=excluded.revision",params![file.path,file.after,file.disk_hash,(file.revision+1) as i64]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for file in &preview.files {
            let doc = docs
                .open
                .get_mut(&file.path)
                .ok_or("Affected document missing")?;
            doc.content = file.after.clone();
            doc.revision += 1;
            doc.dirty = true;
            result.push(doc.clone());
        }
        self.previews.remove(id);
        Ok(result)
    }
}
fn byte_position(text: &str, position: &Position) -> Result<usize, String> {
    let mut line = 0;
    let mut character = 0;
    for (offset, c) in text.char_indices() {
        if line == position.line && character == position.character {
            return Ok(offset);
        }
        if c == '\n' {
            if line == position.line {
                return Err("Edit character outside line".into());
            }
            line += 1;
            character = 0;
        } else {
            character += c.len_utf16();
            if line == position.line && character > position.character {
                return Err("Edit splits a UTF-16 surrogate pair".into());
            }
        }
    }
    if line == position.line && character == position.character {
        Ok(text.len())
    } else {
        Err("Edit position outside document".into())
    }
}
