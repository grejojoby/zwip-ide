mod remote;
use crate::documents::hash;
pub use remote::RemoteUpdates;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::{Seek, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

fn run_with(
    root: &str,
    args: &[&str],
    index: Option<&Path>,
    input: Option<&[u8]>,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    // Limit literal pathspec mode to leaf commands that receive file paths.
    // Workflow commands (notably stash) run internal pathspecs of their own.
    if args.first().is_some_and(|arg| {
        matches!(
            *arg,
            "add" | "diff" | "blame" | "ls-tree" | "ls-files" | "update-index"
        )
    }) {
        command.arg("--literal-pathspecs");
    }
    command
        .args(["-C", root])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or("Missing Git stdin")?
            .write_all(input)
            .map_err(|e| e.to_string())?;
    }
    child.wait_with_output().map_err(|e| e.to_string())
}
fn output_error(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    )
    .trim()
    .to_owned()
}
fn run(root: &str, args: &[&str]) -> Result<Output, String> {
    run_with(root, args, None, None)
}
fn git_index(
    root: &str,
    args: &[&str],
    index: Option<&Path>,
    input: Option<&[u8]>,
) -> Result<String, String> {
    let output = run_with(root, args, index, input)?;
    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|_| "Git returned non-UTF-8 metadata".into())
    } else {
        Err(output_error(&output))
    }
}
fn git(root: &str, args: &[&str]) -> Result<String, String> {
    git_index(root, args, None, None)
}
fn repo_root(root: &str) -> Result<String, String> {
    Ok(git(root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_owned())
}
fn path_arg(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Expected repository-relative file path".into());
    }
    Ok(())
}
fn safe_path(root: &str, path: &str) -> Result<PathBuf, String> {
    path_arg(path)?;
    let target = Path::new(root).join(path);
    let mut parent = target.parent();
    while let Some(directory) = parent {
        if directory == Path::new(root) {
            break;
        }
        if fs::symlink_metadata(directory).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(
                "A parent directory is a symbolic link; cannot operate outside the repository"
                    .into(),
            );
        }
        parent = directory.parent();
    }
    Ok(target)
}
fn head(root: &str) -> String {
    git(root, &["rev-parse", "--verify", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_owned()
}
fn git_path(root: &str, name: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
        )?
        .trim(),
    ))
}
fn has_operation(root: &str, name: &str) -> bool {
    git_path(root, name).is_ok_and(|p| p.exists())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    oid: String,
    stage: u8,
}
fn index_entries(
    root: &str,
    path: Option<&str>,
    index: Option<&Path>,
) -> Result<Vec<(String, Entry)>, String> {
    let mut args = vec!["ls-files", "--stage", "-z"];
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let output = run_with(root, &args, index, None)?;
    if !output.status.success() {
        return Err(output_error(&output));
    }
    output
        .stdout
        .split(|b| *b == 0)
        .filter(|item| !item.is_empty())
        .map(|item| {
            let item =
                std::str::from_utf8(item).map_err(|_| "Non-UTF-8 Git paths are not supported")?;
            let (meta, path) = item.split_once('\t').ok_or("Invalid index record")?;
            let parts: Vec<_> = meta.split(' ').collect();
            if parts.len() != 3 {
                return Err("Invalid index metadata".into());
            }
            Ok((
                path.into(),
                Entry {
                    mode: parts[0].into(),
                    oid: parts[1].into(),
                    stage: parts[2].parse().map_err(|_| "Invalid index stage")?,
                },
            ))
        })
        .collect()
}
fn head_entry(root: &str, path: &str) -> Result<Option<Entry>, String> {
    if head(root).is_empty() {
        return Ok(None);
    }
    tree_entry(root, "HEAD", path)
}
fn tree_entry(root: &str, commit: &str, path: &str) -> Result<Option<Entry>, String> {
    let output = run(root, &["ls-tree", "-z", commit, "--", path])?;
    if !output.status.success() {
        return Err(output_error(&output));
    }
    let first = output.stdout.split(|b| *b == 0).next().unwrap_or_default();
    if first.is_empty() {
        return Ok(None);
    }
    let meta = std::str::from_utf8(first)
        .map_err(|_| "Non-UTF-8 tree entry")?
        .split('\t')
        .next()
        .ok_or("Invalid tree entry")?;
    let parts: Vec<_> = meta.split(' ').collect();
    if parts.len() != 3 {
        return Err("Invalid tree metadata".into());
    }
    Ok(Some(Entry {
        mode: parts[0].into(),
        oid: parts[2].into(),
        stage: 0,
    }))
}
fn blob(root: &str, entry: Option<&Entry>) -> Result<Vec<u8>, String> {
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    if entry.mode == "160000" {
        return Ok(entry.oid.as_bytes().to_vec());
    }
    let output = run(root, &["cat-file", "blob", &entry.oid])?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(output_error(&output))
    }
}
fn checkout_blob(root: &str, path: &str, entry: &Entry) -> Result<Vec<u8>, String> {
    if entry.mode != "100644" && entry.mode != "100755" {
        return blob(root, Some(entry));
    }
    let output = run(
        root,
        &[
            "cat-file",
            "--filters",
            &format!("--path={path}"),
            &entry.oid,
        ],
    )?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(output_error(&output))
    }
}
fn worktree_bytes(root: &str, path: &str) -> Result<Vec<u8>, String> {
    let full = safe_path(root, path)?;
    match fs::symlink_metadata(&full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
        Ok(meta) if meta.file_type().is_symlink() => Ok(fs::read_link(full)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .as_bytes()
            .to_vec()),
        Ok(meta) if meta.is_file() => fs::read(full).map_err(|e| e.to_string()),
        Ok(_) => Ok(Vec::new()),
    }
}
fn binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || bytes.len() > 16 * 1024 * 1024 || std::str::from_utf8(bytes).is_err()
}

pub fn status(root: &str) -> Result<Value, String> {
    let root = repo_root(root)?;
    let head = head(&root);
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_else(|_| "Detached HEAD".into())
        .trim()
        .to_owned();
    let output = run(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !output.status.success() {
        return Err(output_error(&output));
    }
    let mut entries = output
        .stdout
        .split(|c| *c == 0)
        .filter(|entry| !entry.is_empty());
    let mut files = Vec::new();
    let mut fingerprint = format!("{head}\n{branch}\n").into_bytes();
    fingerprint.extend_from_slice(&output.stdout);
    fingerprint.extend_from_slice(&run(&root, &["ls-files", "--stage", "-z"])?.stdout);
    fingerprint.extend_from_slice(
        git(
            &root,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
                "refs/remotes",
                "refs/stash",
            ],
        )?
        .as_bytes(),
    );
    fingerprint.extend_from_slice(
        git(&root, &["reflog", "show", "--format=%H", "refs/stash"])
            .unwrap_or_default()
            .as_bytes(),
    );
    let operation_path = git_path(&root, "MERGE_HEAD")?;
    let metadata_root = operation_path
        .parent()
        .ok_or("Missing Git metadata directory")?;
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge/onto",
        "rebase-merge/head-name",
        "rebase-merge/done",
        "rebase-apply/onto",
        "rebase-apply/next",
    ] {
        let path = metadata_root.join(name);
        if path.exists() {
            fingerprint.extend_from_slice(name.as_bytes());
            fingerprint.extend_from_slice(&fs::read(path).map_err(|e| e.to_string())?);
        }
    }
    for args in [
        vec!["diff", "--binary", "--no-ext-diff", "--no-textconv"],
        vec![
            "diff",
            "--cached",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
        ],
    ] {
        fingerprint.extend_from_slice(git(&root, &args)?.as_bytes());
    }
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            return Err("Invalid Git status record".into());
        }
        let path = String::from_utf8(entry[3..].to_vec())
            .map_err(|_| "Non-UTF-8 Git paths are not supported")?;
        let original = if matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C') {
            Some(
                String::from_utf8(entries.next().ok_or("Missing rename source")?.to_vec())
                    .map_err(|_| "Non-UTF-8 Git paths are not supported")?,
            )
        } else {
            None
        };
        fingerprint.extend_from_slice(hash(&worktree_bytes(&root, &path)?).as_bytes());
        files.push(json!({"path":path,"indexStatus":char::from(entry[0]).to_string(),"worktreeStatus":char::from(entry[1]).to_string(),"originalPath":original}));
    }
    Ok(
        json!({"root":root,"branch":branch,"head":head,"fingerprint":hash(&fingerprint),"files":files}),
    )
}

fn text_patch(before: &[u8], after: &[u8]) -> Result<String, String> {
    patch_with_context(before, after, 3)
}
fn patch_with_context(before: &[u8], after: &[u8], context: usize) -> Result<String, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    fs::write(temp.path().join("before"), before).map_err(|e| e.to_string())?;
    fs::write(temp.path().join("after"), after).map_err(|e| e.to_string())?;
    let output = run(
        temp.path().to_str().ok_or("Non-UTF-8 temporary path")?,
        &[
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--text",
            &format!("--unified={context}"),
            "--",
            "before",
            "after",
        ],
    )?;
    if output.status.code().is_some_and(|code| code <= 1) {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(output_error(&output))
    }
}
fn parse_hunks(patch: &str) -> Result<Vec<Value>, String> {
    let mut hunks: Vec<Value> = Vec::new();
    let mut old = 0_u64;
    let mut new = 0_u64;
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let fields: Vec<_> = line.split_whitespace().collect();
            old = fields
                .get(1)
                .and_then(|x| x.trim_start_matches('-').split(',').next())
                .ok_or("Invalid diff hunk")?
                .parse()
                .map_err(|_| "Invalid old diff position")?;
            new = fields
                .get(2)
                .and_then(|x| x.trim_start_matches('+').split(',').next())
                .ok_or("Invalid diff hunk")?
                .parse()
                .map_err(|_| "Invalid new diff position")?;
            hunks.push(
                json!({"id":format!("h{}",hunks.len()),"oldStart":old,"newStart":new,"lines":[]}),
            );
        } else if let Some(hunk) = hunks.last_mut() {
            let Some(prefix) = line.as_bytes().first().copied() else {
                continue;
            };
            let (kind, old_line, new_line, id) = match prefix {
                b' ' => (
                    "context",
                    Some(old),
                    Some(new),
                    format!("context:{old}:{new}"),
                ),
                b'-' => ("remove", Some(old), None, format!("remove:{old}")),
                b'+' => ("add", None, Some(new), format!("add:{new}")),
                _ => continue,
            };
            hunk["lines"].as_array_mut().ok_or("Invalid hunk model")?.push(json!({"id":id,"kind":kind,"text":&line[1..],"oldLine":old_line,"newLine":new_line}));
            if prefix != b'+' {
                old += 1;
            }
            if prefix != b'-' {
                new += 1;
            }
        }
    }
    Ok(hunks)
}
pub fn diff(root: &str, path: &str) -> Result<Value, String> {
    path_arg(path)?;
    let snapshot = status(root)?;
    let root = snapshot["root"].as_str().ok_or("Missing root")?;
    let change = snapshot["files"]
        .as_array()
        .ok_or("Missing files")?
        .iter()
        .find(|file| file["path"] == path);
    let original = change.and_then(|file| file["originalPath"].as_str());
    let entry = head_entry(root, original.unwrap_or(path))?;
    let before = blob(root, entry.as_ref())?;
    let after = worktree_bytes(root, path)?;
    let stages = index_entries(root, Some(path), None)?;
    let metadata = fs::symlink_metadata(safe_path(root, path)?).ok();
    let kind = if entry.as_ref().is_some_and(|e| e.mode == "160000")
        || stages.iter().any(|(_, e)| e.mode == "160000")
    {
        "submodule"
    } else if entry.as_ref().is_some_and(|e| e.mode == "120000")
        || metadata
            .as_ref()
            .is_some_and(|m| m.file_type().is_symlink())
    {
        "symlink"
    } else if binary(&before) || binary(&after) {
        "binary"
    } else if original.is_some() {
        "rename"
    } else {
        "text"
    };
    let is_binary = kind == "binary" || kind == "submodule";
    let patch = if is_binary {
        git(
            root,
            &["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", path],
        )
        .unwrap_or_default()
    } else {
        text_patch(&before, &after)?
    };
    let partial_allowed = kind == "text" && !stages.iter().any(|(_, e)| e.stage > 0);
    let hunks = if partial_allowed {
        parse_hunks(&patch)?
    } else {
        Vec::new()
    };
    Ok(
        json!({"path":path,"before":if is_binary {String::new()} else {String::from_utf8_lossy(&before).into_owned()},"after":if is_binary {String::new()} else {String::from_utf8_lossy(&after).into_owned()},"patch":patch,"binary":is_binary,"kind":kind,"partialAllowed":partial_allowed,"hunks":hunks,"fingerprint":snapshot["fingerprint"]}),
    )
}

struct IndexLock {
    path: PathBuf,
    index: PathBuf,
    file: Option<fs::File>,
    installed: bool,
}
impl IndexLock {
    fn acquire(root: &str) -> Result<Self, String> {
        let index = git_path(root, "index")?;
        let path = PathBuf::from(format!("{}.lock", index.display()));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                format!("Cannot lock Git index; another Git operation may be active: {e}")
            })?;
        Ok(Self {
            path,
            index,
            file: Some(file),
            installed: false,
        })
    }
    fn prepare(&mut self, candidate: &Path) -> Result<(), String> {
        let file = self.file.as_mut().ok_or("Index lock was closed")?;
        file.set_len(0)
            .and_then(|_| file.rewind())
            .map_err(|e| e.to_string())?;
        file.write_all(&fs::read(candidate).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
    fn install(mut self) -> Result<(), String> {
        self.file.take();
        // Retain the prepared lock if installation fails after HEAD or worktree changed.
        self.installed = true;
        fs::rename(&self.path, &self.index).map_err(|e| {
            format!(
                "Operation succeeded but index installation failed; preserve {} for recovery: {e}",
                self.path.display()
            )
        })?;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if !self.installed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn temporary_index(root: &str, copy: bool) -> Result<tempfile::TempPath, String> {
    let index = git_path(root, "index")?;
    let temp = tempfile::Builder::new()
        .prefix("zwip-index-")
        .tempfile_in(index.parent().ok_or("Missing Git index directory")?)
        .map_err(|e| e.to_string())?
        .into_temp_path();
    if copy && index.exists() {
        fs::copy(index, &temp).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&temp).map_err(|e| e.to_string())?;
        git_index(root, &["read-tree", "--empty"], Some(&temp), None)?;
    }
    Ok(temp)
}
fn set_entry(root: &str, index: &Path, path: &str, entry: Option<&Entry>) -> Result<(), String> {
    if let Some(entry) = entry {
        git_index(
            root,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{},{},{}", entry.mode, entry.oid, path),
            ],
            Some(index),
            None,
        )?;
    } else {
        git_index(
            root,
            &["update-index", "--force-remove", "--", path],
            Some(index),
            None,
        )?;
    }
    Ok(())
}
fn write_blob(root: &str, path: &str, bytes: &[u8]) -> Result<String, String> {
    Ok(git_index(
        root,
        &["hash-object", "-w", &format!("--path={path}"), "--stdin"],
        None,
        Some(bytes),
    )?
    .trim()
    .to_owned())
}
fn write_raw_blob(root: &str, bytes: &[u8]) -> Result<String, String> {
    Ok(
        git_index(root, &["hash-object", "-w", "--stdin"], None, Some(bytes))?
            .trim()
            .to_owned(),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    path: String,
    change_ids: Option<Vec<String>>,
}
fn selected_content(diff: &Value, ids: &[String]) -> Result<Vec<u8>, String> {
    if !diff["partialAllowed"].as_bool().unwrap_or(false) {
        return Err("Partial selection requires an ordinary text file without unresolved conflicts or renames".into());
    }
    let before = diff["before"].as_str().ok_or("Missing original text")?;
    let after = diff["after"].as_str().ok_or("Missing working text")?;
    let old: Vec<_> = before.split_inclusive('\n').collect();
    let new: Vec<_> = after.split_inclusive('\n').collect();
    let chosen: HashSet<_> = ids.iter().map(String::as_str).collect();
    if chosen.is_empty() {
        return Err("Select at least one changed line".into());
    }
    let mut remaining = chosen.clone();
    let mut cursor = 0;
    let mut result = String::new();
    for hunk in diff["hunks"].as_array().ok_or("Missing diff hunks")? {
        for line in hunk["lines"].as_array().ok_or("Missing diff lines")? {
            let kind = line["kind"].as_str().ok_or("Missing line kind")?;
            let id = line["id"].as_str().ok_or("Missing line ID")?;
            if kind == "add" {
                let index = line["newLine"].as_u64().ok_or("Missing added line")? as usize - 1;
                if chosen.contains(id) {
                    result.push_str(new.get(index).ok_or("Added line no longer exists")?);
                    remaining.remove(id);
                }
            } else {
                let index = line["oldLine"].as_u64().ok_or("Missing old line")? as usize - 1;
                while cursor < index {
                    result.push_str(old.get(cursor).ok_or("Original line no longer exists")?);
                    cursor += 1;
                }
                if kind == "context" || !chosen.contains(id) {
                    result.push_str(old.get(index).ok_or("Original line no longer exists")?);
                } else {
                    remaining.remove(id);
                }
                cursor = index + 1;
            }
        }
    }
    for line in old.iter().skip(cursor) {
        result.push_str(line);
    }
    if !remaining.is_empty() {
        return Err("Selected line IDs are stale or invalid; review the diff again".into());
    }
    Ok(result.into_bytes())
}
fn merge_staged(
    root: &str,
    previous: Option<&Entry>,
    base: Option<&Entry>,
    selected: &Entry,
) -> Result<Vec<u8>, String> {
    let old = blob(root, previous)?;
    let base = blob(root, base)?;
    let target = blob(root, Some(selected))?;
    if old == base || old == target {
        return Ok(target);
    }
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    for (file, bytes) in [("staged", &old), ("base", &base), ("selected", &target)] {
        fs::write(temp.path().join(file), bytes).map_err(|e| e.to_string())?;
    }
    let result = run(
        temp.path()
            .to_str()
            .ok_or("Non-UTF-8 temporary directory")?,
        &["merge-file", "-p", "--", "staged", "base", "selected"],
    )?;
    if !result.status.success() {
        return Err("Selected lines overlap different already-staged content; review or unstage that overlapping change first".into());
    }
    Ok(result.stdout)
}
fn normal_index(root: &str, index: &Path) -> Result<BTreeMap<String, Entry>, String> {
    let entries = index_entries(root, None, Some(index))?;
    if entries.iter().any(|(_, entry)| entry.stage != 0) {
        return Err("A commit hook left unmerged index entries".into());
    }
    Ok(entries.into_iter().collect())
}
/// Rebase hook changes onto the index that also contains unrelated staged work.
/// The worktree and original index remain untouched until the complete result is validated.
fn reconcile_hook_index(
    root: &str,
    planned: &BTreeMap<String, Entry>,
    hook_index: &Path,
    preserved_index: &Path,
) -> Result<(), String> {
    let actual = normal_index(root, hook_index)?;
    let preserved = normal_index(root, preserved_index)?;
    let paths: std::collections::BTreeSet<_> = planned.keys().chain(actual.keys()).collect();
    let mut changes = Vec::new();
    for path in paths {
        let base = planned.get(path);
        let hook = actual.get(path);
        if base == hook {
            continue;
        }
        let ours = preserved.get(path);
        let merged = if ours == base || ours == hook {
            hook.cloned()
        } else if let (Some(base), Some(ours), Some(hook)) = (base, ours, hook) {
            if [base, ours, hook]
                .iter()
                .any(|entry| !matches!(entry.mode.as_str(), "100644" | "100755"))
            {
                return Err(format!(
                    "Hook changes overlap staged non-text or mode changes in {path}"
                ));
            }
            let content = merge_staged(root, Some(ours), Some(base), hook).map_err(|error| {
                format!("Hook changes could not be reconciled in {path}: {error}")
            })?;
            Some(Entry {
                mode: if ours.mode == base.mode {
                    hook.mode.clone()
                } else {
                    ours.mode.clone()
                },
                oid: write_raw_blob(root, &content)?,
                stage: 0,
            })
        } else {
            return Err(format!(
                "Hook addition/deletion overlaps unrelated staged content in {path}"
            ));
        };
        changes.push((path, merged));
    }
    for (path, entry) in changes {
        set_entry(root, preserved_index, path, entry.as_ref())?;
    }
    Ok(())
}
pub fn commit(
    root: &str,
    paths: &[String],
    message: &str,
    fingerprint: &str,
) -> Result<Value, String> {
    let selections = paths
        .iter()
        .map(|path| Selection {
            path: path.clone(),
            change_ids: None,
        })
        .collect::<Vec<_>>();
    commit_selection(root, &selections, message, fingerprint)
}
pub fn commit_selection(
    root: &str,
    selections: &[Selection],
    message: &str,
    fingerprint: &str,
) -> Result<Value, String> {
    if message.trim().is_empty() || selections.is_empty() {
        return Err("Select changes and provide a commit message".into());
    }
    let root = repo_root(root)?;
    if operation(&root) != "none" {
        return Err("An integration operation is in progress; resolve conflicts and use its Continue action before committing selected changes".into());
    }
    let mut lock = IndexLock::acquire(&root)?;
    let snapshot = status(&root)?;
    if snapshot["fingerprint"] != fingerprint {
        return Err("Repository changed; review the selected changes again".into());
    }
    if index_entries(&root, None, None)?
        .iter()
        .any(|(_, entry)| entry.stage > 0)
    {
        return Err("Resolve unmerged files before committing selected changes".into());
    }
    let old_head = head(&root);
    let commit_index = temporary_index(&root, false)?;
    if !old_head.is_empty() {
        git_index(&root, &["read-tree", &old_head], Some(&commit_index), None)?;
    }
    let preserved_index = temporary_index(&root, true)?;
    let mut seen = HashSet::new();
    for selection in selections {
        path_arg(&selection.path)?;
        if !seen.insert(selection.path.clone()) {
            return Err("A file appears in the selection more than once".into());
        }
        let change = snapshot["files"]
            .as_array()
            .ok_or("Missing changes")?
            .iter()
            .find(|file| file["path"] == selection.path)
            .ok_or("A selected file has no pending changes")?;
        let mut paths = vec![selection.path.as_str()];
        if change["indexStatus"] == "R" || change["worktreeStatus"] == "R" {
            if let Some(original) = change["originalPath"].as_str() {
                paths.push(original);
            }
        }
        for path in &paths {
            git_index(&root, &["add", "-A", "--", path], Some(&commit_index), None)?;
        }
        if let Some(ids) = &selection.change_ids {
            let preview = diff(&root, &selection.path)?;
            let content = selected_content(&preview, ids)?;
            let base = head_entry(&root, &selection.path)?;
            let full = index_entries(&root, Some(&selection.path), Some(&commit_index))?
                .into_iter()
                .find(|(_, entry)| entry.stage == 0)
                .map(|(_, entry)| entry);
            let mode = base
                .as_ref()
                .or(full.as_ref())
                .map(|entry| entry.mode.clone())
                .unwrap_or_else(|| "100644".into());
            let selected = Entry {
                mode: mode.clone(),
                oid: write_blob(&root, &selection.path, &content)?,
                stage: 0,
            };
            set_entry(&root, &commit_index, &selection.path, Some(&selected))?;
            let previous = index_entries(&root, Some(&selection.path), Some(&preserved_index))?
                .into_iter()
                .find(|(_, entry)| entry.stage == 0)
                .map(|(_, entry)| entry);
            let staged = merge_staged(&root, previous.as_ref(), base.as_ref(), &selected)?;
            let preserved = Entry {
                mode: previous
                    .as_ref()
                    .map(|entry| entry.mode.clone())
                    .unwrap_or(mode),
                oid: write_raw_blob(&root, &staged)?,
                stage: 0,
            };
            set_entry(&root, &preserved_index, &selection.path, Some(&preserved))?;
        } else {
            for path in paths {
                let entry = index_entries(&root, Some(path), Some(&commit_index))?
                    .into_iter()
                    .find(|(_, entry)| entry.stage == 0)
                    .map(|(_, entry)| entry);
                set_entry(&root, &preserved_index, path, entry.as_ref())?;
            }
        }
    }
    if status(&root)?["fingerprint"] != fingerprint || head(&root) != old_head {
        return Err("Repository changed while preparing the commit; review again".into());
    }
    lock.prepare(&preserved_index)?;
    let planned = normal_index(&root, &commit_index)?;
    // Git executes configured hooks and signing using the selected index. The real index remains locked and unchanged on failure.
    git_index(&root, &["commit", "-m", message], Some(&commit_index), None)?;
    // Successful pre-commit hooks may format and stage files; post-commit hooks may
    // stage further changes. Both must be reflected without reversing the new commit.
    if let Err(error) = reconcile_hook_index(&root, &planned, &commit_index, &preserved_index)
        .and_then(|_| lock.prepare(&preserved_index))
    {
        let committed = head(&root);
        let preserved = preserved_index.keep().map_err(|e| e.to_string())?;
        let hooked = commit_index.keep().map_err(|e| e.to_string())?;
        return Err(format!("Commit {committed} was created, but its hook changes need review: {error}. The original staged index and current worktree were preserved. Recovery indexes: {} and {}", preserved.display(), hooked.display()));
    }
    lock.install()?;
    status(&root)
}

pub fn push_plan(root: &str) -> Result<Value, String> {
    let snapshot = status(root)?;
    let root = snapshot["root"].as_str().ok_or("Missing repository root")?;
    let branch = snapshot["branch"].as_str().ok_or("Missing branch")?;
    let remote = git(
        root,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .map_err(|_| "Current branch has no upstream; configure tracking before pushing")?
    .trim()
    .to_owned();
    let remote_ref = git(
        root,
        &["config", "--get", &format!("branch.{branch}.merge")],
    )?
    .trim()
    .to_owned();
    if remote == "." {
        return Err(
            "The current branch tracks a local branch; configure a push remote first".into(),
        );
    }
    if !remote_ref.starts_with("refs/heads/") {
        return Err("Push destination must be a branch".into());
    }
    let urls = git(root, &["remote", "get-url", "--push", "--all", &remote])?;
    let push_urls: Vec<_> = urls.lines().collect();
    if push_urls.len() != 1 {
        return Err("Push review requires exactly one push URL for the selected remote".into());
    }
    let upstream = git(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])?
        .trim()
        .to_owned();
    let upstream_oid = git(root, &["rev-parse", &upstream])?.trim().to_owned();
    let remote_state = git(
        root,
        &["ls-remote", "--refs", "--", push_urls[0], &remote_ref],
    )?;
    let remote_oid = remote_state.split_whitespace().next().unwrap_or_default();
    if remote_oid != upstream_oid {
        return Err(
            "Remote branch changed since the last fetch; fetch and review the push again".into(),
        );
    }
    let range = format!("{upstream}..HEAD");
    let log = git(root, &["log", "--format=%H%x09%s%x09%an", &range])?;
    let commits: Vec<_> = log.lines().map(|line| { let mut fields = line.splitn(3, '\t'); json!({"id":fields.next().unwrap_or_default(),"subject":fields.next().unwrap_or_default(),"author":fields.next().unwrap_or_default()}) }).collect();
    let files_output = run(root, &["diff", "--name-only", "-z", &upstream, "HEAD"])?;
    if !files_output.status.success() {
        return Err(output_error(&files_output));
    }
    let files: Vec<_> = files_output
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8(p.to_vec()).map_err(|_| "Non-UTF-8 Git paths are unsupported"))
        .collect::<Result<_, _>>()?;
    let diff = git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--default-prefix",
            "--no-color",
            "--submodule=short",
            "--output-indicator-new=+",
            "--output-indicator-old=-",
            "--output-indicator-context= ",
            &upstream,
            "HEAD",
        ],
    )?;
    // Both commands use the same ordering and rename detection, so each output path
    // maps to one patch. Never parse Git's quoted filenames.
    let patches: Vec<_> =
        diff.split_inclusive('\n')
            .fold(Vec::<String>::new(), |mut parts, line| {
                if line.starts_with("diff --git ") {
                    parts.push(String::new());
                }
                if let Some(part) = parts.last_mut() {
                    part.push_str(line);
                }
                parts
            });
    if patches.len() != files.len() {
        return Err("Could not match outgoing files to their patches".into());
    }
    let file_patches: serde_json::Map<String, Value> = files
        .iter()
        .cloned()
        .zip(patches.into_iter().map(Value::String))
        .collect();
    let fingerprint = hash(
        format!(
            "{}\n{branch}\n{remote}\n{remote_ref}\n{upstream_oid}\n{remote_oid}\n{urls}",
            snapshot["head"]
        )
        .as_bytes(),
    );
    Ok(
        json!({"fingerprint":fingerprint,"head":snapshot["head"],"base":upstream_oid,"remote":remote,"branch":branch,"upstream":upstream,"remoteRef":remote_ref,"commits":commits,"files":files,"diff":diff,"filePatches":file_patches}),
    )
}
pub fn push(root: &str, fingerprint: &str) -> Result<Value, String> {
    let plan = push_plan(root)?;
    if plan["fingerprint"] != fingerprint {
        return Err("Push preview is stale; review outgoing commits again".into());
    }
    let remote = plan["remote"].as_str().ok_or("Missing remote")?;
    let remote_ref = plan["remoteRef"].as_str().ok_or("Missing destination")?;
    let reviewed_head = plan["head"].as_str().ok_or("Missing reviewed commit")?;
    // Freeze the reviewed commit instead of pushing a possibly changed HEAD.
    let result = git(
        root,
        &[
            "push",
            "--porcelain",
            "--",
            remote,
            &format!("{reviewed_head}:{remote_ref}"),
        ],
    )?;
    Ok(json!(result))
}

fn conflict_stages(root: &str, path: &str) -> Result<BTreeMap<u8, Entry>, String> {
    let entries = index_entries(root, Some(path), None)?
        .into_iter()
        .filter(|(_, entry)| entry.stage > 0)
        .map(|(_, entry)| (entry.stage, entry))
        .collect::<BTreeMap<_, _>>();
    if entries.is_empty() {
        return Err("This file is no longer conflicted".into());
    }
    Ok(entries)
}
pub fn conflicts(root: &str) -> Result<Value, String> {
    let paths: std::collections::BTreeSet<_> = index_entries(root, None, None)?
        .into_iter()
        .filter(|(_, entry)| entry.stage > 0)
        .map(|(path, _)| path)
        .collect();
    Ok(json!(paths))
}
fn revision_label(root: &str, reference: &str) -> Option<String> {
    // Only caller-owned revision names are accepted here. Include the exact
    // commit identity even when several branch names point to the same commit.
    let revision = git(root, &["rev-parse", "--short=12", "--verify", reference]).ok()?;
    let revision = revision.trim();
    if revision.is_empty() {
        return None;
    }
    let branches = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--points-at",
            reference,
            "refs/heads",
            "refs/remotes",
        ],
    )
    .unwrap_or_default()
    .lines()
    .take(3)
    .map(str::to_owned)
    .collect::<Vec<_>>();
    Some(if branches.is_empty() {
        revision.to_owned()
    } else {
        format!("{} · {revision}", branches.join(", "))
    })
}
pub fn merge_open(root: &str, path: &str) -> Result<Value, String> {
    path_arg(path)?;
    let root = repo_root(root)?;
    let snapshot = status(&root)?;
    let stages = conflict_stages(&root, path)?;
    let base = blob(&root, stages.get(&1))?;
    let ours = blob(&root, stages.get(&2))?;
    let theirs = blob(&root, stages.get(&3))?;
    let kind = if stages.values().any(|entry| entry.mode == "160000") {
        "submodule"
    } else if stages.values().any(|entry| entry.mode == "120000") {
        "symlink"
    } else if [&base, &ours, &theirs].iter().any(|bytes| binary(bytes)) {
        "binary"
    } else {
        "text"
    };
    let conflict_type = if !stages.contains_key(&2) && !stages.contains_key(&3) {
        "deleteDelete"
    } else if !stages.contains_key(&2) || !stages.contains_key(&3) {
        "modifyDelete"
    } else if !stages.contains_key(&1) {
        "addAdd"
    } else {
        "content"
    };
    let (operation, ours_label, theirs_label) =
        if has_operation(&root, "rebase-merge") || has_operation(&root, "rebase-apply") {
            (
                "rebase",
                "Current (rebased target)",
                "Incoming (commit being replayed)",
            )
        } else if has_operation(&root, "CHERRY_PICK_HEAD") {
            (
                "cherryPick",
                "Current (HEAD)",
                "Incoming (cherry-picked commit)",
            )
        } else if has_operation(&root, "REVERT_HEAD") {
            ("revert", "Current (HEAD)", "Incoming (reverted change)")
        } else if has_operation(&root, "MERGE_HEAD") {
            ("merge", "Current (HEAD)", "Incoming (MERGE_HEAD)")
        } else {
            (
                "unknown",
                "Current (index stage 2)",
                "Incoming (index stage 3)",
            )
        };
    let incoming_reference = match operation {
        "merge" => Some("MERGE_HEAD"),
        "rebase" => Some("REBASE_HEAD"),
        "cherryPick" => Some("CHERRY_PICK_HEAD"),
        "revert" => Some("REVERT_HEAD^"),
        _ => None,
    };
    let ours_label = revision_label(&root, "HEAD")
        .map(|identity| format!("{ours_label} · {identity}"))
        .unwrap_or_else(|| ours_label.to_owned());
    let theirs_label = incoming_reference
        .and_then(|reference| revision_label(&root, reference))
        .map(|identity| format!("{theirs_label} · {identity}"))
        .unwrap_or_else(|| theirs_label.to_owned());
    let text = |stage: u8, bytes: &[u8]| {
        if stages.contains_key(&stage) && kind == "text" {
            Some(String::from_utf8_lossy(bytes).into_owned())
        } else {
            None
        }
    };
    let result = if kind == "text" {
        Some(
            String::from_utf8(worktree_bytes(&root, path)?)
                .map_err(|_| "Working result is not valid UTF-8")?,
        )
    } else {
        None
    };
    Ok(
        json!({"path":path,"fingerprint":snapshot["fingerprint"],"kind":kind,"conflictType":conflict_type,"base":text(1,&base),"ours":text(2,&ours),"theirs":text(3,&theirs),"result":result,"labels":{"base":"Common ancestor","ours":ours_label,"theirs":theirs_label},"operation":operation,"oursDeleted":!stages.contains_key(&2),"theirsDeleted":!stages.contains_key(&3)}),
    )
}
pub fn merge_apply(
    root: &str,
    path: &str,
    fingerprint: &str,
    resolution: &str,
    result: Option<&str>,
) -> Result<Value, String> {
    let root = repo_root(root)?;
    let full = safe_path(&root, path)?;
    let mut lock = IndexLock::acquire(&root)?;
    let session = merge_open(&root, path)?;
    if session["fingerprint"] != fingerprint {
        return Err(
            "Merge result is stale; review changed repository content before applying".into(),
        );
    }
    let stages = conflict_stages(&root, path)?;
    let selected = match resolution {
        "ours" => stages.get(&2).cloned(),
        "theirs" => stages.get(&3).cloned(),
        "delete" => None,
        "result" => {
            if session["kind"] != "text" {
                return Err(
                    "Non-text conflicts require an explicit side or deletion choice".into(),
                );
            }
            let text = result.ok_or("Missing merged text")?;
            let mode = stages
                .get(&2)
                .or_else(|| stages.get(&3))
                .map(|entry| entry.mode.clone())
                .unwrap_or_else(|| "100644".into());
            Some(Entry {
                mode,
                oid: write_blob(&root, path, text.as_bytes())?,
                stage: 0,
            })
        }
        _ => return Err("Unknown merge resolution".into()),
    };
    let index = temporary_index(&root, true)?;
    set_entry(&root, &index, path, selected.as_ref())?;
    lock.prepare(&index)?;
    if status(&root)?["fingerprint"] != fingerprint {
        return Err("Repository changed while preparing the merge result; review again".into());
    }
    match selected.as_ref() {
        None => {
            if full.exists() || fs::symlink_metadata(&full).is_ok() {
                if full.is_dir() {
                    return Err(
                        "Deleting a conflicted directory requires a dedicated submodule operation"
                            .into(),
                    );
                }
                fs::remove_file(&full).map_err(|e| e.to_string())?;
            }
        }
        Some(entry) if entry.mode == "160000" => {} // Resolves the gitlink without changing the nested checkout.
        Some(entry) if entry.mode == "120000" => {
            let target = String::from_utf8(blob(&root, Some(entry))?)
                .map_err(|_| "Non-UTF-8 symbolic link targets are unsupported")?;
            #[cfg(unix)]
            {
                if fs::symlink_metadata(&full).is_ok() {
                    fs::remove_file(&full).map_err(|e| e.to_string())?;
                }
                std::os::unix::fs::symlink(target, &full).map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err("Symbolic link resolution is not available on this platform".into());
            }
        }
        Some(entry) => {
            let parent = full.parent().ok_or("Missing file directory")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            temp.write_all(&checkout_blob(&root, path, entry)?)
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temp.as_file()
                    .set_permissions(fs::Permissions::from_mode(if entry.mode == "100755" {
                        0o755
                    } else {
                        0o644
                    }))
                    .map_err(|e| e.to_string())?;
            }
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            temp.persist(&full).map_err(|e| e.to_string())?;
        }
    }
    lock.install()?;
    status(&root)
}

fn changelist_db(data: &Path) -> Result<Connection, String> {
    fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let connection = Connection::open(data.join("git-state.sqlite3")).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS changelists (repo TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(repo,id));").map_err(|e| e.to_string())?;
    Ok(connection)
}
pub fn changelists(root: &str, data: &Path) -> Result<Value, String> {
    let snapshot = status(root)?;
    let root = snapshot["root"].as_str().ok_or("Missing root")?;
    let connection = changelist_db(data)?;
    let mut statement = connection
        .prepare("SELECT id,name,payload FROM changelists WHERE repo=?1 ORDER BY name,id")
        .map_err(|e| e.to_string())?;
    let records = statement
        .query_map([root], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut lists = Vec::new();
    let mut assigned = HashSet::new();
    let mut partial: BTreeMap<String, (HashSet<String>, bool)> = BTreeMap::new();
    for row in records {
        let (id, name, payload) = row.map_err(|e| e.to_string())?;
        let mut payload: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        for path in payload["paths"]
            .as_array()
            .ok_or("Invalid persisted changelist")?
        {
            if let Some(path) = path.as_str() {
                if let Some(selection) = payload["selections"]
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["path"] == path))
                {
                    let entry = partial.entry(path.to_owned()).or_default();
                    entry.1 |= selection["fingerprint"] != snapshot["fingerprint"];
                    for id in selection["changeIds"]
                        .as_array()
                        .ok_or("Invalid saved line assignment")?
                    {
                        entry
                            .0
                            .insert(id.as_str().ok_or("Invalid saved change ID")?.to_owned());
                    }
                } else {
                    assigned.insert(path.to_owned());
                }
            }
        }
        if let Some(selections) = payload["selections"].as_array_mut() {
            for selection in selections {
                selection["stale"] = json!(selection["fingerprint"] != snapshot["fingerprint"]);
            }
        }
        lists.push(json!({"id":id,"name":name,"paths":payload["paths"],"selections":payload["selections"]}));
    }
    let mut default_paths = Vec::new();
    let mut default_selections = Vec::new();
    for file in snapshot["files"].as_array().ok_or("Missing files")? {
        let path = string(file, "path")?;
        if assigned.contains(path) {
            continue;
        }
        if let Some((taken, stale)) = partial.get(path) {
            let remaining = if *stale {
                Vec::new()
            } else {
                change_ids(root, path, &snapshot["fingerprint"])?
                    .into_iter()
                    .filter(|id| !taken.contains(id))
                    .collect::<Vec<_>>()
            };
            if remaining.is_empty() && !stale {
                continue;
            }
            default_selections.push(json!({"path":path,"changeIds":remaining,"fingerprint":if *stale { json!("") } else { snapshot["fingerprint"].clone() },"stale":stale}));
        }
        default_paths.push(path.to_owned());
    }
    lists.insert(0, json!({"id":"default","name":"Default","paths":default_paths,"selections":default_selections}));
    Ok(json!(lists))
}
fn change_ids(root: &str, path: &str, fingerprint: &Value) -> Result<Vec<String>, String> {
    let diff = diff(root, path)?;
    if &diff["fingerprint"] != fingerprint {
        return Err("Repository changed while reading line assignments; refresh".into());
    }
    if diff["partialAllowed"] != true {
        return Err("This file cannot be split between changelists".into());
    }
    let mut ids = Vec::new();
    for hunk in diff["hunks"].as_array().ok_or("Missing diff hunks")? {
        for line in hunk["lines"].as_array().ok_or("Missing diff lines")? {
            if line["kind"] != "context" {
                ids.push(string(line, "id")?.to_owned());
            }
        }
    }
    Ok(ids)
}

fn save_changelist(
    root: &str,
    data: &Path,
    id: &str,
    name: &str,
    paths: &[String],
    selections: &Value,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("Changelist name is required".into());
    }
    let root = repo_root(root)?;
    let mut paths = paths.to_vec();
    let snapshot = status(&root)?;
    let selection_values = if selections.is_null() {
        Vec::new()
    } else {
        selections
            .as_array()
            .ok_or("Invalid changelist selections")?
            .clone()
    };
    let mut selected_ids = BTreeMap::new();
    for selection in &selection_values {
        let path = string(selection, "path")?;
        if selection["fingerprint"] != snapshot["fingerprint"] {
            return Err("Changelist assignment is stale; review the intended lines again".into());
        }
        let ids: Vec<String> =
            serde_json::from_value(selection["changeIds"].clone()).map_err(|e| e.to_string())?;
        let available = change_ids(&root, path, &snapshot["fingerprint"])?;
        if ids.is_empty() || ids.iter().any(|id| !available.contains(id)) {
            return Err("Select existing changed lines for a partial assignment".into());
        }
        if selected_ids
            .insert(path.to_owned(), ids.into_iter().collect::<HashSet<_>>())
            .is_some()
        {
            return Err("Duplicate partial assignment for one file".into());
        }
        if !paths.iter().any(|item| item == path) {
            paths.push(path.into());
        }
    }
    for path in &paths {
        path_arg(path)?;
    }
    paths.sort();
    paths.dedup();
    let id = if id.is_empty() {
        hash(
            format!(
                "{root}:{name}:{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
            )
            .as_bytes(),
        )[..16]
            .to_owned()
    } else {
        id.to_owned()
    };
    let mut connection = changelist_db(data)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let records = {
        let mut statement = transaction
            .prepare("SELECT id,payload FROM changelists WHERE repo=?1 AND id<>?2")
            .map_err(|e| e.to_string())?;
        let records = statement
            .query_map(params![root, id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        records
    };
    for (other_id, payload) in records {
        let mut payload: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let mut other_paths: Vec<String> =
            serde_json::from_value(payload["paths"].clone()).map_err(|e| e.to_string())?;
        let mut other_selections = payload["selections"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for path in &paths {
            if !other_paths.contains(path) {
                continue;
            }
            let Some(moved) = selected_ids.get(path) else {
                other_paths.retain(|item| item != path);
                other_selections.retain(|item| item["path"] != *path);
                continue;
            };
            let previous = other_selections.iter().find(|item| item["path"] == *path);
            let ids = if let Some(previous) = previous {
                if previous["fingerprint"] != snapshot["fingerprint"] {
                    return Err("Another changelist has stale line assignments for this file; review them before splitting it".into());
                }
                serde_json::from_value::<Vec<String>>(previous["changeIds"].clone())
                    .map_err(|e| e.to_string())?
            } else {
                change_ids(&root, path, &snapshot["fingerprint"])?
            };
            let remaining = ids
                .into_iter()
                .filter(|id| !moved.contains(id))
                .collect::<Vec<_>>();
            other_selections.retain(|item| item["path"] != *path);
            if remaining.is_empty() {
                other_paths.retain(|item| item != path);
            } else {
                other_selections.push(json!({"path":path,"changeIds":remaining,"fingerprint":snapshot["fingerprint"]}));
            }
        }
        payload["paths"] = json!(other_paths);
        payload["selections"] = json!(other_selections);
        transaction
            .execute(
                "UPDATE changelists SET payload=?1 WHERE repo=?2 AND id=?3",
                params![payload.to_string(), root, other_id],
            )
            .map_err(|e| e.to_string())?;
    }
    if id != "default" {
        transaction.execute("INSERT INTO changelists(repo,id,name,payload) VALUES(?1,?2,?3,?4) ON CONFLICT(repo,id) DO UPDATE SET name=excluded.name,payload=excluded.payload",params![root,id,name,json!({"paths":paths,"selections":selection_values}).to_string()]).map_err(|e|e.to_string())?;
    }
    if status(&root)?["fingerprint"] != snapshot["fingerprint"] {
        return Err("Repository changed while assigning changes; review them again".into());
    }
    transaction.commit().map_err(|e| e.to_string())?;
    changelists(&root, data)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing string field: {key}"))
}

fn operation(root: &str) -> &'static str {
    if has_operation(root, "rebase-merge") || has_operation(root, "rebase-apply") {
        "rebase"
    } else if has_operation(root, "MERGE_HEAD") {
        "merge"
    } else if has_operation(root, "CHERRY_PICK_HEAD") {
        "cherryPick"
    } else if has_operation(root, "REVERT_HEAD") {
        "revert"
    } else {
        "none"
    }
}
fn operation_state(root: &str) -> Result<Value, String> {
    let snapshot = status(root)?;
    Ok(
        json!({"operation":operation(root),"fingerprint":snapshot["fingerprint"],"conflicts":conflicts(root)?}),
    )
}
fn reviewed_root(root: &str, params: &Value) -> Result<String, String> {
    let snapshot = status(root)?;
    if snapshot["fingerprint"] != string(params, "fingerprint")? {
        return Err("Repository changed; review the operation again".into());
    }
    Ok(string(&snapshot, "root")?.to_owned())
}
fn action(root: &str, args: &[&str], allow_conflicts: bool) -> Result<Value, String> {
    let output = run(root, args)?;
    let conflicts = conflicts(root)?;
    if !(output.status.success()
        || allow_conflicts && conflicts.as_array().is_some_and(|items| !items.is_empty()))
    {
        return Err(output_error(&output));
    }
    Ok(json!({"snapshot":status(root)?,"output":output_error(&output),"conflicts":conflicts}))
}
fn integration_action(root: &str, params: &Value, abort: bool) -> Result<Value, String> {
    let root = reviewed_root(root, params)?;
    let operation = operation(&root);
    if operation == "none" {
        return Err("No integration operation is in progress".into());
    }
    if !abort && !conflicts(&root)?.as_array().is_some_and(Vec::is_empty) {
        return Err("Resolve all conflicts before continuing".into());
    }
    let command = match operation {
        "cherryPick" => "cherry-pick",
        other => other,
    };
    if !abort && operation == "merge" {
        if let Some(message) = params["message"].as_str() {
            if message.trim().is_empty() {
                return Err("Commit message cannot be empty".into());
            }
            return action(&root, &["commit", "-m", message], false);
        }
    }
    action(
        &root,
        &[command, if abort { "--abort" } else { "--continue" }],
        !abort,
    )
}
fn resolve_commit(root: &str, reference: &str) -> Result<String, String> {
    if reference.is_empty() {
        return Err("A commit or branch is required".into());
    }
    Ok(git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )?
    .trim()
    .to_owned())
}
fn branches(root: &str) -> Result<Value, String> {
    let current = git(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_owned();
    let rows = git(root, &[
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(subject)",
        "refs/heads", "refs/remotes",
    ])?;
    let mut branches: Vec<_> = rows.lines().filter_map(|row| {
        let fields: Vec<_> = row.splitn(5, '\0').collect();
        if fields.len()!=5 { return None; }
        let remote = fields[0].starts_with("refs/remotes/");
        let short = |reference: &str| reference.trim_start_matches("refs/remotes/").trim_start_matches("refs/heads/").to_owned();
        let known = !fields[2].is_empty() && !fields[3].contains("gone");
        let count = |prefix: &str| fields[3].split(", ").find_map(|value| value.strip_prefix(prefix).and_then(|value|value.parse::<u64>().ok())).unwrap_or(0);
        Some(json!({"name":short(fields[0]),"remote":remote,"current":!remote&&short(fields[0])==current,"upstream":short(fields[2]),"upstreamRef":fields[2],"subject":fields[4],"oid":fields[1],"behind":known.then(||count("behind ")),"ahead":known.then(||count("ahead "))}))
    }).collect();
    // An explicitly fetched origin ref can exist outside a single-branch clone's
    // configured fetch mapping. Honor its configured upstream without rewriting config.
    let config = git(
        root,
        &[
            "config",
            "--null",
            "--get-regexp",
            r"^branch\..*\.(remote|merge)$",
        ],
    )
    .unwrap_or_default();
    let mut tracking: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for entry in config.split('\0') {
        if let Some((key, value)) = entry.split_once('\n') {
            if let Some((name, field)) = key
                .strip_prefix("branch.")
                .and_then(|key| key.rsplit_once('.'))
            {
                tracking
                    .entry(name.to_owned())
                    .or_default()
                    .insert(field.to_owned(), value.to_owned());
            }
        }
    }
    let remote_oids: BTreeMap<String, String> = branches
        .iter()
        .filter(|b| b["remote"] == true)
        .filter_map(|b| {
            Some((
                format!("refs/remotes/{}", b["name"].as_str()?),
                b["oid"].as_str()?.to_owned(),
            ))
        })
        .collect();
    for branch in &mut branches {
        if branch["remote"] != false || !branch["upstream"].as_str().unwrap_or_default().is_empty()
        {
            continue;
        }
        let Some(settings) = tracking.get(branch["name"].as_str().unwrap_or_default()) else {
            continue;
        };
        if settings.get("remote").map(String::as_str) != Some("origin") {
            continue;
        }
        let Some(name) = settings
            .get("merge")
            .and_then(|r| r.strip_prefix("refs/heads/"))
        else {
            continue;
        };
        let reference = format!("refs/remotes/origin/{name}");
        let Some(oid) = remote_oids.get(&reference) else {
            continue;
        };
        let counts = git(
            root,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{}...{oid}", branch["oid"].as_str().unwrap_or_default()),
                "--",
            ],
        )?;
        let counts: Vec<u64> = counts
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if let [ahead, behind] = counts.as_slice() {
            branch["upstream"] = json!(format!("origin/{name}"));
            branch["upstreamRef"] = json!(reference);
            branch["ahead"] = json!(ahead);
            branch["behind"] = json!(behind);
        }
    }
    let incoming: BTreeMap<String, u64> = branches
        .iter()
        .filter(|b| b["remote"] == false)
        .filter_map(|b| Some((b["upstreamRef"].as_str()?.to_owned(), b["behind"].as_u64()?)))
        .fold(BTreeMap::new(), |mut map, (name, count)| {
            let entry = map.entry(name).or_default();
            *entry = (*entry).max(count);
            map
        });
    for branch in &mut branches {
        if branch["remote"] == true {
            branch["behind"] = incoming
                .get(&format!(
                    "refs/remotes/{}",
                    branch["name"].as_str().unwrap_or_default()
                ))
                .map_or(Value::Null, |count| json!(count));
        }
    }
    Ok(json!({"current":current,"branches":branches}))
}
fn log(root: &str, params: &Value) -> Result<Value, String> {
    let limit = params["limit"]
        .as_u64()
        .unwrap_or(50)
        .clamp(1, 500)
        .to_string();
    let reference = resolve_commit(root, params["ref"].as_str().unwrap_or("HEAD"))?;
    let output = git(
        root,
        &[
            "log",
            &format!("--max-count={limit}"),
            "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00",
            &reference,
            "--",
        ],
    )?;
    let fields: Vec<_> = output.split('\0').collect();
    let commits: Vec<_> = fields.chunks(5).filter(|row|row.len()==5).map(|row| json!({"id":row[0].trim(),"parents":row[1].split_whitespace().collect::<Vec<_>>(),"author":row[2],"date":row[3],"subject":row[4]})).collect();
    Ok(json!(commits))
}
fn blame(root: &str, params: &Value) -> Result<Value, String> {
    let path = string(params, "path")?;
    path_arg(path)?;
    let reference = params["ref"]
        .as_str()
        .map(|reference| resolve_commit(root, reference))
        .transpose()?;
    let mut args = vec!["blame", "--line-porcelain", "--encoding=UTF-8"];
    if let Some(reference) = reference.as_deref() {
        args.push(reference);
    }
    args.extend(["--", path]);
    let output = git(root, &args)?;
    let mut rows = Vec::new();
    let (mut commit, mut author, mut original, mut line) =
        (String::new(), String::new(), 0_u64, 0_u64);
    let (mut time, mut summary) = (0_i64, String::new());
    for value in output.lines() {
        if let Some(text) = value.strip_prefix('\t') {
            rows.push(json!({"line":line,"commit":commit,"author":author,"authorTime":time,"summary":summary,"originalLine":original,"text":text}));
        } else if let Some(name) = value.strip_prefix("author ") {
            author = name.into();
        } else if let Some(seconds) = value.strip_prefix("author-time ") {
            time = seconds.parse().map_err(|_| "Invalid blame author time")?;
        } else if let Some(text) = value.strip_prefix("summary ") {
            summary = text.into();
        } else {
            let fields: Vec<_> = value.split(' ').collect();
            if fields.len() >= 3
                && (fields[0].len() == 40 || fields[0].len() == 64)
                && fields[0].bytes().all(|b| b.is_ascii_hexdigit())
            {
                commit = fields[0].into();
                original = fields[1]
                    .parse()
                    .map_err(|_| "Invalid blame original line")?;
                line = fields[2].parse().map_err(|_| "Invalid blame line")?;
            }
        }
    }
    Ok(json!(rows))
}
fn stashes(root: &str) -> Result<Value, String> {
    let output = git(root, &["stash", "list", "--format=%gd%x00%H%x00%gs"])?;
    Ok(json!(output
        .lines()
        .filter_map(|row| {
            let fields: Vec<_> = row.splitn(3, '\0').collect();
            if fields.len() == 3 {
                Some(json!({"ref":fields[0],"id":fields[1],"subject":fields[2]}))
            } else {
                None
            }
        })
        .collect::<Vec<_>>()))
}
fn current_branch(root: &str) -> Result<String, String> {
    git(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|name| name.trim().to_owned())
        .map_err(|_| "Check out a branch first; HEAD is detached".to_owned())
}
fn local_branch(root: &str, name: &str) -> Result<(), String> {
    git(root, &["check-ref-format", "--branch", name])?;
    git(
        root,
        &["show-ref", "--verify", &format!("refs/heads/{name}")],
    )
    .map(|_| ())
    .map_err(|_| format!("{name} is not a local branch"))
}
/// Returns `(remote, branch)` for the branch's configured upstream.
fn upstream(root: &str, branch: &str) -> Option<(String, String)> {
    let full = git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )
    .ok()?;
    let full = full.trim();
    let remotes = git(root, &["remote"]).ok()?;
    let remote = remotes
        .lines()
        .find(|remote| full.starts_with(&format!("{remote}/")))?;
    Some((remote.to_owned(), full[remote.len() + 1..].to_owned()))
}
fn switch_to(root: &str, branch: &str, remote: bool) -> Result<Value, String> {
    git(root, &["check-ref-format", "--branch", branch])?;
    if remote {
        git(
            root,
            &["show-ref", "--verify", &format!("refs/remotes/{branch}")],
        )
        .map_err(|_| format!("{branch} is not a remote branch"))?;
        // Creates a local tracking branch; Git refuses if one with that name already exists.
        action(root, &["switch", "--track", branch], false)
    } else {
        local_branch(root, branch)?;
        action(root, &["switch", "--", branch], false)
    }
}
fn compare_branch(root: &str, params: &Value) -> Result<Value, String> {
    let branch = string(params, "branch")?;
    let target = resolve_commit(root, branch)?;
    let working_tree = params["mode"].as_str() == Some("workingTree");
    let current = current_branch(root).unwrap_or_else(|_| "HEAD".into());
    let head = resolve_commit(root, "HEAD")?;
    let diff = if working_tree {
        git(
            root,
            &["diff", "--name-status", "--no-renames", "-z", &target, "--"],
        )?
    } else {
        git(
            root,
            &[
                "diff",
                "--name-status",
                "--no-renames",
                "-z",
                &head,
                &target,
                "--",
            ],
        )?
    };
    let tokens: Vec<_> = diff.split('\0').filter(|part| !part.is_empty()).collect();
    let files: Vec<_> = tokens
        .chunks(2)
        .filter(|pair| pair.len() == 2)
        .map(|pair| json!({"status":pair[0],"path":pair[1]}))
        .collect();
    let commits = |range: String| -> Result<Vec<Value>, String> {
        Ok(git(
            root,
            &["log", "--max-count=100", "--format=%H%x1f%s", &range, "--"],
        )?
        .lines()
        .filter_map(|line| line.split_once('\x1f'))
        .map(|(id, subject)| json!({"id":id,"subject":subject}))
        .collect())
    };
    let (incoming, outgoing) = if working_tree {
        (Vec::new(), Vec::new())
    } else {
        (
            commits(format!("{head}..{target}"))?,
            commits(format!("{target}..{head}"))?,
        )
    };
    Ok(json!({
        "current": current,
        "branch": branch,
        "mode": if working_tree { "workingTree" } else { "branch" },
        "files": files,
        "incoming": incoming,
        "outgoing": outgoing,
    }))
}
/// One file of a branch-vs-working-tree comparison, with the whole file as context so the
/// viewer can show both full versions side by side.
fn compare_file(root: &str, params: &Value) -> Result<Value, String> {
    let branch = string(params, "branch")?;
    let path = string(params, "path")?;
    path_arg(path)?;
    let root = repo_root(root)?;
    let snapshot = status(&root)?;
    let target = resolve_commit(&root, branch)?;
    let entry = tree_entry(&root, &target, path)?;
    let before = if let Some(entry) = entry.as_ref() {
        checkout_blob(&root, path, entry)?
    } else {
        Vec::new()
    };
    let revision = params["revision"]
        .as_str()
        .map(|rev| resolve_commit(&root, rev))
        .transpose()?;
    let after_entry = revision
        .as_ref()
        .map(|rev| tree_entry(&root, rev, path))
        .transpose()?
        .flatten();
    let after = if revision.is_some() {
        if let Some(entry) = after_entry.as_ref() {
            checkout_blob(&root, path, entry)?
        } else {
            Vec::new()
        }
    } else {
        worktree_bytes(&root, path)?
    };
    let special = [entry.as_ref(), after_entry.as_ref()]
        .into_iter()
        .flatten()
        .any(|e| !matches!(e.mode.as_str(), "100644" | "100755"));
    let special =
        special || fs::symlink_metadata(safe_path(&root, path)?).is_ok_and(|m| !m.is_file());
    let is_binary = special || binary(&before) || binary(&after);
    let patch = if is_binary {
        String::new()
    } else {
        text_patch(&before, &after)?
    };
    let hunks = if is_binary {
        Vec::new()
    } else {
        let lines = |bytes: &[u8]| bytes.iter().filter(|b| **b == b'\n').count() + 1;
        parse_hunks(&patch_with_context(
            &before,
            &after,
            lines(&before).max(lines(&after)),
        )?)?
    };
    if status(&root)?["fingerprint"] != snapshot["fingerprint"] {
        return Err("Repository changed while reading the diff; refresh and review again".into());
    }
    let fingerprint = hash(
        format!(
            "{}:{target}:{}",
            snapshot["fingerprint"],
            revision.as_deref().unwrap_or("")
        )
        .as_bytes(),
    );
    Ok(
        json!({"branch":branch,"base":target,"revision":revision,"path":path,"binary":is_binary,"kind":if is_binary {"binary"} else {"text"},"partialAllowed":!is_binary,"before":String::from_utf8_lossy(&before),"after":String::from_utf8_lossy(&after),"patch":patch,"hunks":hunks,"fingerprint":fingerprint}),
    )
}
/// Restore reviewed text changes, retaining unrelated staged and working content.
fn revert_diff(root: &str, params: &Value) -> Result<Value, String> {
    let root = repo_root(root)?;
    let path = string(params, "path")?;
    let full = safe_path(&root, path)?;
    let mut lock = IndexLock::acquire(&root)?;
    let comparison = params["base"].as_str();
    let preview = if let Some(base) = comparison {
        compare_file(
            &root,
            &json!({"branch":base,"revision":params["revision"],"path":path}),
        )?
    } else {
        diff(&root, path)?
    };
    if preview["fingerprint"] != params["fingerprint"] {
        return Err("Diff is stale; refresh and review the changes again".into());
    }
    if preview["kind"] != "text" || !preview["partialAllowed"].as_bool().unwrap_or(false) {
        return Err(
            "Revert requires an ordinary UTF-8 text file without renames or conflicts".into(),
        );
    }
    if index_entries(&root, Some(path), None)?
        .iter()
        .any(|(_, entry)| entry.stage > 0)
    {
        return Err("Resolve file conflicts before reverting".into());
    }
    let before = string(&preview, "before")?.as_bytes();
    let after = string(&preview, "after")?.as_bytes();
    if std::str::from_utf8(&worktree_bytes(&root, path)?).is_err() {
        return Err("Revert requires UTF-8 text".into());
    }
    let ids = params
        .get("changeIds")
        .map(|value| {
            serde_json::from_value::<Vec<String>>(value.clone()).map_err(|e| e.to_string())
        })
        .transpose()?;
    let target = if let Some(ids) = &ids {
        // Validate every requested ID before taking the complement.
        selected_content(&preview, ids)?;
        let remaining: Vec<String> = preview["hunks"]
            .as_array()
            .ok_or("Missing hunks")?
            .iter()
            .flat_map(|h| h["lines"].as_array().into_iter().flatten())
            .filter(|line| line["kind"] != "context")
            .filter_map(|line| line["id"].as_str())
            .filter(|id| !ids.iter().any(|chosen| chosen == id))
            .map(str::to_owned)
            .collect();
        if remaining.is_empty() {
            before.to_vec()
        } else {
            selected_content(&preview, &remaining)?
        }
    } else {
        before.to_vec()
    };
    let make_entry = |bytes: &[u8]| -> Result<Entry, String> {
        Ok(Entry {
            mode: "100644".into(),
            oid: write_raw_blob(&root, bytes)?,
            stage: 0,
        })
    };
    let base_entry = make_entry(after)?;
    let target_entry = make_entry(&target)?;
    let current = worktree_bytes(&root, path)?;
    let working = if params["revision"].is_string() {
        merge_staged(
            &root,
            Some(&make_entry(&current)?),
            Some(&base_entry),
            &target_entry,
        )
        .map_err(|_| "Outgoing changes overlap local edits; resolve them in the editor first")?
    } else {
        target.clone()
    };
    let head = head_entry(&root, path)?;
    let original_entry = if let Some(base) = comparison {
        tree_entry(&root, base, path)?
    } else {
        head.clone()
    };
    let working = if ids.is_none() && params["revision"].is_null() {
        if let Some(entry) = original_entry.as_ref() {
            checkout_blob(&root, path, entry)?
        } else {
            working
        }
    } else {
        working
    };
    let remove = working.is_empty() && original_entry.is_none();
    let index = temporary_index(&root, true)?;
    if comparison.is_none() {
        let staged = index_entries(&root, Some(path), None)?
            .into_iter()
            .next()
            .map(|(_, e)| e);
        if ids.is_none() {
            set_entry(&root, &index, path, head.as_ref())?;
        } else {
            let staged_bytes = blob(&root, staged.as_ref())?;
            let merged = if staged_bytes == before {
                staged_bytes
            } else {
                merge_staged(&root, staged.as_ref(), Some(&base_entry), &target_entry)
                    .map_err(|_| "Revert overlaps different staged content; unstage that change and review again")?
            };
            let mut entry = make_entry(&merged)?;
            entry.mode = staged
                .as_ref()
                .map(|e| e.mode.clone())
                .unwrap_or_else(|| "100644".into());
            set_entry(
                &root,
                &index,
                path,
                if merged.is_empty() && head.is_none() {
                    None
                } else {
                    Some(&entry)
                },
            )?;
        }
    }
    lock.prepare(&index)?;
    let reviewed = if let Some(base) = comparison {
        compare_file(
            &root,
            &json!({"branch":base,"revision":params["revision"],"path":path}),
        )?
    } else {
        diff(&root, path)?
    };
    if reviewed["fingerprint"] != params["fingerprint"] {
        return Err("Repository changed while preparing revert; review again".into());
    }
    if remove {
        if full.exists() {
            fs::remove_file(&full).map_err(|e| e.to_string())?;
        }
    } else {
        let parent = full.parent().ok_or("Missing parent directory")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&working).map_err(|e| e.to_string())?;
        if let Ok(metadata) = fs::metadata(&full) {
            temp.as_file()
                .set_permissions(metadata.permissions())
                .map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        if ids.is_none() {
            use std::os::unix::fs::PermissionsExt;
            if let Some(entry) = original_entry.as_ref() {
                temp.as_file()
                    .set_permissions(fs::Permissions::from_mode(if entry.mode == "100755" {
                        0o755
                    } else {
                        0o644
                    }))
                    .map_err(|e| e.to_string())?;
            }
        }
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&full).map_err(|e| e.to_string())?;
    }
    lock.install()?;
    status(&root)
}

/// Capture committed changes, never infer update counts from localized Git output.
fn updated_branch(
    root: &str,
    branch: &str,
    before: &str,
    incoming: &str,
    mut result: Value,
) -> Result<Value, String> {
    let after = resolve_commit(root, branch)?;
    let range = format!("{before}..{incoming}");
    let count = git(root, &["rev-list", "--count", &range, "--"])?;
    let commits = git(
        root,
        &[
            "log",
            "--max-count=500",
            "--format=%H%x00%s%x00%an%x00",
            &range,
            "--",
        ],
    )?;
    let fields: Vec<_> = commits.split('\0').collect();
    let commits: Vec<_> = fields
        .chunks(3)
        .filter(|row| row.len() == 3)
        .map(|row| json!({"id":row[0].trim(),"subject":row[1],"author":row[2]}))
        .collect();
    let files = git(root, &["diff", "--name-only", "-z", before, &after, "--"])?;
    result["update"] = json!({
        "branch":branch,"before":before,"after":after,
        "fileCount":files.split('\0').filter(|path| !path.is_empty()).count(),
        "commitCount":count.trim().parse::<u64>().map_err(|e| e.to_string())?,
        "commits":commits,
    });
    Ok(result)
}
fn pull_current(root: &str, strategy: &str) -> Result<Value, String> {
    let flags: &[&str] = match strategy {
        "merge" => &["pull", "--no-rebase", "--ff", "--no-edit"],
        // Put --ff before --rebase to override pull.ff=only for an explicit rebase.
        "rebase" => &["pull", "--ff", "--rebase"],
        "ff-only" => &["pull", "--ff-only"],
        _ => return Err("Unknown update strategy".into()),
    };
    if operation(root) != "none" {
        return Err("Finish the current integration operation first".into());
    }
    let branch = current_branch(root)?;
    upstream(root, &branch)
        .ok_or("Current branch has no remote upstream; configure tracking before updating")?;
    let before = resolve_commit(root, "HEAD")?;
    let result = action(root, flags, false)?;
    let incoming = resolve_commit(root, "FETCH_HEAD")?;
    updated_branch(root, &branch, &before, &incoming, result)
}

fn daily_action(root: &str, method: &str, params: &Value) -> Result<Value, String> {
    let root = reviewed_root(root, params)?;
    match method {
        "git.switchBranch" => switch_to(
            &root,
            string(params, "branch")?,
            params["remote"].as_bool().unwrap_or(false),
        ),
        "git.checkoutRebase" => {
            if operation(&root) != "none" {
                return Err("Finish the current integration operation first".into());
            }
            let previous = current_branch(&root)?;
            switch_to(
                &root,
                string(params, "branch")?,
                params["remote"].as_bool().unwrap_or(false),
            )?;
            action(&root, &["rebase", &previous], true)
        }
        "git.deleteBranch" => {
            let branch = string(params, "branch")?;
            local_branch(&root, branch)?;
            if branch == current_branch(&root).unwrap_or_default() {
                return Err("The checked-out branch cannot be deleted".into());
            }
            let flag = if params["force"].as_bool().unwrap_or(false) {
                "-D"
            } else {
                "-d"
            };
            action(&root, &["branch", flag, "--", branch], false)
        }
        "git.renameBranch" => {
            let branch = string(params, "branch")?;
            let name = string(params, "newName")?;
            local_branch(&root, branch)?;
            git(&root, &["check-ref-format", "--branch", name])?;
            action(&root, &["branch", "-m", "--", branch, name], false)
        }
        "git.updateBranch" => {
            let branch = string(params, "branch")?;
            local_branch(&root, branch)?;
            let (remote, name) = upstream(&root, branch)
                .ok_or_else(|| format!("{branch} has no upstream branch to update from"))?;
            if branch == current_branch(&root).unwrap_or_default() {
                pull_current(&root, "ff-only")
            } else {
                let before = resolve_commit(&root, branch)?;
                // Without a leading '+', Git only accepts a fast-forward of the local branch.
                let result = action(
                    &root,
                    &["fetch", "--", &remote, &format!("{name}:{branch}")],
                    false,
                )?;
                let incoming = resolve_commit(&root, branch)?;
                updated_branch(&root, branch, &before, &incoming, result)
            }
        }
        "git.pushBranch" => {
            let branch = string(params, "branch")?;
            local_branch(&root, branch)?;
            match upstream(&root, branch) {
                Some((remote, name)) => action(
                    &root,
                    &["push", "--", &remote, &format!("{branch}:{name}")],
                    false,
                ),
                None => {
                    if !git(&root, &["remote"])?
                        .lines()
                        .any(|name| name == "origin")
                    {
                        return Err(format!(
                            "{branch} has no upstream and there is no origin remote"
                        ));
                    }
                    action(
                        &root,
                        &["push", "--set-upstream", "--", "origin", branch],
                        false,
                    )
                }
            }
        }
        "git.createBranch" => {
            let name = string(params, "name")?;
            git(&root, &["check-ref-format", "--branch", name])?;
            let start = resolve_commit(&root, params["startPoint"].as_str().unwrap_or("HEAD"))?;
            action(&root, &["switch", "-c", name, &start], false)
        }
        "git.fetch" => {
            let remotes = git(&root, &["remote"])?;
            let remote = params["remote"].as_str().unwrap_or("origin");
            if !remotes.lines().any(|name| name == remote) {
                return Err("Unknown Git remote".into());
            }
            action(&root, &["fetch", "--", remote], false)
        }
        "git.pull" => pull_current(&root, params["strategy"].as_str().unwrap_or("ff-only")),
        "git.merge" | "git.rebase" | "git.cherryPick" => {
            if operation(&root) != "none" {
                return Err("Finish the current integration operation first".into());
            }
            let reference = resolve_commit(
                &root,
                string(
                    params,
                    if method == "git.cherryPick" {
                        "commit"
                    } else {
                        "ref"
                    },
                )?,
            )?;
            let command = match method {
                "git.merge" => "merge",
                "git.rebase" => "rebase",
                _ => "cherry-pick",
            };
            action(&root, &[command, &reference], true)
        }
        "git.stashCreate" => {
            let message = params["message"].as_str().unwrap_or("Zwip stash");
            let mut args = vec!["stash", "push", "-m", message];
            if params["includeUntracked"].as_bool().unwrap_or(false) {
                args.push("--include-untracked");
            }
            action(&root, &args, false)
        }
        "git.stashApply" | "git.stashPop" | "git.stashDrop" => {
            let reference = string(params, "ref")?;
            if !stashes(&root)?
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["ref"] == reference))
            {
                return Err("Stash changed; refresh the stash list".into());
            }
            let command = match method {
                "git.stashApply" => "apply",
                "git.stashPop" => "pop",
                _ => "drop",
            };
            action(&root, &["stash", command, reference], command != "drop")
        }
        _ => Err(format!("Unsupported Git action: {method}")),
    }
}
pub fn dispatch(root: &str, data: &Path, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "git.status" => status(root),
        "git.diff" => diff(root, string(params, "path")?),
        "git.revertDiff" => revert_diff(root, params),
        "git.commit" => commit(
            root,
            &serde_json::from_value::<Vec<String>>(params["paths"].clone())
                .map_err(|e| e.to_string())?,
            string(params, "message")?,
            string(params, "fingerprint")?,
        ),
        "git.commitSelection" => commit_selection(
            root,
            &serde_json::from_value::<Vec<Selection>>(params["selections"].clone())
                .map_err(|e| e.to_string())?,
            string(params, "message")?,
            string(params, "fingerprint")?,
        ),
        "git.pushPlan" => push_plan(root),
        "git.push" => push(root, string(params, "fingerprint")?),
        "git.conflicts" => conflicts(root),
        "git.operationState" => operation_state(root),
        "git.continue" => integration_action(root, params, false),
        "git.abort" => integration_action(root, params, true),
        "git.branches" => branches(root),
        "git.log" => log(root, params),
        "git.blame" => blame(root, params),
        "git.stashes" => stashes(root),
        "git.compareBranch" => compare_branch(root, params),
        "git.compareFile" => compare_file(root, params),
        "git.switchBranch" | "git.createBranch" | "git.checkoutRebase" | "git.deleteBranch"
        | "git.renameBranch" | "git.updateBranch" | "git.pushBranch" | "git.fetch" | "git.pull"
        | "git.merge" | "git.rebase" | "git.cherryPick" | "git.stashCreate" | "git.stashApply"
        | "git.stashPop" | "git.stashDrop" => daily_action(root, method, params),
        "git.mergeOpen" => merge_open(root, string(params, "path")?),
        "git.mergeApply" => merge_apply(
            root,
            string(params, "path")?,
            string(params, "fingerprint")?,
            string(params, "resolution")?,
            params["result"].as_str(),
        ),
        "git.changelists" => changelists(root, data),
        "git.saveChangelist" => save_changelist(
            root,
            data,
            string(params, "id")?,
            string(params, "name")?,
            &serde_json::from_value::<Vec<String>>(params["paths"].clone())
                .map_err(|e| e.to_string())?,
            &params["selections"],
        ),
        "git.deleteChangelist" => {
            let id = string(params, "id")?;
            if id == "default" {
                return Err("The default changelist cannot be deleted".into());
            }
            changelist_db(data)?
                .execute(
                    "DELETE FROM changelists WHERE repo=?1 AND id=?2",
                    params![repo_root(root)?, id],
                )
                .map_err(|e| e.to_string())?;
            changelists(root, data)
        }
        _ => Err(format!("Unsupported Git operation: {method}")),
    }
}
