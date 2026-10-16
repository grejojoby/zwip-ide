//! Background origin refreshes never modify local branches, the index or worktree.
use super::{git, repo_root};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct State {
    marker: String,
    running: bool,
    queued: bool,
    cancel: Arc<AtomicBool>,
    last_fetched: Option<u64>,
    error: Option<String>,
    version: u64,
    unavailable: bool,
}
#[derive(Default)]
pub struct RemoteUpdates {
    states: Arc<Mutex<HashMap<String, State>>>,
    jobs: Arc<AtomicUsize>,
}
impl RemoteUpdates {
    pub fn snapshot(&self, workspace: &str, force: bool) -> Result<Value, String> {
        let root = repo_root(workspace)?;
        let origin = git(&root, &["remote", "get-url", "origin"]).ok();
        // Local refs detect external checkouts and branch updates. FETCH_HEAD detects
        // external pulls even when HEAD did not move. Our fetch never writes it.
        let refs = git(
            &root,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
            ],
        )?;
        let head = git(&root, &["symbolic-ref", "-q", "HEAD"]).unwrap_or_default();
        let fetch_head = super::git_path(&root, "FETCH_HEAD")?;
        let fetched = std::fs::metadata(fetch_head)
            .ok()
            .and_then(|m| m.modified().ok());
        let marker =
            crate::documents::hash(format!("{origin:?}\n{refs}\n{head}\n{fetched:?}").as_bytes());
        let mut states = self.states.lock().map_err(|e| e.to_string())?;
        let state = states.entry(root.clone()).or_default();
        let changed = state.marker != marker;
        state.marker = marker;
        if origin.is_none() {
            state.cancel.store(true, Ordering::Release);
            state.unavailable = true;
            state.running = false;
            state.queued = false;
            state.error = None;
        } else {
            state.unavailable = false;
            if changed || force {
                if state.running {
                    state.queued = true;
                } else {
                    state.running = true;
                    state.error = None;
                    state.version += 1;
                    state.cancel = Arc::new(AtomicBool::new(false));
                    let cancel = state.cancel.clone();
                    let states = self.states.clone();
                    let jobs = self.jobs.clone();
                    jobs.fetch_add(1, Ordering::AcqRel);
                    let root = root.clone();
                    std::thread::spawn(move || {
                        let _job = Job(jobs);
                        loop {
                            let result = fetch(&root, &cancel);
                            let Ok(mut map) = states.lock() else { return };
                            let Some(state) = map.get_mut(&root) else {
                                return;
                            };
                            if !Arc::ptr_eq(&cancel, &state.cancel) {
                                return;
                            }
                            state.version += 1;
                            if cancel.load(Ordering::Acquire) {
                                state.running = false;
                                state.queued = false;
                                return;
                            }
                            match result {
                                Ok(()) => {
                                    state.last_fetched = Some(
                                        SystemTime::now()
                                            .duration_since(UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_secs(),
                                    );
                                    state.error = None;
                                }
                                Err(error) => state.error = Some(error),
                            }
                            if state.queued {
                                state.queued = false;
                            } else {
                                state.running = false;
                                return;
                            }
                        }
                    });
                }
            }
        }
        let fetch = json!({
            "state": if state.unavailable { "unavailable" } else if state.running { "fetching" } else if state.error.is_some() { "failed" } else if state.last_fetched.is_some() { "ready" } else { "idle" },
            "lastFetched":state.last_fetched,"error":state.error,"version":state.version,
        });
        drop(states);
        let mut result = super::branches(&root)?;
        result["root"] = json!(root);
        result["fetch"] = fetch;
        Ok(result)
    }
    pub fn shutdown(&self) {
        if let Ok(states) = self.states.lock() {
            for state in states.values() {
                state.cancel.store(true, Ordering::Release);
            }
        }
        // Give the polling fetch jobs time to terminate their Git/SSH process groups
        // before application exit tears down Rust threads.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.jobs.load(Ordering::Acquire) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for RemoteUpdates {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Job(Arc<AtomicUsize>);
impl Drop for Job {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn fetch(root: &str, cancel: &AtomicBool) -> Result<(), String> {
    let mut command = Command::new("git");
    command
        .args([
            "-C",
            root,
            "fetch",
            "--prune",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "true")
        .env("SSH_ASKPASS", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start background Git fetch.".to_owned())?;
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::Acquire) || started.elapsed() >= Duration::from_secs(60) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("Background fetch stopped or timed out; showing last fetched refs.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Could not fetch origin; showing last fetched refs. Check connectivity and Git credentials.".into())
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Could not monitor background Git fetch.".into());
            }
        }
    }
}
