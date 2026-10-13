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
        "{:?}: {}",
        args,
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
    fs::write(
        root.path().join("file.txt"),
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    )
    .unwrap();
    fs::write(root.path().join("other.txt"), "other base\n").unwrap();
    git(root.path(), &["add", "."]);
    git(root.path(), &["commit", "-m", "base"]);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root": root.path()}))
        .unwrap();
    (root, data, core)
}
fn change_ids(diff: &Value, line_number: u64) -> Vec<String> {
    diff["hunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|hunk| hunk["lines"].as_array().unwrap())
        .filter(|line| {
            line["kind"] != "context"
                && (line["oldLine"].as_u64() == Some(line_number)
                    || line["newLine"].as_u64() == Some(line_number))
        })
        .map(|line| line["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn selected_lines_preserve_other_staged_and_unstaged_changes_in_same_file() {
    let (root, _data, core) = fixture();
    let base = fs::read_to_string(root.path().join("file.txt")).unwrap();
    fs::write(
        root.path().join("file.txt"),
        base.replace("six\n", "staged six\n"),
    )
    .unwrap();
    git(root.path(), &["add", "file.txt"]);
    let worktree = base
        .replace("one\n", "selected one\n")
        .replace("six\n", "staged six\n")
        .replace("ten\n", "unstaged ten\n");
    fs::write(root.path().join("file.txt"), &worktree).unwrap();
    fs::write(root.path().join("other.txt"), "other staged\n").unwrap();
    git(root.path(), &["add", "other.txt"]);
    let diff = core
        .request("git.diff", json!({"path":"file.txt"}))
        .unwrap();
    let ids = change_ids(&diff, 1);
    assert_eq!(ids.len(), 2);
    core.request("git.commitSelection", json!({"selections":[{"path":"file.txt","changeIds":ids}],"message":"selected lines","fingerprint":diff["fingerprint"]})).unwrap();
    assert_eq!(
        git(root.path(), &["show", "HEAD:file.txt"]),
        base.replace("one\n", "selected one\n")
    );
    assert_eq!(
        git(root.path(), &["show", ":file.txt"]),
        base.replace("one\n", "selected one\n")
            .replace("six\n", "staged six\n")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        worktree
    );
    assert_eq!(git(root.path(), &["show", ":other.txt"]), "other staged\n");
    assert_eq!(
        git(root.path(), &["show", "HEAD:other.txt"]),
        "other base\n"
    );
}

#[test]
fn conflicting_partial_selection_does_not_change_head_or_index() {
    let (root, _data, core) = fixture();
    let base = fs::read_to_string(root.path().join("file.txt")).unwrap();
    fs::write(
        root.path().join("file.txt"),
        base.replace("one\n", "staged version\n"),
    )
    .unwrap();
    git(root.path(), &["add", "file.txt"]);
    fs::write(
        root.path().join("file.txt"),
        base.replace("one\n", "different selected version\n"),
    )
    .unwrap();
    let head = git(root.path(), &["rev-parse", "HEAD"]);
    let index = git(root.path(), &["write-tree"]);
    let diff = core
        .request("git.diff", json!({"path":"file.txt"}))
        .unwrap();
    let result = core.request("git.commitSelection", json!({"selections":[{"path":"file.txt","changeIds":change_ids(&diff,1)}],"message":"partial","fingerprint":diff["fingerprint"]}));
    assert!(result.unwrap_err().contains("overlap"));
    assert_eq!(git(root.path(), &["rev-parse", "HEAD"]), head);
    assert_eq!(git(root.path(), &["write-tree"]), index);
}

#[test]
fn new_file_commit_and_hook_failure_preserve_unrelated_index() {
    let (root, _data, core) = fixture();
    fs::write(root.path().join("new.txt"), "new content\n").unwrap();
    fs::write(root.path().join("other.txt"), "other staged\n").unwrap();
    git(root.path(), &["add", "other.txt"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = root.path().join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\necho rejected-fixture >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let before = core.request("git.status", json!({})).unwrap();
        let error = core
            .request(
                "git.commit",
                json!({"paths":["new.txt"],"message":"new","fingerprint":before["fingerprint"]}),
            )
            .unwrap_err();
        assert!(error.contains("rejected-fixture"));
        assert_eq!(
            core.request("git.status", json!({})).unwrap()["fingerprint"],
            before["fingerprint"]
        );
        fs::remove_file(hook).unwrap();
    }
    let before = core.request("git.status", json!({})).unwrap();
    core.request(
        "git.commit",
        json!({"paths":["new.txt"],"message":"new","fingerprint":before["fingerprint"]}),
    )
    .unwrap();
    assert_eq!(git(root.path(), &["show", "HEAD:new.txt"]), "new content\n");
    assert_eq!(git(root.path(), &["show", ":other.txt"]), "other staged\n");
    assert_eq!(
        git(root.path(), &["show", "HEAD:other.txt"]),
        "other base\n"
    );
}

fn conflict(root: &Path, binary: bool) {
    git(root, &["checkout", "-b", "incoming"]);
    fs::write(
        root.join("file.txt"),
        if binary {
            b"incoming\0\n".as_slice()
        } else {
            b"incoming\n".as_slice()
        },
    )
    .unwrap();
    git(root, &["add", "file.txt"]);
    git(root, &["commit", "-m", "incoming"]);
    git(root, &["checkout", "main"]);
    fs::write(
        root.join("file.txt"),
        if binary {
            b"current\0\n".as_slice()
        } else {
            b"current\n".as_slice()
        },
    )
    .unwrap();
    git(root, &["add", "file.txt"]);
    git(root, &["commit", "-m", "current"]);
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["merge", "incoming"])
        .output()
        .unwrap();
    assert!(!output.status.success());
}

#[test]
fn text_merge_uses_real_stages_and_rejects_stale_resolution() {
    let (root, _data, core) = fixture();
    conflict(root.path(), false);
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    assert_eq!(session["ours"], "current\n");
    assert_eq!(session["theirs"], "incoming\n");
    assert_eq!(session["kind"], "text");
    assert_eq!(session["operation"], "merge");
    fs::write(root.path().join("file.txt"), "external edit\n").unwrap();
    assert!(core.request("git.mergeApply", json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"result","result":"resolved\n"})).is_err());
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "external edit\n"
    );
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    core.request("git.mergeApply", json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"result","result":"resolved\n"})).unwrap();
    assert_eq!(git(root.path(), &["show", ":file.txt"]), "resolved\n");
    assert!(git(root.path(), &["ls-files", "--unmerged"]).is_empty());
}

#[test]
fn binary_merge_requires_typed_side_selection() {
    let (root, _data, core) = fixture();
    conflict(root.path(), true);
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    assert_eq!(session["kind"], "binary");
    assert!(core.request("git.mergeApply", json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"result","result":"oops"})).is_err());
    core.request(
        "git.mergeApply",
        json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"theirs"}),
    )
    .unwrap();
    assert_eq!(
        fs::read(root.path().join("file.txt")).unwrap(),
        b"incoming\0\n"
    );
}

#[test]
fn changelists_persist_and_moving_paths_removes_old_membership() {
    let (root, data, core) = fixture();
    fs::write(root.path().join("file.txt"), "modified\n").unwrap();
    let lists = core
        .request(
            "git.saveChangelist",
            json!({"id":"","name":"Feature","paths":["file.txt"]}),
        )
        .unwrap();
    let id = lists
        .as_array()
        .unwrap()
        .iter()
        .find(|list| list["name"] == "Feature")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let lists = core.request("git.changelists", json!({})).unwrap();
    assert!(lists
        .as_array()
        .unwrap()
        .iter()
        .any(|list| list["id"] == id && list["paths"] == json!(["file.txt"])));
    let lists = core
        .request(
            "git.saveChangelist",
            json!({"id":"default","name":"Default","paths":["file.txt"]}),
        )
        .unwrap();
    assert!(lists
        .as_array()
        .unwrap()
        .iter()
        .find(|list| list["id"] == id)
        .unwrap()["paths"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn saved_line_assignments_are_marked_stale_after_changes() {
    let (root, _data, core) = fixture();
    fs::write(root.path().join("file.txt"), "selected\n").unwrap();
    let diff = core
        .request("git.diff", json!({"path":"file.txt"}))
        .unwrap();
    let lists = core.request("git.saveChangelist", json!({"id":"","name":"Partial","paths":[],"selections":[{"path":"file.txt","changeIds":["add:1"],"fingerprint":diff["fingerprint"]}]})).unwrap();
    assert_eq!(lists[1]["selections"][0]["stale"], false);
    fs::write(root.path().join("file.txt"), "later edit\n").unwrap();
    let lists = core.request("git.changelists", json!({})).unwrap();
    assert_eq!(lists[1]["selections"][0]["stale"], true);
}

#[test]
fn disjoint_lines_share_a_file_across_named_lists_and_default() {
    let (root, data, core) = fixture();
    let original = fs::read_to_string(root.path().join("file.txt")).unwrap();
    fs::write(
        root.path().join("file.txt"),
        original
            .replace("one\n", "first\n")
            .replace("ten\n", "last\n"),
    )
    .unwrap();
    let snapshot = core.request("git.status", json!({})).unwrap();
    let assign = |id: &str, ids: Value| {
        core.request("git.saveChangelist", json!({"id":id,"name":id,"paths":["file.txt"],"selections":[{"path":"file.txt","changeIds":ids,"fingerprint":snapshot["fingerprint"]}]}))
    };
    assign("first", json!(["remove:1", "add:1"])).unwrap();
    let lists = assign("last", json!(["add:10"])).unwrap();
    let list = |items: &Value, id: &str| {
        items
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        list(&lists, "first")["selections"][0]["changeIds"],
        json!(["remove:1", "add:1"])
    );
    assert_eq!(
        list(&lists, "last")["selections"][0]["changeIds"],
        json!(["add:10"])
    );
    assert_eq!(
        list(&lists, "default")["selections"][0]["changeIds"],
        json!(["remove:10"])
    );
    let before = core.request("git.status", json!({})).unwrap();
    assert!(assign("invalid", json!(["add:999"])).is_err());
    assert_eq!(
        core.request("git.status", json!({})).unwrap()["fingerprint"],
        before["fingerprint"]
    );
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    assert_eq!(core.request("git.changelists", json!({})).unwrap(), lists);
    // Moving a whole file is explicit and removes every other assignment.
    let whole = core
        .request(
            "git.saveChangelist",
            json!({"id":"whole","name":"whole","paths":["file.txt"]}),
        )
        .unwrap();
    assert!(list(&whole, "first")["paths"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(list(&whole, "last")["paths"].as_array().unwrap().is_empty());
    // A partial move out of the whole-file list preserves its remaining lines.
    let split = core.request("git.saveChangelist", json!({"id":"split","name":"split","paths":[],"selections":[{"path":"file.txt","changeIds":["add:1"],"fingerprint":snapshot["fingerprint"]}]})).unwrap();
    assert_eq!(
        list(&split, "whole")["selections"][0]["changeIds"],
        json!(["remove:1", "remove:10", "add:10"])
    );
    assert!(list(&split, "default")["paths"]
        .as_array()
        .unwrap()
        .is_empty());
    fs::write(root.path().join("file.txt"), "edited again\n").unwrap();
    let stale = core.request("git.changelists", json!({})).unwrap();
    assert_eq!(list(&stale, "split")["selections"][0]["stale"], true);
    assert_eq!(list(&stale, "default")["selections"][0]["stale"], true);
}

#[test]
fn signing_failure_keeps_real_index_and_head_unchanged() {
    let (root, _data, core) = fixture();
    fs::write(root.path().join("file.txt"), "selected\n").unwrap();
    fs::write(root.path().join("other.txt"), "other staged\n").unwrap();
    git(root.path(), &["add", "other.txt"]);
    git(root.path(), &["config", "commit.gpgsign", "true"]);
    git(
        root.path(),
        &["config", "gpg.program", "/nonexistent-zwip-fixture-gpg"],
    );
    git(root.path(), &["config", "gpg.format", "openpgp"]);
    let before = core.request("git.status", json!({})).unwrap();
    assert!(core
        .request(
            "git.commit",
            json!({"paths":["file.txt"],"message":"signed","fingerprint":before["fingerprint"]})
        )
        .is_err());
    assert_eq!(
        core.request("git.status", json!({})).unwrap()["fingerprint"],
        before["fingerprint"]
    );
    assert!(!root.path().join(".git/index.lock").exists());
}

#[test]
fn stale_push_review_never_pushes_later_commits() {
    let (root, _data, core) = fixture();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare"]);
    git(
        root.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(root.path(), &["push", "-u", "origin", "main"]);
    let initial = git(remote.path(), &["rev-parse", "refs/heads/main"]);
    fs::write(root.path().join("file.txt"), "first outgoing\n").unwrap();
    git(root.path(), &["commit", "-am", "first outgoing"]);
    let plan = core.request("git.pushPlan", json!({})).unwrap();
    assert_eq!(plan["commits"].as_array().unwrap().len(), 1);
    fs::write(root.path().join("file.txt"), "later outgoing\n").unwrap();
    git(root.path(), &["commit", "-am", "later outgoing"]);
    assert!(core
        .request("git.push", json!({"fingerprint":plan["fingerprint"]}))
        .unwrap_err()
        .contains("stale"));
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/heads/main"]),
        initial
    );
    let plan = core.request("git.pushPlan", json!({})).unwrap();
    core.request("git.push", json!({"fingerprint":plan["fingerprint"]}))
        .unwrap();
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/heads/main"]),
        git(root.path(), &["rev-parse", "HEAD"])
    );
}

#[test]
fn push_plan_checks_actual_push_url_not_fetch_url() {
    let (root, _data, core) = fixture();
    let fetch_remote = tempfile::tempdir().unwrap();
    let push_remote = tempfile::tempdir().unwrap();
    for remote in [&fetch_remote, &push_remote] {
        git(remote.path(), &["init", "--bare"]);
    }
    git(
        root.path(),
        &[
            "remote",
            "add",
            "origin",
            fetch_remote.path().to_str().unwrap(),
        ],
    );
    git(root.path(), &["push", "-u", "origin", "main"]);
    git(
        root.path(),
        &[
            "config",
            "remote.origin.pushurl",
            push_remote.path().to_str().unwrap(),
        ],
    );
    let plan = core.request("git.pushPlan", json!({}));
    assert!(plan.unwrap_err().contains("Remote branch changed"));
}

#[test]
fn modify_delete_merge_keeps_missing_side_distinct_from_empty_text() {
    let (root, _data, core) = fixture();
    git(root.path(), &["checkout", "-b", "incoming"]);
    git(root.path(), &["rm", "file.txt"]);
    git(root.path(), &["commit", "-m", "delete"]);
    git(root.path(), &["checkout", "main"]);
    fs::write(root.path().join("file.txt"), "modified\n").unwrap();
    git(root.path(), &["commit", "-am", "modify"]);
    let output = Command::new("git")
        .arg("-C")
        .arg(root.path())
        .args(["merge", "incoming"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    assert_eq!(session["conflictType"], "modifyDelete");
    assert_eq!(session["theirsDeleted"], true);
    assert!(session["theirs"].is_null());
    core.request(
        "git.mergeApply",
        json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"theirs"}),
    )
    .unwrap();
    assert!(!root.path().join("file.txt").exists());
    assert!(git(root.path(), &["ls-files", "--unmerged"]).is_empty());
}

#[test]
fn rebase_labels_match_git_stage_meanings() {
    let (root, _data, core) = fixture();
    git(root.path(), &["checkout", "-b", "feature"]);
    fs::write(root.path().join("file.txt"), "feature replay\n").unwrap();
    git(root.path(), &["commit", "-am", "feature"]);
    git(root.path(), &["checkout", "main"]);
    fs::write(root.path().join("file.txt"), "target main\n").unwrap();
    git(root.path(), &["commit", "-am", "main"]);
    git(root.path(), &["checkout", "feature"]);
    let output = Command::new("git")
        .arg("-C")
        .arg(root.path())
        .args(["rebase", "main"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    assert_eq!(session["operation"], "rebase");
    assert_eq!(session["ours"], "target main\n");
    assert_eq!(session["theirs"], "feature replay\n");
    assert!(session["labels"]["ours"]
        .as_str()
        .unwrap()
        .contains("rebased target"));
    assert!(session["labels"]["theirs"]
        .as_str()
        .unwrap()
        .contains("replayed"));
    for (side, reference) in [("ours", "HEAD"), ("theirs", "REBASE_HEAD")] {
        let revision = git(root.path(), &["rev-parse", "--short=12", reference]);
        assert!(session["labels"][side]
            .as_str()
            .unwrap()
            .contains(revision.trim()));
    }
}

#[test]
fn merge_side_checkout_preserves_repository_eol_filters() {
    let (root, _data, core) = fixture();
    fs::write(
        root.path().join(".gitattributes"),
        "file.txt text eol=crlf\n",
    )
    .unwrap();
    git(root.path(), &["add", ".gitattributes"]);
    git(root.path(), &["commit", "-m", "attributes"]);
    conflict(root.path(), false);
    let session = core
        .request("git.mergeOpen", json!({"path":"file.txt"}))
        .unwrap();
    core.request(
        "git.mergeApply",
        json!({"path":"file.txt","fingerprint":session["fingerprint"],"resolution":"theirs"}),
    )
    .unwrap();
    assert_eq!(
        fs::read(root.path().join("file.txt")).unwrap(),
        b"incoming\r\n"
    );
    assert_eq!(git(root.path(), &["show", ":file.txt"]), "incoming\n");
}

#[cfg(unix)]
#[test]
fn successful_format_hook_reconciles_selected_index_and_preserves_unrelated_staging() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _data, core) = fixture();
    fs::write(root.path().join("file.txt"), "selected change\n").unwrap();
    fs::write(root.path().join("other.txt"), "unrelated staged\n").unwrap();
    git(root.path(), &["add", "other.txt"]);
    let hook = root.path().join(".git/hooks/pre-commit");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf 'formatted by hook\\n' >> file.txt\ngit add -- file.txt\n",
    )
    .unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
    let before = core.request("git.status", json!({})).unwrap();
    core.request(
        "git.commit",
        json!({"paths":["file.txt"],"message":"formatted","fingerprint":before["fingerprint"]}),
    )
    .unwrap();
    let committed = git(root.path(), &["show", "HEAD:file.txt"]);
    assert_eq!(committed, "selected change\nformatted by hook\n");
    assert_eq!(
        git(root.path(), &["show", ":file.txt"]),
        committed,
        "Successful hook left a staged reverse change on the selected file"
    );
    assert_eq!(
        git(root.path(), &["show", ":other.txt"]),
        "unrelated staged\n"
    );
    assert_eq!(
        git(root.path(), &["show", "HEAD:other.txt"]),
        "other base\n"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        committed
    );
}

#[cfg(unix)]
#[test]
fn partial_commit_rebases_hook_edits_without_consuming_other_selected_file_changes() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _data, core) = fixture();
    let base = fs::read_to_string(root.path().join("file.txt")).unwrap();
    fs::write(
        root.path().join("file.txt"),
        base.replace("six\n", "staged six\n"),
    )
    .unwrap();
    git(root.path(), &["add", "file.txt"]);
    let working = base
        .replace("one\n", "selected one\n")
        .replace("six\n", "staged six\n")
        .replace("ten\n", "unstaged ten\n");
    fs::write(root.path().join("file.txt"), &working).unwrap();
    let hook = root.path().join(".git/hooks/pre-commit");
    fs::write(&hook,"#!/bin/sh\noid=$(git show :file.txt | sed 's/selected one/FORMATTED one/' | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,$oid,file.txt\n").unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
    let diff = core
        .request("git.diff", json!({"path":"file.txt"}))
        .unwrap();
    core.request("git.commitSelection",json!({"selections":[{"path":"file.txt","changeIds":change_ids(&diff,1)}],"message":"partial formatted","fingerprint":diff["fingerprint"]})).unwrap();
    assert_eq!(
        git(root.path(), &["show", "HEAD:file.txt"]),
        base.replace("one\n", "FORMATTED one\n")
    );
    assert_eq!(
        git(root.path(), &["show", ":file.txt"]),
        base.replace("one\n", "FORMATTED one\n")
            .replace("six\n", "staged six\n")
    );
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        working
    );
}

#[cfg(unix)]
#[test]
fn overlapping_hook_edit_reports_created_commit_and_keeps_original_staging_for_recovery() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _data, core) = fixture();
    let base = fs::read_to_string(root.path().join("file.txt")).unwrap();
    fs::write(
        root.path().join("file.txt"),
        base.replace("six\n", "staged six\n"),
    )
    .unwrap();
    git(root.path(), &["add", "file.txt"]);
    let before_index = git(root.path(), &["write-tree"]);
    let before_head = git(root.path(), &["rev-parse", "HEAD"]);
    let working = base
        .replace("one\n", "selected one\n")
        .replace("six\n", "staged six\n");
    fs::write(root.path().join("file.txt"), &working).unwrap();
    let hook = root.path().join(".git/hooks/pre-commit");
    fs::write(&hook,"#!/bin/sh\noid=$(git show :file.txt | sed 's/^six$/hook six/' | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,$oid,file.txt\n").unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
    let diff = core
        .request("git.diff", json!({"path":"file.txt"}))
        .unwrap();
    let error=core.request("git.commitSelection",json!({"selections":[{"path":"file.txt","changeIds":change_ids(&diff,1)}],"message":"hook overlap","fingerprint":diff["fingerprint"]})).unwrap_err();
    assert!(
        error.contains("was created")
            && error.contains("original staged index")
            && error.contains("Recovery indexes"),
        "{error}"
    );
    assert_ne!(git(root.path(), &["rev-parse", "HEAD"]), before_head);
    assert_eq!(git(root.path(), &["write-tree"]), before_index);
    assert_eq!(
        fs::read_to_string(root.path().join("file.txt")).unwrap(),
        working
    );
    assert_eq!(
        fs::read_dir(root.path().join(".git"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("zwip-index-"))
            .count(),
        2
    );
    assert!(!root.path().join(".git/index.lock").exists());
}
