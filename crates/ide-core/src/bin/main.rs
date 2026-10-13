use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const DRAIN_GRACE: Duration = Duration::from_secs(2);

enum Frame {
    Message(Vec<u8>),
    TooLarge,
    End,
}

// Drain oversized frames without retaining their remaining bytes so the next
// valid JSON line can still be processed. EOF also accepts a final bare line.
fn read_frame(reader: &mut impl BufRead, limit: usize) -> io::Result<Frame> {
    let mut bytes = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if too_large {
                Frame::TooLarge
            } else if bytes.is_empty() {
                Frame::End
            } else {
                Frame::Message(bytes)
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if !too_large {
            let payload = newline.unwrap_or(count);
            if bytes.len().saturating_add(payload) > limit {
                too_large = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..payload]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            return Ok(if too_large {
                Frame::TooLarge
            } else {
                Frame::Message(bytes)
            });
        }
    }
}

struct Output {
    serial: Mutex<()>,
    failed: AtomicBool,
}
impl Output {
    fn new() -> io::Result<Self> {
        #[cfg(unix)]
        unsafe {
            let flags = libc::fcntl(libc::STDOUT_FILENO, libc::F_GETFL);
            if flags < 0
                || libc::fcntl(libc::STDOUT_FILENO, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self {
            serial: Mutex::new(()),
            failed: AtomicBool::new(false),
        })
    }
    fn send(&self, response: Value) -> io::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        let fail = |error| {
            self.failed.store(true, Ordering::Release);
            error
        };
        let check = || {
            if self.failed.load(Ordering::Acquire) || Instant::now() >= deadline {
                Err(fail(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "CLI output timed out",
                )))
            } else {
                Ok(())
            }
        };
        let _serial = loop {
            check()?;
            match self.serial.try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::WouldBlock) => thread::sleep(Duration::from_millis(1)),
                Err(_) => return Err(fail(io::Error::other("CLI output lock poisoned"))),
            }
        };
        let mut offset = 0;
        while offset < bytes.len() {
            check()?;
            #[cfg(unix)]
            let written = unsafe {
                let count = libc::write(
                    libc::STDOUT_FILENO,
                    bytes[offset..].as_ptr().cast(),
                    bytes.len() - offset,
                );
                if count < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(count as usize)
                }
            };
            #[cfg(not(unix))]
            let written = std::io::Write::write(&mut io::stdout(), &bytes[offset..]);
            match written {
                Ok(0) => {
                    return Err(fail(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "CLI output closed",
                    )))
                }
                Ok(count) => offset += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(error) => return Err(fail(error)),
            }
        }
        Ok(())
    }
}
fn send(output: &Output, core: &ide_core::Core, response: Value) {
    if output.send(response).is_err() {
        // A partial JSONL response cannot be followed by another response. Close
        // the session and reap owned processes even if stdin remains open.
        core.shutdown();
        std::process::exit(1);
    }
}

struct Job {
    sequence: u64,
    message: Value,
}

fn cancellation_id(message: &Value) -> Option<String> {
    match message["method"].as_str()? {
        "navigation.query" | "editor.request" => message["params"]["query"]["id"].as_str(),
        "workspace.symbols" => message["params"]["id"].as_str(),
        _ => None,
    }
    .map(String::from)
}

fn main() {
    let data = std::env::var_os("ZWIP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("zwip-cli"));
    let core = Arc::new(ide_core::Core::new(data).expect("initialize core"));
    let output = Arc::new(Output::new().expect("configure bounded CLI output"));
    let pending = Arc::new(Mutex::new(HashMap::<u64, Option<String>>::new()));
    let mut threads = Vec::new();
    let mut lanes = Vec::new();
    // Reserve two of eight threads for control traffic. A full ordinary lane
    // never blocks stdin and therefore cannot starve progress/cancellation.
    for workers in [6, 2] {
        let (sender, receiver) = mpsc::sync_channel::<Job>(8);
        lanes.push(sender);
        let receiver = Arc::new(Mutex::new(receiver));
        for _ in 0..workers {
            let (receiver, core, output, pending) = (
                receiver.clone(),
                core.clone(),
                output.clone(),
                pending.clone(),
            );
            threads.push(thread::spawn(move || loop {
                let job = receiver
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .recv();
                let Ok(Job { sequence, message }) = job else {
                    break;
                };
                let response = match core.request(
                    message["method"].as_str().unwrap_or(""),
                    message["params"].clone(),
                ) {
                    Ok(result) => json!({"id": message["id"], "result": result}),
                    Err(error) => json!({"id": message["id"], "error": error}),
                };
                send(&output, &core, response);
                pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&sequence);
            }));
        }
    }
    let mut sequence = 0;
    let mut input = io::stdin().lock();
    loop {
        let message = match read_frame(&mut input, MAX_FRAME_BYTES) {
            Ok(Frame::End) => break,
            Ok(Frame::TooLarge) => {
                send(
                    &output,
                    &core,
                    json!({"id":null,"error":"CLI input frame exceeds 64 MiB"}),
                );
                continue;
            }
            Ok(Frame::Message(bytes)) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(message) => message,
                Err(error) => {
                    send(&output, &core, json!({"id":null,"error":error.to_string()}));
                    continue;
                }
            },
            Err(error) => {
                send(&output, &core, json!({"id":null,"error":error.to_string()}));
                break;
            }
        };
        sequence += 1;
        pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(sequence, cancellation_id(&message));
        let control = matches!(
            message["method"].as_str(),
            Some("app.info" | "navigation.progress" | "navigation.cancel")
        );
        if let Err(error) = lanes[usize::from(control)].try_send(Job { sequence, message }) {
            let job = match error {
                mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job) => job,
            };
            pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&sequence);
            send(
                &output,
                &core,
                json!({"id":job.message["id"],"error":"CLI request queue is full; retry after an outstanding response"}),
            );
        }
    }
    drop(lanes);
    let cancellations: Vec<_> = pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .values()
        .flatten()
        .cloned()
        .collect();
    for id in cancellations {
        let _ = core.request("navigation.cancel", json!({"id":id}));
    }
    // Let accepted writes and canceled queries acknowledge their results. A
    // stalled worker cannot keep EOF alive forever: Core stops it after grace.
    let deadline = Instant::now() + DRAIN_GRACE;
    while !pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .is_empty()
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(5));
    }
    core.shutdown();
    for worker in threads {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_limit_drains_overflow_and_preserves_next_line_and_eof() {
        let mut input =
            io::BufReader::with_capacity(2, io::Cursor::new(b"12345\n123456789012345\nok\ntail"));
        assert!(
            matches!(read_frame(&mut input, 5).unwrap(), Frame::Message(bytes) if bytes == b"12345")
        );
        assert!(matches!(
            read_frame(&mut input, 5).unwrap(),
            Frame::TooLarge
        ));
        assert!(
            matches!(read_frame(&mut input, 5).unwrap(), Frame::Message(bytes) if bytes == b"ok")
        );
        assert!(
            matches!(read_frame(&mut input, 5).unwrap(), Frame::Message(bytes) if bytes == b"tail")
        );
        assert!(matches!(read_frame(&mut input, 5).unwrap(), Frame::End));
    }
}
