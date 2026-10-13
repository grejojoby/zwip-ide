use ide_core::Core;
use serde_json::json;
use std::time::{Duration, Instant};
#[test]
fn terminal_is_a_real_resizable_pty_and_stops_with_workspace() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let core = Core::new(data.path().into()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let terminal = core
        .request("terminal.start", json!({"rows":24,"cols":80}))
        .unwrap();
    let id = &terminal["id"];
    core.request("terminal.resize", json!({"id":id,"rows":33,"cols":99}))
        .unwrap();
    let command = b"printf '\\nPTY_READY:'; test -t 0 && stty size\r";
    core.request("terminal.write", json!({"id":id,"bytes":command.to_vec()}))
        .unwrap();
    let mut cursor = 0;
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let output = core
            .request("terminal.read", json!({"id":id,"cursor":cursor}))
            .unwrap();
        cursor = output["cursor"].as_u64().unwrap();
        let bytes: Vec<u8> = serde_json::from_value(output["bytes"].clone()).unwrap();
        text.push_str(&String::from_utf8_lossy(&bytes));
        if text.contains("PTY_READY:33 99") {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(text.contains("PTY_READY:33 99"), "{text}");
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    assert!(core.request("terminal.read", json!({"id":id})).is_err());
}
