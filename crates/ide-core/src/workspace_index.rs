//! Language-neutral workspace inventory and content identity. Provider-owned semantic
//! checkpoints use this identity; inventory alone is never advertised as semantic readiness.
use crate::workspace::{self, DiscoveryRule, Workspace};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::atomic::AtomicU64,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexState {
    pub state: String,
    pub fingerprint: Option<String>,
    pub epoch: Option<String>,
    pub reason: Option<String>,
    pub rebuild: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    schema: u32,
    fingerprint: String,
    epoch: String,
    workspace: Workspace,
}

fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn path(data: &Path, root: &Path) -> std::path::PathBuf {
    data.join("workspace-index")
        .join(digest(root.to_string_lossy().as_bytes()))
        .join("inventory.json")
}
fn shape(workspace: &Workspace, rules: &[DiscoveryRule]) -> Result<Vec<u8>, String> {
    let mut base = workspace.clone();
    base.generation = 0;
    base.index = None;
    serde_json::to_vec(&(1, &base, rules)).map_err(|e| e.to_string())
}
fn identity(workspace: &Workspace, rules: &[DiscoveryRule]) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(shape(workspace, rules)?);
    let mut buffer = [0; 65536];
    for file in &workspace.files {
        let mut input = fs::File::open(&file.path)
            .map_err(|e| format!("Cannot validate workspace index: {e}"))?;
        let mut content = Sha256::new();
        loop {
            let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            content.update(&buffer[..n]);
        }
        hash.update(content.finalize());
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn exists(data: &Path, root: &Path) -> bool {
    root.canonicalize()
        .is_ok_and(|root| path(data, &root).is_file())
}

pub fn scan(
    data: &Path,
    root: &Path,
    generation: u64,
    rules: &[DiscoveryRule],
    exclusions: &[String],
    scanned: &AtomicU64,
    rebuild: bool,
) -> Result<Workspace, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let filename = path(data, &root);
    // Use the canonical discovery/ignore implementation to validate offline additions,
    // removals, profiles and ignore-rule changes, rather than trusting directory mtimes.
    let mut workspace = workspace::scan(&root, generation, rules, exclusions, scanned)?;
    let result = (|| -> Result<IndexState, String> {
        let fingerprint = identity(&workspace, rules)?;
        let previous: Option<Inventory> = fs::File::open(&filename)
            .ok()
            .and_then(|file| serde_json::from_reader(file.take(64 * 1024 * 1024)).ok());
        let loaded = !rebuild
            && previous.as_ref().is_some_and(|item| {
                item.schema == 1
                    && item.fingerprint == fingerprint
                    && item.workspace.root == workspace.root
                    && shape(&item.workspace, rules).ok() == shape(&workspace, rules).ok()
            });
        let epoch = if !rebuild {
            previous
                .as_ref()
                .filter(|item| item.schema == 1)
                .map(|item| item.epoch.clone())
        } else {
            None
        }
        .unwrap_or_else(|| format!("{}-{:?}", std::process::id(), std::time::SystemTime::now()));
        let provider_fingerprint = digest(format!("{fingerprint}:{epoch}").as_bytes());
        if loaded {
            workspace = previous.unwrap().workspace;
            workspace.generation = generation;
        } else {
            let dir = filename.parent().unwrap();
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
                fs::set_permissions(dir.parent().unwrap(), fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
            let snapshot = Inventory {
                schema: 1,
                fingerprint,
                epoch: epoch.clone(),
                workspace: workspace.clone(),
            };
            let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut temporary, &snapshot).map_err(|e| e.to_string())?;
            temporary.flush().map_err(|e| e.to_string())?;
            temporary.as_file().sync_all().map_err(|e| e.to_string())?;
            temporary.persist(&filename).map_err(|e| e.to_string())?;
        }
        Ok(IndexState {
            state: if loaded { "loaded" } else { "built" }.into(),
            fingerprint: Some(provider_fingerprint),
            epoch: Some(digest(
                &serde_json::to_vec(&(epoch, rules, exclusions)).map_err(|e| e.to_string())?,
            )),
            reason: None,
            rebuild,
        })
    })();
    workspace.index = Some(result.unwrap_or_else(|reason| IndexState {
        state: "unavailable".into(),
        fingerprint: None,
        epoch: None,
        reason: Some(reason),
        rebuild,
    }));
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inventory_restores_and_invalidates_content_files_profiles_and_rebuilds() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::write(root.path().join("go.mod"), "module test/index\ngo 1.25.0\n").unwrap();
        fs::write(root.path().join("main.go"), "package main\n").unwrap();
        let scanned = AtomicU64::new(0);
        let read = |generation, rebuild| {
            scan(
                data.path(),
                root.path(),
                generation,
                &workspace::default_rules().unwrap(),
                &[],
                &scanned,
                rebuild,
            )
            .unwrap()
        };
        let first = read(1, false);
        assert_eq!(first.index.as_ref().unwrap().state, "built");
        let next = read(2, false);
        assert_eq!(next.index.as_ref().unwrap().state, "loaded");
        assert_eq!(next.generation, 2);
        assert_eq!(
            first.index.as_ref().unwrap().fingerprint,
            next.index.as_ref().unwrap().fingerprint
        );
        fs::write(root.path().join("main.go"), "package next\n").unwrap();
        let changed = read(3, false);
        assert_eq!(changed.index.as_ref().unwrap().state, "built");
        assert_ne!(
            changed.index.as_ref().unwrap().fingerprint,
            next.index.as_ref().unwrap().fingerprint
        );
        fs::write(root.path().join("added.go"), "package next\n").unwrap();
        assert_eq!(read(4, false).index.unwrap().state, "built");
        fs::remove_file(root.path().join("added.go")).unwrap();
        assert_eq!(read(5, false).index.unwrap().state, "built");
        let before = read(6, false);
        let rebuilt = read(7, true);
        assert_ne!(
            before.index.unwrap().fingerprint,
            rebuilt.index.unwrap().fingerprint
        );
        fs::write(
            path(data.path(), &root.path().canonicalize().unwrap()),
            "broken",
        )
        .unwrap();
        assert_eq!(read(8, false).index.unwrap().state, "built");
    }
}
