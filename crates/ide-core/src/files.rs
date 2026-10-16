use crate::{
    documents::{hash, Documents},
    string, Core,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilePlan {
    id: String,
    operation: String,
    path: String,
    destination: Option<String>,
    bytes: u64,
    #[serde(skip)]
    hash: String,
    #[serde(skip)]
    generation: u64,
}
fn target(root: &str, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Enter a path relative to this workspace, without parent traversal".into());
    }
    let combined = Path::new(root).join(relative);
    let parent = combined
        .parent()
        .ok_or("Missing parent directory")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    Documents::ensure_writable(&parent, root)?;
    Ok(parent.join(combined.file_name().ok_or("Missing filename")?))
}
fn source_hash(path: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
impl Core {
    pub(crate) fn files(&self, method: &str, params: &Value) -> Result<Value, String> {
        let _transition = self
            .workspace_transition
            .lock()
            .map_err(|e| e.to_string())?;
        let workspace = self.current()?;
        if matches!(method, "workspace.createFile" | "workspace.createDirectory") {
            let path = target(&workspace.root, string(params, "relativePath")?)?;
            if method == "workspace.createDirectory" {
                fs::create_dir(&path).map_err(|e| e.to_string())?;
            } else {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|e| e.to_string())?;
                file.write_all(b"")
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"path":path}));
        }
        if method == "workspace.revealFile" {
            let path = Path::new(string(params, "path")?)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            Documents::ensure_writable(&path, &workspace.root)?;
            #[cfg(target_os = "macos")]
            {
                let status = std::process::Command::new("/usr/bin/open")
                    .arg("-R")
                    .arg(&path)
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err("Finder could not reveal this path".into());
                }
                return Ok(json!({"path":path}));
            }
            #[cfg(not(target_os = "macos"))]
            return Err("Show in Finder is available on macOS".into());
        }
        let trash = self.data.join("trash");
        fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let mut docs = self.documents.lock().map_err(|e| e.to_string())?;
        docs.db.execute_batch("CREATE TABLE IF NOT EXISTS trashed_files(id TEXT PRIMARY KEY,path TEXT NOT NULL,stored_path TEXT NOT NULL,created_at INTEGER NOT NULL,bytes INTEGER NOT NULL)").map_err(|e|e.to_string())?;
        if method == "workspace.trashList" {
            let mut statement=docs.db.prepare("SELECT id,path,stored_path,created_at,bytes FROM trashed_files ORDER BY created_at DESC").map_err(|e|e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut entries = Vec::new();
            for row in rows {
                let (id, path, stored, created, bytes) = row.map_err(|e| e.to_string())?;
                if Path::new(&path).starts_with(&workspace.root) {
                    entries.push(json!({"id":id,"path":path,"createdAt":created,"bytes":bytes,"available":Path::new(&stored).is_file()}));
                }
            }
            return Ok(json!(entries));
        }
        if method == "workspace.trashRestore" {
            let id = string(params, "id")?;
            let (path, stored): (String, String) = docs
                .db
                .query_row(
                    "SELECT path,stored_path FROM trashed_files WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            let relative = Path::new(&path)
                .strip_prefix(&workspace.root)
                .map_err(|e| e.to_string())?;
            let path = target(&workspace.root, &relative.to_string_lossy())?;
            fs::hard_link(&stored, &path)
                .map_err(|e| format!("Cannot restore; existing files are preserved: {e}"))?;
            fs::remove_file(&stored).map_err(|e| {
                format!("Restored copy, but the trash entry could not be removed: {e}")
            })?;
            docs.db
                .execute("DELETE FROM trashed_files WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            if let Some(parent) = Path::new(&stored).parent() {
                let _ = fs::remove_dir(parent);
            }
            self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"path":path}));
        }
        if method == "workspace.filePreview" {
            let path = string(params, "path")?;
            if fs::symlink_metadata(path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("File actions do not follow symbolic links".into());
            }
            let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
            Documents::ensure_writable(&path, &workspace.root)?;
            let path = path.to_string_lossy().into_owned();
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                return Err("Rename, copy, and trash currently apply to individual files".into());
            }
            if docs.open.get(&path).is_some_and(|doc| doc.dirty) {
                return Err(
                    "Save this file before renaming, copying, or moving it to trash".into(),
                );
            }
            let operation = string(params, "operation")?;
            let destination = match operation {
                "rename" | "copy" => Some(
                    target(&workspace.root, string(params, "destination")?)?
                        .to_string_lossy()
                        .into_owned(),
                ),
                "trash" => None,
                _ => return Err("Unsupported file action".into()),
            };
            if destination
                .as_ref()
                .is_some_and(|path| Path::new(path).exists())
            {
                return Err("Destination already exists".into());
            }
            let fingerprint = source_hash(&path)?;
            let plan = FilePlan {
                id: hash(
                    format!(
                        "{}:{operation}:{path}:{destination:?}:{fingerprint}",
                        workspace.generation
                    )
                    .as_bytes(),
                ),
                operation: operation.into(),
                path,
                destination,
                bytes: metadata.len(),
                hash: fingerprint,
                generation: workspace.generation,
            };
            *self.file_plan.lock().map_err(|e| e.to_string())? = Some(plan.clone());
            return serde_json::to_value(plan).map_err(|e| e.to_string());
        }
        let plan = self
            .file_plan
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Preview this file action first")?;
        if plan.id != string(params, "id")?
            || plan.generation != workspace.generation
            || source_hash(&plan.path)? != plan.hash
        {
            return Err("File or workspace changed; review the action again".into());
        }
        if docs.open.get(&plan.path).is_some_and(|doc| doc.dirty) {
            return Err("Save this file before applying the action".into());
        }
        validate_plan_paths(&plan, &workspace.root)?;
        if plan.operation == "copy" {
            let destination = plan
                .destination
                .as_ref()
                .ok_or("Missing copy destination")?;
            let mut source = fs::File::open(&plan.path).map_err(|e| e.to_string())?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut source, &mut output)
                .and_then(|_| output.set_permissions(source.metadata()?.permissions()))
                .and_then(|_| output.sync_all())
                .map_err(|e| e.to_string())
                .and_then(|_| {
                    if source_hash(destination)? != plan.hash {
                        return Err("Source changed while copying; review again".into());
                    }
                    Ok(())
                });
            if let Err(error) = copied {
                drop(output);
                let _ = fs::remove_file(destination);
                return Err(error);
            }
            *self.file_plan.lock().map_err(|e| e.to_string())? = None;
            self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
            return Ok(json!({"path":destination}));
        }
        // Close provider overlays before moving the source. The editor must flush
        // its buffer before requesting this operation; dirty mirrors are rejected.
        let revision = docs.open.get(&plan.path).map(|doc| doc.revision);
        if let Some(revision) = revision {
            docs.close(&plan.path, revision)?;
        }
        drop(docs);
        let workers = self
            .packages
            .lock()
            .map_err(|e| e.to_string())?
            .running_workers();
        for worker in workers {
            if !worker.accepts_document(&plan.path) {
                continue;
            }
            let mut revisions = worker.revisions.lock().map_err(|e| e.to_string())?;
            worker.request_with_timeout(
                "document.close",
                json!({"path":plan.path}),
                std::time::Duration::from_secs(15),
            )?;
            revisions.remove(&plan.path);
        }
        // Recheck after provider synchronization, which can yield to external edits.
        if source_hash(&plan.path)? != plan.hash {
            return Err("File changed; review the action again".into());
        }
        validate_plan_paths(&plan, &workspace.root)?;
        let docs = self.documents.lock().map_err(|e| e.to_string())?;
        let result = if let Some(destination) = &plan.destination {
            fs::hard_link(&plan.path, destination).map_err(|e| e.to_string())?;
            fs::remove_file(&plan.path)
                .map_err(|e| format!("New path exists, but original could not be removed: {e}"))?;
            docs.db
                .execute(
                    "UPDATE history SET path=?1 WHERE path=?2",
                    rusqlite::params![destination, plan.path],
                )
                .map_err(|e| e.to_string())?;
            json!({"path":destination})
        } else {
            let directory = tempfile::Builder::new()
                .prefix("file-")
                .tempdir_in(&trash)
                .map_err(|e| e.to_string())?
                .keep();
            let stored = directory.join("contents");
            let id = directory
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            docs.db.execute("INSERT INTO trashed_files(id,path,stored_path,created_at,bytes) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![id,plan.path,stored.to_string_lossy(),timestamp,plan.bytes as i64]).map_err(|e|e.to_string())?;
            if let Err(error) = fs::rename(&plan.path, &stored) {
                let _ = docs
                    .db
                    .execute("DELETE FROM trashed_files WHERE id=?1", [&id]);
                let _ = fs::remove_dir(&directory);
                return Err(error.to_string());
            }
            json!({"trashedId":id})
        };
        *self.file_plan.lock().map_err(|e| e.to_string())? = None;
        self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }
}

fn validate_plan_paths(plan: &FilePlan, root: &str) -> Result<(), String> {
    if fs::symlink_metadata(&plan.path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
        || Path::new(&plan.path)
            .canonicalize()
            .map_err(|error| error.to_string())?
            != Path::new(&plan.path)
    {
        return Err("Source path changed; review the action again".into());
    }
    if let Some(destination) = &plan.destination {
        let relative = Path::new(destination)
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        if target(root, &relative.to_string_lossy())? != Path::new(destination) {
            return Err("Destination path changed; review the action again".into());
        }
    }
    Ok(())
}
