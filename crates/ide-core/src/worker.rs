use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, TryLockError,
    },
    time::{Duration, Instant},
};
type Reply = mpsc::Sender<Result<Value, String>>;
#[derive(Default)]
struct Processes {
    closed: bool,
    workers: Vec<Arc<Worker>>,
}
/// Per-Core ownership, including workers already stopped or still initializing.
#[derive(Default)]
pub struct Supervisor(Mutex<Processes>);
impl Supervisor {
    pub fn spawn(
        &self,
        create: impl FnOnce() -> Result<Arc<Worker>, String>,
    ) -> Result<Arc<Worker>, String> {
        let mut processes = self.0.lock().map_err(|e| e.to_string())?;
        if processes.closed {
            return Err("Application is shutting down".into());
        }
        processes.workers.retain(|worker| !worker.reaped());
        let worker = create()?;
        processes.workers.push(worker.clone());
        Ok(worker)
    }
    pub fn shutdown(&self) {
        let workers = {
            let mut processes = self.0.lock().unwrap_or_else(|error| error.into_inner());
            processes.closed = true;
            std::mem::take(&mut processes.workers)
        };
        for worker in &workers {
            worker.stop();
        }
        // Reapers run concurrently; never hold the package host or registry lock here.
        for worker in workers {
            worker.wait_stopped();
        }
    }
}
struct Process {
    child: Option<Child>,
    reaper: Option<std::thread::JoinHandle<()>>,
}
struct ActiveRequest {
    id: u64,
    cancellation: Option<Arc<AtomicBool>>,
}
pub struct Worker {
    document_extensions: Vec<String>,
    active: Arc<Mutex<HashMap<String, ActiveRequest>>>,
    progress: Arc<Mutex<HashMap<String, Value>>>,
    process: Mutex<Process>,
    input: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    sequence: AtomicU64,
    healthy: AtomicBool,
    pub revisions: Mutex<HashMap<String, u64>>,
}
impl Worker {
    pub fn spawn(
        executable: &Path,
        args: &[String],
        directory: &Path,
        workspace: &str,
        cache: &Path,
        document_extensions: &[String],
    ) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
        let mut command = Command::new(executable);
        command.env("ZWIP_PACKAGE_CACHE", cache);
        command
            .args(args.iter().map(|arg| {
                let candidate = directory.join(arg);
                if candidate.is_file() {
                    candidate.to_string_lossy().into_owned()
                } else {
                    arg.clone()
                }
            }))
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot launch {}: {e}", executable.display()))?;
        let input = child.stdin.take().ok_or("Worker stdin unavailable")?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = input.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                let error = std::io::Error::last_os_error().to_string();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Cannot configure bounded worker input: {error}"));
            }
        }
        let output = child.stdout.take().ok_or("Worker stdout unavailable")?;
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let replies = pending.clone();
        let active = Arc::new(Mutex::new(HashMap::<String, ActiveRequest>::new()));
        let reading_active = active.clone();
        let progress = Arc::new(Mutex::new(HashMap::<String, Value>::new()));
        let reading_progress = progress.clone();
        let worker = Arc::new(Self {
            document_extensions: document_extensions.to_vec(),
            active,
            progress,
            process: Mutex::new(Process {
                child: Some(child),
                reaper: None,
            }),
            input: Mutex::new(input),
            pending,
            sequence: AtomicU64::new(1),
            healthy: AtomicBool::new(true),
            revisions: Mutex::new(HashMap::new()),
        });
        let reading_worker = Arc::downgrade(&worker);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let reason = loop {
                let message = match read_frame(&mut reader, 64 * 1024 * 1024) {
                    Ok(Some(message)) => message,
                    Ok(None) => break "Language worker exited; restart its package".to_owned(),
                    Err(error) => {
                        break format!("Invalid worker output: {error}; restart its package")
                    }
                };
                if message["method"] == "navigation.progress" {
                    let batch = &message["params"];
                    if let Some(key) = batch["id"].as_str() {
                        let active = reading_active
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        if active.contains_key(key) && batch["state"] == "loading" {
                            reading_progress
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .insert(key.to_owned(), batch.clone());
                        }
                    }
                    continue;
                }
                if let Some(id) = message["id"].as_u64() {
                    if let Some(sender) = replies.lock().ok().and_then(|mut map| map.remove(&id)) {
                        let result = if message.get("error").is_some_and(|v| !v.is_null()) {
                            Err(message["error"].to_string())
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = sender.send(result);
                    }
                }
            };
            if let Some(worker) = reading_worker.upgrade() {
                worker.finish(&reason, false);
            }
        });
        Ok(worker)
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, Duration::from_secs(180))
    }
    pub fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.request_deadline(method, params, timeout, true, None)
    }
    pub fn request_cancelable(
        &self,
        method: &str,
        params: Value,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        self.request_deadline(
            method,
            params,
            Duration::from_secs(180),
            true,
            Some(cancellation),
        )
    }
    /// Readiness probes are observational: a busy provider must not be killed
    /// merely because it cannot answer a status request within the UI deadline.
    pub fn probe(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.request_deadline(method, params, timeout, false, None)
    }
    fn request_deadline(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        stop_on_timeout: bool,
        cancellation: Option<Arc<AtomicBool>>,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let key = params["id"].as_str().map(str::to_owned);
        if let Some(key) = &key {
            self.active.lock().map_err(|e| e.to_string())?.insert(
                key.clone(),
                ActiveRequest {
                    id,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let (send, receive) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, send);
        // Core sets the shared token before looking up this transport request.
        // Checking after registration closes both the Core-to-Worker gap and the
        // active-to-pending gap, including a cancel that saw no pending sender.
        if cancellation
            .as_ref()
            .is_some_and(|token| token.load(Ordering::Acquire))
        {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            if let Some(key) = &key {
                self.active.lock().map_err(|e| e.to_string())?.remove(key);
            }
            return Err("Query canceled".into());
        }
        let sent = self.write_until_policy(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            deadline.min(Instant::now() + Duration::from_secs(2)),
            stop_on_timeout,
        );
        if let Err(error) = sent {
            self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
            if let Some(key) = &key {
                self.active.lock().map_err(|e| e.to_string())?.remove(key);
                self.progress.lock().map_err(|e| e.to_string())?.remove(key);
            }
            return Err(error);
        }
        // Cancellation may have been sent before this frame acquired stdin.
        // Repeat it after the complete frame so the provider can stop its work.
        if let (Some(key), Some(token)) = (&key, &cancellation) {
            if token.load(Ordering::Acquire) {
                self.cancel(key, token);
            }
        }
        let result = match receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(result) => result,
            Err(_) => {
                self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
                // Do not spend another unbounded write trying to cancel a timed-out worker.
                if stop_on_timeout {
                    self.finish(
                        "Language worker request timed out; restart its package",
                        false,
                    );
                }
                Err(format!("{method} timed out; results are incomplete"))
            }
        };
        if let Some(key) = key {
            self.active.lock().map_err(|e| e.to_string())?.remove(&key);
            self.progress
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&key);
        }
        result
    }
    pub fn cancel(&self, key: &str, token: &Arc<AtomicBool>) {
        if let Some(id) = self.active.lock().ok().and_then(|map| {
            let request = map.get(key).filter(|request| {
                request
                    .cancellation
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, token))
            })?;
            if let Ok(mut progress) = self.progress.lock() {
                progress.remove(key);
            }
            Some(request.id)
        }) {
            if let Some(sender) = self
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id))
            {
                let _ = sender.send(Err("Query canceled".into()));
            }
            let _ = self.write_until_policy(
                json!({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":id}}),
                Instant::now() + Duration::from_millis(50),
                false,
            );
        }
    }
    pub fn progress(&self, key: &str) -> Option<Value> {
        self.progress
            .lock()
            .ok()
            .and_then(|progress| progress.get(key).cloned())
    }
    pub fn write(&self, value: Value) -> Result<(), String> {
        self.write_until(value, Instant::now() + Duration::from_millis(250))
    }
    fn write_until(&self, value: Value, deadline: Instant) -> Result<(), String> {
        self.write_until_policy(value, deadline, true)
    }
    fn write_until_policy(
        &self,
        value: Value,
        deadline: Instant,
        stop_on_unsent_timeout: bool,
    ) -> Result<(), String> {
        let mut offset = 0;
        let mut timed_out = false;
        let result = (|| {
            let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            let mut check = || {
                if !self.healthy.load(Ordering::Acquire) {
                    Err("Language worker is unavailable; restart its package".to_owned())
                } else if Instant::now() >= deadline {
                    timed_out = true;
                    Err("Language worker input timed out; restart its package".to_owned())
                } else {
                    Ok(())
                }
            };
            let mut input = loop {
                check()?;
                match self.input.try_lock() {
                    Ok(input) => break input,
                    Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
                    Err(error) => return Err(error.to_string()),
                }
            };
            while offset < bytes.len() {
                check()?;
                match input.write(&bytes[offset..]) {
                    Ok(0) => return Err("Language worker input closed".into()),
                    Ok(count) => offset += count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        #[cfg(unix)]
                        {
                            use std::os::fd::AsRawFd;
                            let mut poll = libc::pollfd {
                                fd: input.as_raw_fd(),
                                events: libc::POLLOUT,
                                revents: 0,
                            };
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            let timeout = remaining.as_millis().clamp(1, 20) as i32;
                            let result = unsafe { libc::poll(&mut poll, 1, timeout) };
                            if result < 0
                                && std::io::Error::last_os_error().kind()
                                    != std::io::ErrorKind::Interrupted
                            {
                                return Err(std::io::Error::last_os_error().to_string());
                            }
                        }
                        #[cfg(not(unix))]
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
            Ok(())
        })();
        if let Err(error) = &result {
            // A timed-out write may have emitted half a JSONL frame. Never reuse
            // this stream or append a cancellation/shutdown to that partial line.
            if stop_on_unsent_timeout || offset > 0 || !timed_out {
                self.finish(error, false);
            }
        }
        result
    }
    pub fn accepts_document(&self, path: &str) -> bool {
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                self.document_extensions
                    .iter()
                    .any(|expected| expected == extension)
            })
    }
    pub fn is_running(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
            && self.process.lock().ok().is_some_and(|mut process| {
                process
                    .child
                    .as_mut()
                    .is_some_and(|child| !child_exited(child))
            })
    }
    pub fn stop(&self) {
        self.finish("Language worker stopped", true);
    }
    fn reaped(&self) -> bool {
        self.process.lock().is_ok_and(|process| {
            process.child.is_none()
                && process
                    .reaper
                    .as_ref()
                    .is_none_or(|reaper| reaper.is_finished())
        })
    }
    pub fn wait_stopped(&self) {
        self.stop();
        let reaper = self
            .process
            .lock()
            .ok()
            .and_then(|mut process| process.reaper.take());
        if let Some(reaper) = reaper {
            let _ = reaper.join();
        }
    }
    fn finish(&self, reason: &str, graceful: bool) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.clear();
        }
        let was_healthy = self.healthy.swap(false, Ordering::AcqRel);
        // Stop/cancel may run under the package host lock. Never wait on the
        // input mutex here, and transfer process waiting to a dedicated reaper.
        let shutdown_sent = graceful
            && was_healthy
            && self.input.try_lock().is_ok_and(|mut input| {
                let message = b"{\"jsonrpc\":\"2.0\",\"method\":\"shutdown\",\"params\":{}}\n";
                matches!(input.write(message), Ok(count) if count == message.len())
            });
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(reason.to_owned()));
            }
        }
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(mut child) = process.child.take() {
            process.reaper = Some(std::thread::spawn(move || {
                let deadline = Instant::now()
                    + if shutdown_sent {
                        Duration::from_secs(1)
                    } else {
                        Duration::ZERO
                    };
                while std::time::Instant::now() < deadline {
                    if child_exited(&mut child) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                // Keep the leader unreaped until group cleanup ends: its PID/PGID
                // cannot be reused while this owned child is alive or a zombie.
                // A leader exiting does not establish that its children exited.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGTERM);
                }
                std::thread::sleep(Duration::from_millis(100));
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
            }));
        }
    }
}

#[cfg(unix)]
fn child_exited(child: &mut Child) -> bool {
    let mut status = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut status,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    result == 0 && unsafe { status.si_pid() } != 0
}

#[cfg(not(unix))]
fn child_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

// Bound a complete JSONL frame before parsing it. Oversized/invalid output fails the
// provider explicitly; it can never become a truncated successful semantic result.
fn read_frame(reader: &mut impl BufRead, limit: usize) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    let count = reader
        .take(limit as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    if count > limit {
        return Err(format!("frame exceeds {limit} bytes"));
    }
    if bytes.last() != Some(&b'\n') {
        return Err("incomplete JSONL frame".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod frame_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn cancellation_during_registration_is_observed_and_old_tokens_cannot_cancel_reuse() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("worker.py");
        std::fs::write(
            &script,
            r#"#!/usr/bin/python3
import json,sys,time
for line in sys.stdin:
    message=json.loads(line)
    if message['method']=='shutdown': break
    if 'id' not in message: continue
    if message['method']=='hold': time.sleep(0.1)
    print(json.dumps({'id':message['id'],'result':message['method']}),flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let worker = Worker::spawn(
            &script,
            &[],
            root.path(),
            root.path().to_str().unwrap(),
            &root.path().join("cache"),
            &[],
        )
        .unwrap();
        let old = Arc::new(AtomicBool::new(false));
        let registration = worker.pending.lock().unwrap();
        let (sender, canceled) = (worker.clone(), old.clone());
        let first = std::thread::spawn(move || {
            sender.request_cancelable("never-sent", json!({"id":"reuse"}), canceled)
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !worker.active.lock().unwrap().contains_key("reuse") {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        // Simulate cancel after active registration but before a pending sender
        // exists; the token, rather than a map lookup, carries this cancellation.
        old.store(true, Ordering::Release);
        drop(registration);
        assert!(first.join().unwrap().unwrap_err().contains("canceled"));
        let fresh = Arc::new(AtomicBool::new(false));
        let (sender, token) = (worker.clone(), fresh.clone());
        let second = std::thread::spawn(move || {
            sender.request_cancelable("hold", json!({"id":"reuse"}), token)
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !worker.active.lock().unwrap().contains_key("reuse") {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        worker.cancel("reuse", &old);
        assert_eq!(second.join().unwrap().unwrap(), "hold");
        assert!(!fresh.load(Ordering::Acquire));
        worker.wait_stopped();
    }
    #[test]
    fn reads_one_bounded_frame_without_consuming_the_next() {
        let mut input = &b"{\"id\":1}\n{\"id\":2}\n"[..];
        assert_eq!(read_frame(&mut input, 12).unwrap().unwrap()["id"], 1);
        assert_eq!(read_frame(&mut input, 12).unwrap().unwrap()["id"], 2);
        assert!(read_frame(&mut input, 12).unwrap().is_none());
        assert!(read_frame(&mut &b"12345678901234567890"[..], 12)
            .unwrap_err()
            .contains("exceeds"));
        assert!(read_frame(&mut &b"{}"[..], 12)
            .unwrap_err()
            .contains("incomplete"));
        assert!(read_frame(&mut &b"not json\n"[..], 12).is_err());
    }
}
