use ide_core::Core;
use serde_json::{json, Value};
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
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Core) {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    git(root.path(), &["init", "-b", "main"]);
    git(
        root.path(),
        &["config", "user.email", "fixture@example.test"],
    );
    git(root.path(), &["config", "user.name", "Fixture"]);
    git(root.path(), &["config", "commit.gpgsign", "false"]);
    fs::write(root.path().join("file.txt"), "base\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "base"]);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    (root, data, core)
}
fn action(core: &Core, method: &str, mut params: Value) -> Value {
    params["fingerprint"] = core.request("git.status", json!({})).unwrap()["fingerprint"].clone();
    core.request(method, params).unwrap()
}

#[test]
fn branches_history_blame_and_cherry_pick_use_reviewed_repository() {
    let (root, _data, core) = fixture();
    action(&core, "git.createBranch", json!({"name":"feature"}));
    fs::write(root.path().join("file.txt"), "feature\n").unwrap();
    git(root.path(), &["commit", "-am", "feature change"]);
    let history = core.request("git.log", json!({"limit":1})).unwrap();
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["subject"], "feature change");
    let feature = history[0]["id"].clone();
    let branches = core.request("git.branches", json!({})).unwrap();
    assert_eq!(branches["current"], "feature");
    assert!(branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == "main" && branch["remote"] == false));
    action(&core, "git.switchBranch", json!({"branch":"main"}));
    let before = core.request("git.status", json!({})).unwrap();
    let picked = action(&core, "git.cherryPick", json!({"commit":feature}));
    assert_eq!(picked["conflicts"], json!([]));
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "feature\n"
    );
    assert!(core
        .request(
            "git.switchBranch",
            json!({"branch":"feature","fingerprint":before["fingerprint"]})
        )
        .is_err());
    let blame = core
        .request("git.blame", json!({"path":"file.txt"}))
        .unwrap();
    assert_eq!(blame[0]["author"], "Fixture");
    assert_eq!(blame[0]["text"], "feature");
    assert_eq!(blame[0]["line"], 1);
    let current = core.request("git.status", json!({})).unwrap();
    assert!(core
        .request(
            "git.createBranch",
            json!({"name":"--detach","fingerprint":current["fingerprint"]})
        )
        .is_err());
    assert_eq!(
        git(root.path(), &["branch", "--show-current"]).trim(),
        "main"
    );
}

#[test]
fn stash_apply_pop_and_drop_use_current_ref_identity() {
    let (root, _data, core) = fixture();
    fs::write(root.path().join("file.txt"), "stashed\n").unwrap();
    fs::write(root.path().join("new.txt"), "new\n").unwrap();
    action(
        &core,
        "git.stashCreate",
        json!({"message":"first","includeUntracked":true}),
    );
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "base\n"
    );
    assert!(!root.path().join("new.txt").exists());
    let stashes = core.request("git.stashes", json!({})).unwrap();
    assert_eq!(stashes[0]["ref"], "stash@{0}");
    let first = stashes[0]["id"].clone();
    action(&core, "git.stashApply", json!({"ref":"stash@{0}"}));
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "stashed\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("new.txt")).unwrap(),
        "new\n"
    );
    action(
        &core,
        "git.stashCreate",
        json!({"message":"second","includeUntracked":true}),
    );
    let reviewed = core.request("git.status", json!({})).unwrap();
    git(root.path(), &["stash", "drop", "stash@{0}"]);
    assert!(core
        .request(
            "git.stashDrop",
            json!({"ref":"stash@{0}","fingerprint":reviewed["fingerprint"]})
        )
        .is_err());
    assert_eq!(
        core.request("git.stashes", json!({})).unwrap()[0]["id"],
        first
    );
    action(&core, "git.stashPop", json!({"ref":"stash@{0}"}));
    assert!(core
        .request("git.stashes", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    action(
        &core,
        "git.stashCreate",
        json!({"message":"drop","includeUntracked":true}),
    );
    action(&core, "git.stashDrop", json!({"ref":"stash@{0}"}));
    assert!(core
        .request("git.stashes", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

fn diverge(root: &Path) {
    git(root, &["checkout", "-b", "feature"]);
    fs::write(root.join("file.txt"), "feature\n").unwrap();
    git(root, &["commit", "-am", "feature"]);
    git(root, &["checkout", "main"]);
    fs::write(root.join("file.txt"), "main\n").unwrap();
    git(root, &["commit", "-am", "main"]);
}

#[test]
fn merge_conflicts_resolve_and_continue_as_two_parent_commit() {
    let (root, _data, core) = fixture();
    diverge(root.path());
    let result = action(&core, "git.merge", json!({"ref":"feature"}));
    assert_eq!(result["conflicts"], json!(["file.txt"]));
    let state = core.request("git.operationState", json!({})).unwrap();
    assert_eq!(state["operation"], "merge");
    assert!(core
        .request("git.continue", json!({"fingerprint":state["fingerprint"]}))
        .is_err());
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    core.request("git.mergeApply", json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"result","result":"resolved\n"})).unwrap();
    action(&core, "git.continue", json!({"message":"integrated"}));
    assert_eq!(
        core.request("git.operationState", json!({})).unwrap()["operation"],
        "none"
    );
    assert_eq!(
        git(root.path(), &["show", "-s", "--format=%P", "HEAD"])
            .split_whitespace()
            .count(),
        2
    );
    assert_eq!(git(root.path(), &["show", "HEAD:file.txt"]), "resolved\n");
}

#[test]
fn rebase_abort_rejects_stale_review_and_continue_finishes_resolution() {
    let (root, _data, core) = fixture();
    diverge(root.path());
    action(&core, "git.switchBranch", json!({"branch":"feature"}));
    let original = git(root.path(), &["rev-parse", "HEAD"]);
    let result = action(&core, "git.rebase", json!({"ref":"main"}));
    assert_eq!(result["conflicts"], json!(["file.txt"]));
    let state = core.request("git.operationState", json!({})).unwrap();
    assert_eq!(state["operation"], "rebase");
    fs::write(root.path().join("file.txt"), "in progress resolution\n").unwrap();
    assert!(core
        .request("git.abort", json!({"fingerprint":state["fingerprint"]}))
        .is_err());
    action(&core, "git.abort", json!({}));
    assert_eq!(git(root.path(), &["rev-parse", "HEAD"]), original);
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "feature\n"
    );
    action(&core, "git.rebase", json!({"ref":"main"}));
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    core.request(
        "git.mergeApply",
        json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"theirs"}),
    )
    .unwrap();
    action(&core, "git.continue", json!({}));
    assert_eq!(
        core.request("git.operationState", json!({})).unwrap()["operation"],
        "none"
    );
    assert_eq!(git(root.path(), &["show", "HEAD:file.txt"]), "feature\n");
    assert_eq!(
        git(root.path(), &["rev-parse", "HEAD^"]),
        git(root.path(), &["rev-parse", "main"])
    );
}

#[test]
fn fetch_then_fast_forward_pull_revalidates_updated_tracking_refs() {
    let (root, _data, core) = fixture();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    git(
        root.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(root.path(), &["push", "-u", "origin", "main"]);
    let other = tempfile::tempdir().unwrap();
    git(
        other.path(),
        &[
            "clone",
            "--branch",
            "main",
            remote.path().to_str().unwrap(),
            ".",
        ],
    );
    git(
        other.path(),
        &["config", "user.email", "other@example.test"],
    );
    git(other.path(), &["config", "user.name", "Other"]);
    git(other.path(), &["config", "commit.gpgsign", "false"]);
    fs::write(other.path().join("file.txt"), "upstream\n").unwrap();
    git(other.path(), &["commit", "-am", "upstream"]);
    git(other.path(), &["push"]);
    let before = core.request("git.status", json!({})).unwrap();
    action(&core, "git.fetch", json!({"remote":"origin"}));
    assert!(core
        .request("git.pull", json!({"fingerprint":before["fingerprint"]}))
        .is_err());
    action(&core, "git.pull", json!({}));
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "upstream\n"
    );
    assert_eq!(
        git(root.path(), &["rev-parse", "HEAD"]),
        git(other.path(), &["rev-parse", "HEAD"])
    );
}
