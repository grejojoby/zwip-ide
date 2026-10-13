use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
pub struct Task {
    child: Mutex<Child>,
    output: Arc<Mutex<String>>,
}
pub struct Tasks {
    tasks: Mutex<HashMap<String, Arc<Task>>>,
    sequence: AtomicU64,
}
impl Default for Tasks {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }
}
impl Tasks {
    pub fn start(&self, command: &str, cwd: &Path) -> Result<Value, String> {
        if command.trim().is_empty() {
            return Err("Enter a command to run".into());
        }
        let mut process = Command::new("/bin/zsh");
        process
            .args(["-lc", command])
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            process.process_group(0);
        }
        let mut child = process.spawn().map_err(|e| e.to_string())?;
        let output = Arc::new(Mutex::new(String::new()));
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let output = output.clone();
            std::thread::spawn(move || {
                let mut pipe = pipe;
                let mut buffer = [0u8; 8192];
                while let Ok(count) = pipe.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    if let Ok(mut output) = output.lock() {
                        output.push_str(&String::from_utf8_lossy(&buffer[..count]));
                        if output.len() > 2 * 1024 * 1024 {
                            let mut boundary = output.len() - 2 * 1024 * 1024;
                            while !output.is_char_boundary(boundary) {
                                boundary += 1;
                            }
                            output.drain(..boundary);
                        }
                    }
                }
            });
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed).to_string();
        self.tasks.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Arc::new(Task {
                child: Mutex::new(child),
                output,
            }),
        );
        self.status(&id)
    }
    pub fn status(&self, id: &str) -> Result<Value, String> {
        let task = self
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or("Task not found")?;
        let status = task
            .child
            .lock()
            .map_err(|e| e.to_string())?
            .try_wait()
            .map_err(|e| e.to_string())?;
        let output = task.output.lock().map_err(|e| e.to_string())?.clone();
        Ok(
            json!({"id":id,"output":output,"exitCode":status.and_then(|s|s.code()),"running":status.is_none()}),
        )
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let task = self
            .tasks
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or("Task not found")?;
        terminate(&task);
        Ok(())
    }
    pub fn stop_all(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            for (_, task) in tasks.drain() {
                terminate(&task);
            }
        }
    }
}
fn terminate(task: &Task) {
    if let Ok(mut child) = task.child.lock() {
        if matches!(child.try_wait(), Ok(None)) {
            #[cfg(unix)]
            {
                let _ = Command::new("/bin/kill")
                    .args(["-TERM", "--", &format!("-{}", child.id())])
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Tasks {
    fn drop(&mut self) {
        self.stop_all();
    }
}
