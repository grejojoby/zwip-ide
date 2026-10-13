use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
const LIMIT: usize = 2 * 1024 * 1024;
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    offset: u64,
    closed: bool,
}
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output: Arc<Mutex<Output>>,
}
#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<String, Session>>,
    next: AtomicU64,
}
impl Terminals {
    pub fn start(&self, cwd: &Path, rows: u16, cols: u16) -> Result<Value, String> {
        let pair = native_pty_system()
            .openpty(size(rows, cols)?)
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new("/bin/zsh");
        command.arg("-l");
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("GOROOT", "/Users/grejo.j/.gvm/gos/go1.25.5");
        command.env(
            "PATH",
            format!(
                "/Users/grejo.j/.gvm/gos/go1.25.5/bin:{}",
                std::env::var("PATH").unwrap_or_default()
            ),
        );
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let output = Arc::new(Mutex::new(Output::default()));
        let buffer = output.clone();
        std::thread::spawn(move || {
            let mut chunk = [0; 8192];
            while let Ok(count) = reader.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                if let Ok(mut output) = buffer.lock() {
                    output.bytes.extend(&chunk[..count]);
                    let excess = output.bytes.len().saturating_sub(LIMIT);
                    output.bytes.drain(..excess);
                    output.offset += excess as u64;
                }
            }
            if let Ok(mut output) = buffer.lock() {
                output.closed = true;
            }
        });
        let id = format!("terminal-{}", self.next.fetch_add(1, Ordering::Relaxed));
        self.sessions.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Session {
                master: pair.master,
                writer,
                child,
                output,
            },
        );
        Ok(json!({"id":id}))
    }
    pub fn read(&self, id: &str, cursor: u64) -> Result<Value, String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(id).ok_or("Terminal is closed")?;
        let exit = session.child.try_wait().map_err(|e| e.to_string())?;
        let output = session.output.lock().map_err(|e| e.to_string())?;
        let start = cursor
            .max(output.offset)
            .min(output.offset + output.bytes.len() as u64);
        let bytes: Vec<u8> = output
            .bytes
            .iter()
            .skip((start - output.offset) as usize)
            .take(64 * 1024)
            .copied()
            .collect();
        Ok(
            json!({"bytes":bytes,"cursor":start+bytes.len() as u64,"dropped":cursor<output.offset,"running":exit.is_none(),"exitCode":exit.map(|s|s.exit_code())}),
        )
    }
    pub fn write(&self, id: &str, input: &[u8]) -> Result<(), String> {
        if input.len() > 1024 * 1024 {
            return Err("Terminal input exceeds 1 MiB".into());
        }
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.get_mut(id).ok_or("Terminal is closed")?;
        session
            .writer
            .write_all(input)
            .and_then(|_| session.writer.flush())
            .map_err(|e| e.to_string())
    }
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .ok_or("Terminal is closed")?
            .master
            .resize(size(rows, cols)?)
            .map_err(|e| e.to_string())
    }
    pub fn stop(&self, id: &str) {
        if let Some(mut session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(id))
        {
            // Both IDs belong to this PTY; signal foreground jobs and its shell session.
            for pid in [
                session.master.process_group_leader(),
                session.child.process_id().map(|p| p as i32),
            ]
            .into_iter()
            .flatten()
            .filter(|pid| *pid > 1)
            {
                unsafe {
                    libc::kill(-pid, libc::SIGHUP);
                }
            }
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
    pub fn stop_all(&self) {
        let ids = self
            .sessions
            .lock()
            .map(|map| map.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
        }
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.stop_all();
    }
}
fn size(rows: u16, cols: u16) -> Result<PtySize, String> {
    if !(1..=1000).contains(&rows) || !(1..=1000).contains(&cols) {
        return Err("Terminal size must be between 1 and 1000 cells".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
