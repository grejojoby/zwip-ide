use ide_core::Core;
use serde_json::json;
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn setup() -> (tempfile::TempDir, tempfile::TempDir, Core) {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(
        root.path(),
        &["config", "user.email", "fixture@example.test"],
    );
    git(root.path(), &["config", "user.name", "Fixture"]);
    git(root.path(), &["config", "commit.gpgsign", "false"]);
    fs::write(root.path().join("selected.txt"), "before\n").unwrap();
    fs::write(root.path().join("unrelated.txt"), "base\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "initial"]);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    (root, data, core)
}
#[test]
fn selected_file_commit_preserves_unrelated_index_and_worktree() {
    let (root, _data, core) = setup();
    fs::write(root.path().join("selected.txt"), "selected edit\n").unwrap();
    fs::write(root.path().join("unrelated.txt"), "staged edit\n").unwrap();
    git(root.path(), &["add", "unrelated.txt"]);
    fs::write(root.path().join("unrelated.txt"), "unstaged edit\n").unwrap();
    let status = core.request("git.status", json!({})).unwrap();
    core.request("git.commit",json!({"paths":["selected.txt"],"message":"selected only","fingerprint":status["fingerprint"]})).unwrap();
    assert_eq!(
        git(root.path(), &["show", "HEAD:selected.txt"]),
        "selected edit\n"
    );
    assert_eq!(git(root.path(), &["show", "HEAD:unrelated.txt"]), "base\n");
    assert_eq!(
        git(root.path(), &["show", ":unrelated.txt"]),
        "staged edit\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("unrelated.txt")).unwrap(),
        "unstaged edit\n"
    );
}
#[test]
fn stale_commit_preview_rejects_changed_content() {
    let (root, _data, core) = setup();
    fs::write(root.path().join("selected.txt"), "first\n").unwrap();
    let status = core.request("git.status", json!({})).unwrap();
    fs::write(root.path().join("selected.txt"), "second\n").unwrap();
    let result = core.request(
        "git.commit",
        json!({"paths":["selected.txt"],"message":"stale","fingerprint":status["fingerprint"]}),
    );
    assert!(result.unwrap_err().contains("changed"));
    assert_eq!(git(root.path(), &["show", "HEAD:selected.txt"]), "before\n");
}
