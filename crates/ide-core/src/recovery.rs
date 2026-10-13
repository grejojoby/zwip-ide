use crate::{documents::Documents, string};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Component, Path},
};

impl Documents {
    pub fn recovery(&mut self, method: &str, params: &Value, root: &str) -> Result<Value, String> {
        if method == "recovery.list" {
            let mut statement = self.db.prepare("SELECT path,revision,length(CAST(content AS BLOB)),substr(content,1,500) FROM recovery ORDER BY path").map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut entries = Vec::new();
            for row in rows {
                let (path, revision, bytes, preview) = row.map_err(|e| e.to_string())?;
                if Path::new(&path).starts_with(root) {
                    entries.push(json!({"path":path,"revision":revision,"bytes":bytes,"preview":preview,"missing":!Path::new(&path).exists(),"open":self.open.contains_key(&path)}));
                }
            }
            return Ok(json!(entries));
        }
        let path = string(params, "path")?;
        if !Path::new(path).starts_with(root) {
            return Err("Recovery belongs to another workspace".into());
        }
        let revision = params["revision"]
            .as_i64()
            .ok_or("Missing recovery revision")?;
        let (content, current): (String, i64) = self
            .db
            .query_row(
                "SELECT content,revision FROM recovery WHERE path=?1",
                [path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if current != revision {
            return Err("Recovery changed; refresh before continuing".into());
        }
        if method == "recovery.discard" {
            if self.open.contains_key(path) {
                return Err("This buffer is still open. Save it or reopen the workspace before discarding recovery.".into());
            }
            self.db
                .execute(
                    "DELETE FROM recovery WHERE path=?1 AND revision=?2",
                    params![path, revision],
                )
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        let destination = Path::new(string(params, "destination")?);
        if destination
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("Recovery destination must not contain parent traversal".into());
        }
        let parent = destination
            .parent()
            .ok_or("Missing recovery destination directory")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !parent.starts_with(root) {
            return Err("Recovery copy must remain in this workspace".into());
        }
        let destination = parent.join(
            destination
                .file_name()
                .ok_or("Missing destination filename")?,
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| {
                format!("Cannot create recovery copy (existing files are preserved): {e}")
            })?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        // Keep the original recovery until explicitly discarded, even after exporting a copy.
        Ok(json!({"path":destination}))
    }
}
