use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    title: String,
    category: String,
}

fn read_text(path: &Path, limit: u64) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read query archive".into()),
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Query archive file is invalid or too large".into());
    }
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|_| "Cannot open query archive")?
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Query archive is not readable UTF-8 text")?;
    if text.len() as u64 > limit || text.contains('\0') {
        return Err("Query archive file is invalid or too large".into());
    }
    Ok(Some(text))
}

fn entries(data: &Path) -> Result<Vec<Entry>, String> {
    let Some(text) = read_text(&data.join("query-archive/index.json"), 1024 * 1024)? else {
        return Ok(vec![]);
    };
    let entries: Vec<Entry> =
        serde_json::from_str(&text).map_err(|_| "Invalid query archive index")?;
    let mut ids = std::collections::HashSet::new();
    if entries.len() > 1000
        || entries.iter().any(|entry| {
            entry.id.len() != 64
                || !entry.id.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !ids.insert(&entry.id)
        })
    {
        return Err("Invalid query archive index".into());
    }
    Ok(entries)
}

pub fn list(data: &Path) -> Result<Value, String> {
    serde_json::to_value(entries(data)?).map_err(|_| "Cannot encode query archive".into())
}

pub fn get(data: &Path, id: &str) -> Result<Value, String> {
    if !entries(data)?.iter().any(|entry| entry.id == id) {
        return Err("Archived query not found".into());
    }
    let content = read_text(
        &data.join("query-archive").join(format!("{id}.sql")),
        8 * 1024 * 1024,
    )?
    .ok_or("Archived query file is missing")?;
    Ok(json!({"content": content}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_preserves_large_history_and_rejects_unlisted_paths() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(list(data.path()).unwrap(), json!([]));
        let dir = data.path().join("query-archive");
        fs::create_dir(&dir).unwrap();
        let id = "a".repeat(64);
        let index = json!([{"id":id,"title":"Unmapped history","category":"Query History"}]);
        fs::write(dir.join("index.json"), index.to_string()).unwrap();
        let content = "-- original history\nSELECT 1;\n".repeat(50000);
        fs::write(dir.join(format!("{id}.sql")), &content).unwrap();
        assert_eq!(list(data.path()).unwrap(), index);
        assert_eq!(get(data.path(), &id).unwrap()["content"], content);
        assert!(get(data.path(), "../connections.sqlite").is_err());
        fs::remove_file(dir.join(format!("{id}.sql"))).unwrap();
        assert!(get(data.path(), &id).is_err());
        fs::write(dir.join("index.json"), "invalid").unwrap();
        assert!(list(data.path()).is_err());
    }
    #[test]
    fn rejects_unsafe_index_and_symlinked_content() {
        let data = tempfile::tempdir().unwrap();
        let dir = data.path().join("query-archive");
        fs::create_dir(&dir).unwrap();
        fs::write(
            dir.join("index.json"),
            r#"[{"id":"../escape","title":"x","category":"x"}]"#,
        )
        .unwrap();
        assert!(list(data.path()).is_err());
        #[cfg(unix)]
        {
            let id = "b".repeat(64);
            fs::write(
                dir.join("index.json"),
                json!([{"id":id,"title":"x","category":"x"}]).to_string(),
            )
            .unwrap();
            std::os::unix::fs::symlink(dir.join("index.json"), dir.join(format!("{id}.sql")))
                .unwrap();
            assert!(get(data.path(), &id).is_err());
        }
    }
}
