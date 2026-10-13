use ide_core::Core;
use serde_json::json;
use std::fs;

#[test]
fn file_actions_preserve_dirty_stale_and_existing_contents() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let source = core
        .request("workspace.createFile", json!({"relativePath":"first.txt"}))
        .unwrap()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::write(&source, "saved").unwrap();
    assert!(core
        .request("workspace.createFile", json!({"relativePath":"first.txt"}))
        .is_err());
    let plan = core
        .request(
            "workspace.filePreview",
            json!({"path":source,"operation":"rename","destination":"second.txt"}),
        )
        .unwrap();
    fs::write(&source, "external").unwrap();
    assert!(core
        .request("workspace.fileApply", json!({"id":plan["id"]}))
        .is_err());
    assert!(!root.path().join("second.txt").exists());
    core.request("document.open", json!({"path":source}))
        .unwrap();
    core.request(
        "document.change",
        json!({"path":source,"revision":1,"changes":[{"from":0,"to":8,"insert":"unsaved"}]}),
    )
    .unwrap();
    assert!(core
        .request(
            "workspace.filePreview",
            json!({"path":source,"operation":"trash"})
        )
        .is_err());
    assert_eq!(fs::read_to_string(&source).unwrap(), "external");
    core.request("document.save", json!({"path":source,"revision":2}))
        .unwrap();
    let plan = core
        .request(
            "workspace.filePreview",
            json!({"path":source,"operation":"rename","destination":"second.txt"}),
        )
        .unwrap();
    let renamed = core
        .request("workspace.fileApply", json!({"id":plan["id"]}))
        .unwrap();
    assert!(!std::path::Path::new(&source).exists());
    assert_eq!(
        fs::read_to_string(renamed["path"].as_str().unwrap()).unwrap(),
        "unsaved"
    );
}

#[test]
fn trash_survives_restart_and_restore_never_overwrites() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let path = root.path().join("keep.txt");
    fs::write(&path, "original").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let plan = core
        .request(
            "workspace.filePreview",
            json!({"path":path,"operation":"trash"}),
        )
        .unwrap();
    let result = core
        .request("workspace.fileApply", json!({"id":plan["id"]}))
        .unwrap();
    assert!(!path.exists());
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let entries = core.request("workspace.trashList", json!({})).unwrap();
    assert_eq!(entries[0]["available"], true);
    assert_eq!(entries[0]["id"], result["trashedId"]);
    fs::write(&path, "new").unwrap();
    assert!(core
        .request("workspace.trashRestore", json!({"id":result["trashedId"]}))
        .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    fs::remove_file(&path).unwrap();
    core.request("workspace.trashRestore", json!({"id":result["trashedId"]}))
        .unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
    assert_eq!(
        core.request("workspace.trashList", json!({})).unwrap(),
        json!([])
    );
}

#[test]
#[cfg(unix)]
fn path_traversal_and_changed_symlink_destinations_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    assert!(core
        .request(
            "workspace.createFile",
            json!({"relativePath":"../outside.txt"})
        )
        .is_err());
    let path = root.path().join("source.txt");
    fs::write(&path, "preserve").unwrap();
    fs::create_dir(root.path().join("destination")).unwrap();
    let plan = core
        .request(
            "workspace.filePreview",
            json!({"operation":"rename","path":path,"destination":"destination/target.txt"}),
        )
        .unwrap();
    fs::remove_dir(root.path().join("destination")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("destination")).unwrap();
    assert!(core
        .request("workspace.fileApply", json!({"id":plan["id"]}))
        .is_err());
    assert!(!outside.path().join("target.txt").exists());
    assert_eq!(fs::read_to_string(path).unwrap(), "preserve");
}
