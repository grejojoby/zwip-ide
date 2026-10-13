#![cfg(unix)]

#[allow(dead_code)]
#[path = "../src/worker.rs"]
mod transport;

use ide_core::Core;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::Arc,
    time::{Duration, Instant},
};

fn script(directory: &std::path::Path, content: &str) -> std::path::PathBuf {
    let path = directory.join("worker.py");
    fs::write(&path, content).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

const NON_READING: &str = r#"#!/usr/bin/python3
import json,os,sys,time
message=json.loads(sys.stdin.readline())
print(json.dumps({'id':message['id'],'result':{'generation':message['params'].get('generation',1)}}),flush=True)
open('worker.pid','w').write(str(os.getpid()))
time.sleep(30)
"#;

#[test]
fn observational_probe_timeout_does_not_kill_a_busy_provider() {
    let root = tempfile::tempdir().unwrap();
    let path = script(
        root.path(),
        r#"#!/usr/bin/python3
import json,sys,time
for line in sys.stdin:
    message=json.loads(line)
    if message['method']=='workspace.status': time.sleep(0.2)
    if message['method']=='shutdown': break
    print(json.dumps({'id':message['id'],'result':message['method']}),flush=True)
"#,
    );
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    assert!(worker
        .probe("workspace.status", json!({}), Duration::from_millis(40))
        .is_err());
    assert!(worker.is_running());
    assert_eq!(
        worker
            .request_with_timeout("still-working", json!({}), Duration::from_secs(2))
            .unwrap(),
        "still-working"
    );
    worker.wait_stopped();
}

#[test]
fn probe_waiting_for_another_frame_does_not_kill_its_sender() {
    let root = tempfile::tempdir().unwrap();
    let path = script(
        root.path(),
        r#"#!/usr/bin/python3
import json,sys,time
message=json.loads(sys.stdin.readline())
print(json.dumps({'id':message['id'],'result':True}),flush=True)
first=sys.stdin.read(1)
open('writing','w').write('ready')
time.sleep(0.25)
message=json.loads(first+sys.stdin.readline())
print(json.dumps({'id':message['id'],'result':'large-complete'}),flush=True)
for line in sys.stdin:
    message=json.loads(line)
    if message['method']=='shutdown': break
    print(json.dumps({'id':message['id'],'result':True}),flush=True)
"#,
    );
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    let sender = worker.clone();
    let first = std::thread::spawn(move || {
        sender.request_with_timeout(
            "large",
            json!({"content":"x".repeat(1024*1024)}),
            Duration::from_secs(2),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !root.path().join("writing").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(worker
        .probe("workspace.status", json!({}), Duration::from_millis(30))
        .is_err());
    assert!(
        worker.is_running(),
        "an unsent probe killed the active sender"
    );
    assert_eq!(first.join().unwrap().unwrap(), "large-complete");
    assert_eq!(worker.request("still-working", json!({})).unwrap(), true);
    worker.wait_stopped();
}

#[test]
fn a_partial_probe_frame_still_terminates_the_corrupted_stream() {
    let root = tempfile::tempdir().unwrap();
    let path = script(root.path(), NON_READING);
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    assert!(worker
        .probe(
            "workspace.status",
            json!({"padding":"x".repeat(1024*1024)}),
            Duration::from_millis(100)
        )
        .is_err());
    assert!(!worker.is_running());
    worker.wait_stopped();
}

#[test]
fn exited_worker_leader_does_not_leave_its_process_group_running() {
    for crash in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = script(
            root.path(),
            &format!(
                r#"#!/usr/bin/python3
import json,os,signal,subprocess,sys
child=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
open('descendant.pid','w').write(str(child.pid))
for line in sys.stdin:
    message=json.loads(line)
    if message['method']=='shutdown': break
    print(json.dumps({{'id':message['id'],'result':True}}),flush=True)
    if {crash}: os._exit(0)
"#,
                crash = if crash { "True" } else { "False" }
            ),
        );
        let worker = transport::Worker::spawn(
            &path,
            &[],
            root.path(),
            root.path().to_str().unwrap(),
            &root.path().join("cache"),
            &[],
        )
        .unwrap();
        worker.request("initialize", json!({})).unwrap();
        let pid: i32 = fs::read_to_string(root.path().join("descendant.pid"))
            .unwrap()
            .parse()
            .unwrap();
        worker.wait_stopped();
        let deadline = Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if unsafe { libc::kill(pid, 0) } == 0 {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
            panic!("descendant survived leader exit (crash={crash})");
        }
    }
}

#[test]
fn request_deadline_covers_a_full_stdin_pipe_and_rejects_later_writes() {
    let root = tempfile::tempdir().unwrap();
    let path = script(root.path(), NON_READING);
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &["ts".into()],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    // A watchdog keeps the unfixed implementation from hanging the test process.
    let pid = loop {
        if let Ok(pid) = fs::read_to_string(root.path().join("worker.pid")) {
            if let Ok(pid) = pid.parse::<i32>() {
                break pid;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let (done, watchdog) = std::sync::mpsc::channel::<()>();
    let guard = std::thread::spawn(move || {
        if watchdog.recv_timeout(Duration::from_secs(3)).is_err() {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    });
    let started = Instant::now();
    let result = worker.request_with_timeout(
        "document.update",
        json!({"content":"x".repeat(8 * 1024 * 1024)}),
        Duration::from_millis(150),
    );
    let elapsed = started.elapsed();
    let _ = done.send(());
    guard.join().unwrap();
    assert!(result.is_err());
    assert!(
        elapsed < Duration::from_secs(1),
        "deadline bypassed: {elapsed:?}"
    );
    assert!(!worker.is_running());
    assert!(worker
        .write(json!({"method":"after-partial-line"}))
        .is_err());
    let stopped = Instant::now();
    worker.stop();
    assert!(stopped.elapsed() < Duration::from_millis(100));
    let deadline = Instant::now() + Duration::from_secs(1);
    while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "worker was not reaped");
}

#[test]
fn a_waiter_deadline_also_covers_the_input_mutex() {
    let root = tempfile::tempdir().unwrap();
    let path = script(
        root.path(),
        &NON_READING.replace(
            "time.sleep(30)",
            "sys.stdin.read(1)\nopen('blocked','w').write('ready')\ntime.sleep(30)",
        ),
    );
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    let sender = worker.clone();
    let first = std::thread::spawn(move || {
        sender.request_with_timeout(
            "large",
            json!({"content":"x".repeat(8 * 1024 * 1024)}),
            Duration::from_secs(4),
        )
    });
    let waiting = Instant::now();
    while !root.path().join("blocked").exists() {
        assert!(
            waiting.elapsed() < Duration::from_secs(2),
            "large frame did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = Instant::now();
    assert!(worker
        .request_with_timeout("second", json!({}), Duration::from_millis(100))
        .is_err());
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(first.join().unwrap().is_err());
    assert!(!worker.is_running());
}

#[test]
fn response_timeout_does_not_wait_for_a_cancellation_write() {
    let root = tempfile::tempdir().unwrap();
    let path = script(root.path(), NON_READING);
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    worker.request("initialize", json!({})).unwrap();
    let started = Instant::now();
    let error = worker
        .request_with_timeout("ignored", json!({}), Duration::from_millis(100))
        .unwrap_err();
    assert!(error.contains("timed out"));
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(!worker.is_running());
}

#[test]
fn concurrent_rpc_frames_and_response_ids_stay_intact() {
    let root = tempfile::tempdir().unwrap();
    let path = script(
        root.path(),
        r#"#!/usr/bin/python3
import json,sys
for line in sys.stdin:
    message=json.loads(line)
    if message['method']=='shutdown': break
    print(json.dumps({'id':message['id'],'result':message['params']}),flush=True)
"#,
    );
    let worker = transport::Worker::spawn(
        &path,
        &[],
        root.path(),
        root.path().to_str().unwrap(),
        &root.path().join("cache"),
        &[],
    )
    .unwrap();
    let handles: Vec<_> = (0..16)
        .map(|index| {
            let worker = worker.clone();
            std::thread::spawn(move || {
                let params = json!({"index":index,"content":index.to_string().repeat(8192)});
                assert_eq!(
                    worker
                        .request_with_timeout("echo", params.clone(), Duration::from_secs(3))
                        .unwrap(),
                    params
                );
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    worker.stop();
}

#[test]
fn disabling_a_worker_with_a_blocked_overlay_preserves_the_unsaved_buffer() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    script(package.path(), NON_READING);
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    fs::write(package.path().join("manifest.json"), json!({
        "id":"web","name":"Transport fixture","description":"fixture","version":"0.1.0",
        "coreVersion":"^0.1.0","platform":platform,"architecture":architecture,
        "capabilities":["references"],"languages":["web"],"documentExtensions":["ts"],
        "executable":"worker.py","args":[],"checksums":{"worker.py":format!("{:x}",Sha256::digest(NON_READING))}
    }).to_string()).unwrap();
    fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
    let path = root.path().join("main.ts");
    let original = "export const value=1;";
    fs::write(&path, original).unwrap();
    let core = Arc::new(Core::new(data.path().to_owned()).unwrap());
    core.request("package.install", json!({"path":package.path()}))
        .unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    let document = core.request("document.open", json!({"path":path})).unwrap();
    let content = format!("{original}\n//{}", "x".repeat(8 * 1024 * 1024));
    let changed = core.request("document.change", json!({"path":path,"revision":document["revision"],"changes":[{"from":0,"to":original.len(),"insert":content}]})).unwrap();
    let provider = core.clone();
    let query = json!({"query":{"id":"blocked-navigation","path":path,"operation":"references","position":{"line":0,"character":13},"documentRevision":changed["revision"],"workspaceGeneration":workspace["generation"]}});
    let navigation = std::thread::spawn(move || provider.request("navigation.query", query));
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    core.request("navigation.cancel", json!({"id":"blocked-navigation"}))
        .unwrap();
    core.request("package.enable", json!({"id":"web","enabled":false}))
        .unwrap();
    let packages = core.request("package.list", json!({})).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(packages[0]["running"], false);
    let result = navigation.join().unwrap().unwrap();
    assert_ne!(result["state"], "complete");
    let retained = core.request("document.open", json!({"path":path})).unwrap();
    assert_eq!(retained["content"], content);
    assert_eq!(retained["dirty"], true);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    // Final shutdown also joins workers removed by an earlier runtime disable.
    core.shutdown();
    assert!(core
        .request("app.info", json!({}))
        .unwrap_err()
        .contains("shutting down"));
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let recovered = core.request("document.open", json!({"path":path})).unwrap();
    assert_eq!(recovered["content"], content);
    assert_eq!(recovered["dirty"], true);
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    fs::remove_file(root.path().join("worker.pid")).unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    let started = Instant::now();
    let pid = loop {
        if let Ok(text) = fs::read_to_string(root.path().join("worker.pid")) {
            if let Ok(pid) = text.parse::<i32>() {
                break pid;
            }
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_millis(5));
    };
    let stopped = Instant::now();
    core.shutdown();
    assert!(stopped.elapsed() < Duration::from_secs(2));
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "shutdown returned before worker death"
    );
    core.shutdown(); // Idempotent, including the Drop fallback.
}

#[test]
fn shutdown_prevents_a_late_worker_launch() {
    let root = tempfile::tempdir().unwrap();
    let path = script(root.path(), NON_READING);
    let supervisor = transport::Supervisor::default();
    supervisor.shutdown();
    let mut called = false;
    let result = supervisor.spawn(|| {
        called = true;
        transport::Worker::spawn(
            &path,
            &[],
            root.path(),
            root.path().to_str().unwrap(),
            &root.path().join("cache"),
            &[],
        )
    });
    assert!(result.is_err());
    assert!(!called);
}
