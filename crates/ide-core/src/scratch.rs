use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// IntelliJ-style scratch files: editable files kept in the IDE's data directory, shared
/// across projects and never part of a workspace index.
pub struct Scratches {
    dir: PathBuf,
}

impl Scratches {
    pub fn new(data: &Path) -> Self {
        Self {
            dir: data.join("scratches"),
        }
    }
    fn dir(&self) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        self.dir.canonicalize().map_err(|e| e.to_string())
    }
    /// Whether `path` names a file directly inside the scratch directory.
    pub fn contains(&self, path: &Path) -> bool {
        self.dir()
            .is_ok_and(|dir| path.parent().is_some_and(|parent| parent == dir))
    }
    pub fn list(&self) -> Result<Value, String> {
        let dir = self.dir()?;
        let mut files = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |time| time.as_millis() as u64);
            files.push(json!({
                "path": entry.path().to_string_lossy(),
                "name": entry.file_name().to_string_lossy(),
                "size": metadata.len(),
                "modified": modified,
            }));
        }
        // Most recently edited first, as IntelliJ's scratch popup lists them.
        files.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
        Ok(json!({"dir": dir.to_string_lossy(), "files": files}))
    }
    /// Creates `scratch.<extension>` (then `scratch_1`, `scratch_2`, …) with `content`.
    pub fn create(&self, extension: &str, content: &str) -> Result<Value, String> {
        if extension.is_empty()
            || extension.len() > 16
            || !extension.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("Choose a file type for the scratch file".into());
        }
        let dir = self.dir()?;
        for index in 0.. {
            let name = if index == 0 {
                format!("scratch.{extension}")
            } else {
                format!("scratch_{index}.{extension}")
            };
            let path = dir.join(name);
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    file.write_all(content.as_bytes())
                        .map_err(|e| e.to_string())?;
                    return Ok(json!({"path": path.to_string_lossy()}));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        unreachable!()
    }
    pub fn delete(&self, path: &str) -> Result<(), String> {
        let path = PathBuf::from(path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !self.contains(&path) {
            return Err("Only scratch files can be deleted here".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_numbered_scratches_and_only_deletes_inside_the_directory() {
        let data = tempfile::tempdir().unwrap();
        let scratches = Scratches::new(data.path());
        let first = scratches.create("go", "package main\n").unwrap();
        let second = scratches.create("go", "").unwrap();
        assert!(first["path"].as_str().unwrap().ends_with("/scratch.go"));
        assert!(second["path"].as_str().unwrap().ends_with("/scratch_1.go"));
        assert_eq!(
            fs::read_to_string(first["path"].as_str().unwrap()).unwrap(),
            "package main\n"
        );
        assert_eq!(
            scratches.list().unwrap()["files"].as_array().unwrap().len(),
            2
        );
        assert!(scratches.create("../x", "").is_err());
        let outside = data.path().join("other.txt");
        fs::write(&outside, "").unwrap();
        assert!(scratches.delete(outside.to_str().unwrap()).is_err());
        scratches.delete(second["path"].as_str().unwrap()).unwrap();
        assert_eq!(
            scratches.list().unwrap()["files"].as_array().unwrap().len(),
            1
        );
    }
}
