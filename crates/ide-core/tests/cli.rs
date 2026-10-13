#![cfg(unix)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Cli {
    child: Child,
    input: Option<ChildStdin>,
    replies: mpsc::Receiver<Value>,
    buffered: HashMap<u64, Value>,
}
impl Cli {
    fn start(data: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zwip-core"))
            .env("ZWIP_DATA", data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let value = serde_json::from_str(&line.unwrap()).unwrap();
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            replies,
            buffered: HashMap::new(),
        }
    }
    fn send(&mut self, id: u64, method: &str, params: Value) {
        let input = self.input.as_mut().unwrap();
        serde_json::to_writer(
            &mut *input,
            &json!({"id":id,"method":method,"params":params}),
        )
        .unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
    }
    fn receive(&mut self, id: u64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(value) = self.buffered.remove(&id) {
                return value;
            }
            let value = self
                .replies
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|error| panic!("CLI response {id} blocked: {error}"));
            let response_id = value["id"].as_u64().expect("response ID preserved");
            self.buffered.insert(response_id, value);
        }
    }
    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(id, method, params);
        let value = self.receive(id);
        assert!(value.get("error").is_none(), "{value}");
        value["result"].clone()
    }
    fn eof(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "CLI did not drain/stop on EOF");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Cli {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn provider(package: &std::path::Path) {
    let script = r#"#!/usr/bin/python3
import json,sys,os,threading
lock=threading.Lock(); events={}; root=''
def send(value):
    with lock: print(json.dumps(value),flush=True)
def query(message):
    params=message['params']; event=threading.Event(); events[str(message['id'])]=event
    send({'jsonrpc':'2.0','method':'navigation.progress','params':{**params,'state':'loading','locations':[],'searchedContexts':1,'totalContexts':2,'reasons':[]}})
    event.wait(30)
    send({'id':message['id'],'result':{**params,'state':'canceled','locations':[],'searchedContexts':1,'totalContexts':2,'reasons':['canceled']}})
for line in sys.stdin:
    message=json.loads(line); method=message['method']; params=message.get('params') or {}; result={}
    if method=='initialize':
        root=params['root']; open(PID_FILE,'w').write(str(os.getpid())); result={'generation':params['generation']}
    elif method=='navigation.query': threading.Thread(target=query,args=(message,),daemon=True).start(); continue
    elif method=='$/cancelRequest':
        event=events.get(str(params['id']))
        if event: event.set()
        continue
    elif method=='shutdown': break
    if 'id' in message: send({'id':message['id'],'result':result})
"#
    .replace(
        "PID_FILE",
        &serde_json::to_string(&package.join("worker.pid")).unwrap(),
    );
    // Keep test instrumentation outside the watched workspace: a marker written
    // during initialization correctly invalidates an in-flight semantic epoch.
    fs::write(package.join("worker"), &script).unwrap();
    fs::set_permissions(package.join("worker"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(package.join("manifest.json"), json!({
        "id":"web","name":"CLI concurrency fixture","description":"fixture","version":"0.1.0","coreVersion":"^0.1.0",
        "platform":if cfg!(target_os="macos") {"darwin"} else {std::env::consts::OS},
        "architecture":if cfg!(target_arch="aarch64") {"arm64"} else {"x64"},
        "capabilities":["references"],"languages":["web"],"documentExtensions":["ts"],
        "executable":"worker","args":[],"checksums":{"worker":format!("{:x}",Sha256::digest(&script))}
    }).to_string()).unwrap();
}

#[test]
fn cli_progress_and_cancel_remain_responsive_with_all_query_threads_blocked() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    provider(package.path());
    fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
    let source = root.path().join("main.ts");
    fs::write(&source, "export const value=1;").unwrap();
    let mut cli = Cli::start(data.path());
    // Dependent mutations explicitly await acknowledgment; concurrency does
    // not weaken document revision or workspace generation preconditions.
    cli.call(1, "package.install", json!({"path":package.path()}));
    cli.call(2, "package.enable", json!({"id":"web","enabled":true}));
    let workspace = cli.call(3, "workspace.open", json!({"root":root.path()}));
    cli.call(4, "document.open", json!({"path":source}));
    for id in 10..16 {
        cli.send(id, "navigation.query", json!({"query":{"id":format!("held-{id}"),"path":source,"operation":"references","position":{"line":0,"character":14},"documentRevision":1,"workspaceGeneration":workspace["generation"]}}));
    }
    for id in 10..16 {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let result = cli.call(
                100 + id,
                "navigation.progress",
                json!({"id":format!("held-{id}")}),
            );
            if !result.is_null() {
                assert_eq!(result["state"], "loading");
                break;
            }
            assert!(
                !cli.buffered.contains_key(&id),
                "query completed before progress: {:?}",
                cli.buffered.get(&id)
            );
            assert!(Instant::now() < deadline, "query did not enter provider");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    // Fill the ordinary queue while all six workers are held. Reject overload
    // without blocking the reader ahead of progress and cancellation traffic.
    for id in 20..29 {
        cli.send(id,"navigation.query",json!({"query":{"id":format!("queued-{id}"),"path":source,"operation":"references","position":{"line":0,"character":14},"documentRevision":1,"workspaceGeneration":workspace["generation"]}}));
    }
    assert!(cli.receive(28)["error"]
        .as_str()
        .unwrap()
        .contains("queue is full"));
    assert_eq!(cli.call(200, "app.info", json!({}))["version"], "0.1.0");
    cli.call(201, "navigation.cancel", json!({"id":"held-10"}));
    assert_eq!(cli.receive(10)["result"]["state"], "canceled");
    assert!(cli
        .call(202, "navigation.progress", json!({"id":"held-10"}))
        .is_null());
    // EOF cancels the other five accepted queries and reaps the package worker.
    let pid: i32 = fs::read_to_string(package.path().join("worker.pid"))
        .unwrap()
        .parse()
        .unwrap();
    cli.eof();
    for id in 11..16 {
        assert_eq!(cli.receive(id)["result"]["state"], "canceled");
    }
    for id in 20..28 {
        assert_eq!(cli.receive(id)["result"]["state"], "canceled");
    }
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "package process survived EOF"
    );
}

#[test]
fn cli_eof_drains_acknowledged_mutations_and_preserves_dirty_recovery() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let source = root.path().join("notes.txt");
    fs::write(&source, "before").unwrap();
    let mut cli = Cli::start(data.path());
    cli.call(1, "workspace.open", json!({"root":root.path()}));
    cli.call(2, "document.open", json!({"path":source}));
    cli.send(
        3,
        "document.change",
        json!({"path":source,"revision":1,"changes":[{"from":0,"to":6,"insert":"after"}]}),
    );
    cli.eof();
    assert!(cli.receive(3).get("error").is_none());
    let mut restarted = Cli::start(data.path());
    restarted.call(1, "workspace.open", json!({"root":root.path()}));
    let document = restarted.call(2, "document.open", json!({"path":source}));
    assert_eq!(document["content"], "after");
    assert_eq!(document["dirty"], true);
    restarted.eof();
    assert_eq!(fs::read_to_string(source).unwrap(), "before");
}

#[test]
fn cli_output_backpressure_stops_workers_even_if_stdin_is_still_open() {
    for close_input in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let package = tempfile::tempdir().unwrap();
        provider(package.path());
        fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
        let source = root.path().join("large.ts");
        fs::write(&source, "x".repeat(1024 * 1024)).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_zwip-core"))
            .env("ZWIP_DATA", data.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        for (id, method, params) in [
            (1, "package.install", json!({"path":package.path()})),
            (2, "package.enable", json!({"id":"web","enabled":true})),
            (3, "workspace.open", json!({"root":root.path()})),
            (
                4,
                "tool.request",
                json!({"packageId":"web","method":"ping","params":{}}),
            ),
        ] {
            writeln!(
                input,
                "{}",
                json!({"id":id,"method":method,"params":params})
            )
            .unwrap();
            let mut line = String::new();
            output.read_line(&mut line).unwrap();
            let reply: Value = serde_json::from_str(&line).unwrap();
            assert!(reply.get("error").is_none(), "{reply}");
        }
        let worker_pid: i32 = fs::read_to_string(package.path().join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        writeln!(
            input,
            "{}",
            json!({"id":5,"method":"document.open","params":{"path":source}})
        )
        .unwrap();
        let mut input = Some(input);
        if close_input {
            input.take();
        }
        // Keep stdout open but deliberately never drain the large response.
        let deadline = Instant::now() + Duration::from_secs(6);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                unsafe {
                    libc::kill(worker_pid, libc::SIGKILL);
                }
                panic!("CLI blocked on stdout (stdin closed={close_input})");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(
            !status.success(),
            "broken transport must fail the CLI session"
        );
        assert_eq!(
            unsafe { libc::kill(worker_pid, 0) },
            -1,
            "worker survived output failure"
        );
        drop((input, output));
    }
}
