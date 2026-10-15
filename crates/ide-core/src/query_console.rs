use serde_json::{json, Value};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// IntelliJ Database consoles: `consoles/db/<data-source-uuid>/console.sql`,
/// stored in the IDE data directory so they survive project switches.
pub struct QueryConsoles {
    dir: PathBuf,
}

const MAX_BYTES: usize = 1024 * 1024;

pub(crate) fn valid_connection_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

impl QueryConsoles {
    pub fn new(data: &Path) -> Self {
        Self {
            dir: data.join("consoles").join("db"),
        }
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_connection_id(id) {
            return Err("Invalid connection id".into());
        }
        Ok(self.dir.join(id).join("console.sql"))
    }

    pub fn get(&self, id: &str) -> Result<Value, String> {
        let path = self.path(id)?;
        match fs::read(&path) {
            Ok(bytes) => {
                if bytes.len() > MAX_BYTES {
                    return Err("SQL console exceeds 1 MiB".into());
                }
                if bytes.contains(&0) {
                    return Err("SQL console is not UTF-8 text".into());
                }
                let content = String::from_utf8(bytes)
                    .map_err(|_| "SQL console is not UTF-8 text".to_string())?;
                Ok(json!({"content": content}))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(json!({"content": ""})),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn save(&self, id: &str, content: &str) -> Result<Value, String> {
        if content.len() > MAX_BYTES {
            return Err("SQL console exceeds 1 MiB".into());
        }
        if content.contains('\0') {
            return Err("SQL console is not UTF-8 text".into());
        }
        let path = self.path(id)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("sql.tmp");
        fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })?;
        Ok(json!({"content": content}))
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_connection_id(id) {
            return Err("Invalid connection id".into());
        }
        match fs::remove_dir_all(self.dir.join(id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Core;
    use serde_json::json;

    #[test]
    fn default_console_survives_a_new_core_on_the_same_data_dir() {
        let data = tempfile::tempdir().unwrap();
        let first = QueryConsoles::new(data.path());
        first.save("ready-id", "SELECT 1;\n").unwrap();
        let second = QueryConsoles::new(data.path());
        assert_eq!(second.get("ready-id").unwrap()["content"], "SELECT 1;\n");
        assert_eq!(second.get("missing-id").unwrap()["content"], "");
        second.remove("ready-id").unwrap();
        assert_eq!(second.get("ready-id").unwrap()["content"], "");
        assert!(first.save("../escape", "x").is_err());
        assert!(first.save("ready/id", "x").is_err());
    }

    #[test]
    fn rpc_reads_and_writes_without_an_open_workspace() {
        let data = tempfile::tempdir().unwrap();
        let core = Core::new(data.path().to_owned()).unwrap();
        assert_eq!(
            core.request("queryConsole.get", json!({"connectionId":"c1"}))
                .unwrap()["content"],
            ""
        );
        core.request(
            "queryConsole.save",
            json!({"connectionId":"c1","content":"SELECT name FROM t;"}),
        )
        .unwrap();
        let again = Core::new(data.path().to_owned()).unwrap();
        assert_eq!(
            again
                .request("queryConsole.get", json!({"connectionId":"c1"}))
                .unwrap()["content"],
            "SELECT name FROM t;"
        );
        again
            .request(
                "connection.save",
                json!({"id":"c1","kind":"sqlite","name":"Local","config":{"path":"/tmp/demo.db"}}),
            )
            .unwrap();
        again
            .request("connection.delete", json!({"id":"c1"}))
            .unwrap();
        assert_eq!(
            again
                .request("queryConsole.get", json!({"connectionId":"c1"}))
                .unwrap()["content"],
            ""
        );
    }
}
