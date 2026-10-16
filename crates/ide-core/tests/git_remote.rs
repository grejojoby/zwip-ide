#![cfg(unix)]
use ide_core::Core;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}
fn identity(root: &Path) {
    for (key, value) in [
        ("user.name", "Fixture"),
        ("user.email", "fixture@example.test"),
        ("commit.gpgsign", "false"),
    ] {
        git(root, &["config", key, value]);
    }
}
fn commit(root: &Path, file: &str) -> String {
    fs::write(root.join(file), file).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", file]);
    git(root, &["rev-parse", "HEAD"]).trim().to_owned()
}
struct Fixture {
    root: tempfile::TempDir,
    writer: tempfile::TempDir,
    _origin: tempfile::TempDir,
    _data: tempfile::TempDir,
    core: Core,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let origin = tempfile::tempdir().unwrap();
        let writer = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        git(origin.path(), &["init", "--bare", "-b", "main"]);
        git(root.path(), &["init", "-b", "main"]);
        identity(root.path());
        commit(root.path(), "base.txt");
        git(
            root.path(),
            &["remote", "add", "origin", origin.path().to_str().unwrap()],
        );
        git(root.path(), &["push", "-u", "origin", "main"]);
        git(root.path(), &["switch", "-c", "topic"]);
        git(root.path(), &["push", "-u", "origin", "topic"]);
        git(root.path(), &["switch", "main"]);
        git(
            writer.path(),
            &["clone", origin.path().to_str().unwrap(), "."],
        );
        identity(writer.path());
        let core = Core::new(data.path().to_owned()).unwrap();
        core.request("workspace.open", json!({"root":root.path()}))
            .unwrap();
        Self {
            root,
            writer,
            _origin: origin,
            _data: data,
            core,
        }
    }
    fn action(&self, method: &str, mut params: Value) -> Value {
        params["fingerprint"] =
            self.core.request("git.status", json!({})).unwrap()["fingerprint"].clone();
        self.core.request(method, params).unwrap()
    }
    fn advance(&self, branch: &str, file: &str) -> String {
        git(self.writer.path(), &["switch", branch]);
        let oid = commit(self.writer.path(), file);
        git(self.writer.path(), &["push", "origin", branch]);
        oid
    }
    fn wait_ref(&self, name: &str, expected: &str) {
        wait(|| git(self.root.path(), &["rev-parse", name]).trim() == expected);
    }
    fn ready(&self) -> Value {
        let mut status = Value::Null;
        wait(|| {
            status = self.core.request("git.remoteStatus", json!({})).unwrap();
            status["fetch"]["state"] != "fetching"
        });
        status
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "Background fetch did not finish");
        std::thread::sleep(Duration::from_millis(30));
    }
}
#[test]
fn checkout_fetches_all_origin_branches_even_with_a_narrow_refspec_and_coalesces_requests() {
    let f = Fixture::new();
    let expected = f.advance("topic", "incoming.txt");
    git(
        f.root.path(),
        &[
            "config",
            "remote.origin.fetch",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    let control = tempfile::tempdir().unwrap();
    let script = control.path().join("upload-pack");
    let started = control.path().join("started");
    let release = control.path().join("release");
    let calls = control.path().join("calls");
    fs::write(&script,format!("#!/bin/sh\nprintf x >> '{}'\ntouch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.05; done\nexec git-upload-pack \"$@\"\n",calls.display(),started.display(),release.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        f.root.path(),
        &[
            "config",
            "remote.origin.uploadpack",
            script.to_str().unwrap(),
        ],
    );
    let start = Instant::now();
    f.action("git.switchBranch", json!({"branch":"topic"}));
    assert!(start.elapsed() < Duration::from_secs(2));
    wait(|| started.exists());
    assert_eq!(fs::read_to_string(&calls).unwrap(), "x");
    f.action("git.switchBranch", json!({"branch":"main"}));
    f.action("git.switchBranch", json!({"branch":"topic"}));
    assert_eq!(
        f.core.request("git.remoteStatus", json!({})).unwrap()["fetch"]["state"],
        "fetching"
    );
    fs::write(&release, "").unwrap();
    f.wait_ref("origin/topic", &expected);
    let status = f.ready();
    assert_eq!(status["fetch"]["state"], "ready");
    assert_eq!(fs::read_to_string(&calls).unwrap(), "xx");
    assert_eq!(
        status["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "topic")
            .unwrap()["behind"],
        1
    );
}
#[test]
fn pull_refreshes_other_branches_and_status_observes_external_checkouts_and_pulls() {
    let f = Fixture::new();
    f.ready();
    let topic = f.advance("topic", "topic-update.txt");
    let main = f.advance("main", "main-update.txt");
    f.action("git.pull", json!({}));
    f.wait_ref("origin/topic", &topic);
    assert_eq!(git(f.root.path(), &["rev-parse", "HEAD"]).trim(), main);
    f.ready();
    let next = f.advance("main", "next.txt");
    git(f.root.path(), &["switch", "topic"]); // Terminal checkout, not a Core mutation.
    assert_eq!(
        f.core.request("git.remoteStatus", json!({})).unwrap()["fetch"]["state"],
        "fetching"
    );
    f.wait_ref("origin/main", &next);
    f.ready();
    let later = f.advance("main", "later.txt");
    // An up-to-date pull on another branch still writes FETCH_HEAD and must be observed.
    git(f.root.path(), &["pull", "--ff-only", "origin", "topic"]);
    f.core.request("git.remoteStatus", json!({})).unwrap();
    f.wait_ref("origin/main", &later);
    assert_eq!(f.ready()["fetch"]["state"], "ready");
}
#[test]
fn failed_fetch_keeps_cached_incoming_counts_and_a_repository_without_origin_is_quiet() {
    let f = Fixture::new();
    f.advance("main", "incoming.txt");
    let ready = f.ready();
    assert_eq!(ready["fetch"]["state"], "ready");
    git(
        f.root.path(),
        &["remote", "set-url", "origin", "/nonexistent-zwip-origin"],
    );
    f.core.request("git.refreshRemote", json!({})).unwrap();
    let failed = f.ready();
    assert_eq!(failed["fetch"]["state"], "failed");
    assert!(failed["fetch"]["error"]
        .as_str()
        .unwrap()
        .contains("last fetched"));
    assert_eq!(failed["branches"], ready["branches"]);
    git(f.root.path(), &["remote", "remove", "origin"]);
    assert_eq!(f.ready()["fetch"]["state"], "unavailable");
}
#[test]
fn shutdown_cancels_a_blocked_background_fetch() {
    let f = Fixture::new();
    let control = tempfile::tempdir().unwrap();
    let started = control.path().join("started");
    let script = control.path().join("upload-pack");
    fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\nsleep 60\n", started.display()),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    git(
        f.root.path(),
        &[
            "config",
            "remote.origin.uploadpack",
            script.to_str().unwrap(),
        ],
    );
    f.core.request("git.remoteStatus", json!({})).unwrap();
    wait(|| started.exists());
    let start = Instant::now();
    f.core.shutdown();
    assert!(start.elapsed() < Duration::from_secs(3));
}
