use ide_core::Core;
use serde_json::json;
use std::fs;

#[test]
fn explicit_workspace_uses_its_own_ignore_boundary() {
    let parent = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::write(parent.path().join(".gitignore"), "workspace/\n").unwrap();
    let root = parent.path().join("workspace");
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("go.mod"),
        "module example.test/boundary\ngo 1.25.0\n",
    )
    .unwrap();
    fs::write(root.join("main.go"), "package main\n").unwrap();
    fs::write(root.join("ignored.go"), "package main\n").unwrap();
    fs::write(root.join(".gitignore"), "ignored.go\n").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root}))
        .unwrap();
    let paths: Vec<_> = workspace["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["relativePath"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"main.go"));
    assert!(paths.contains(&"go.mod"));
    assert!(!paths.contains(&"ignored.go"));
    assert_eq!(workspace["contexts"].as_array().unwrap().len(), 1);
}

#[test]
fn scan_progress_reports_the_indexed_file_count() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    for name in ["a.go", "b.go", "c.md"] {
        fs::write(root.path().join(name), "x\n").unwrap();
    }
    let core = Core::new(data.path().to_owned()).unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let progress = core.request("workspace.scanProgress", json!({})).unwrap();
    assert_eq!(
        progress["files"].as_u64().unwrap() as usize,
        workspace["files"].as_array().unwrap().len()
    );
}

#[test]
fn explicit_profiles_preserve_defaults_and_invalidate_changed_settings() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("go.mod"),
        "module example.test/profiles\ngo 1.25.0\n",
    )
    .unwrap();
    fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
    let configuration = |target| json!({"version":1,"buildProfiles":[{"id":"ci","language":"go","configPaths":["go.mod"],"settings":{"goos":target,"goarch":"amd64","tags":["integration"],"cgoEnabled":false}}]});
    let write = |value: serde_json::Value| {
        fs::write(root.path().join(".zwip.json"), value.to_string()).unwrap()
    };
    write(configuration("linux"));
    let core = Core::new(data.path().to_owned()).unwrap();
    let opened = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let contexts = opened["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 3);
    assert_eq!(contexts[0]["id"], "go.mod");
    assert!(contexts[0].get("settings").is_none());
    assert_eq!(contexts[1]["id"], "go.mod#ci");
    assert_eq!(contexts[1]["profileId"], "ci");
    assert_eq!(contexts[1]["settings"]["goos"], "linux");
    assert_eq!(contexts[1]["documentExtensions"], json!(["go"]));
    assert_eq!(
        core.request("workspace.rescan", json!({})).unwrap()["generation"],
        opened["generation"]
    );
    write(configuration("windows"));
    let changed = core.request("workspace.rescan", json!({})).unwrap();
    assert!(changed["generation"].as_u64().unwrap() > opened["generation"].as_u64().unwrap());
    assert_eq!(changed["contexts"][1]["settings"]["goos"], "windows");
    write(
        json!({"version":1,"buildProfiles":[{"id":"invalid","language":"go","configPaths":["missing/go.mod"],"settings":{}}]}),
    );
    assert!(core
        .request("workspace.rescan", json!({}))
        .unwrap_err()
        .contains("undiscovered"));
    // A failed rescan retains the previous usable snapshot.
    assert_eq!(
        core.request("workspace.status", json!({})).unwrap()["generation"],
        changed["generation"]
    );
}

#[test]
fn invalid_profiles_fail_explicitly_instead_of_reducing_scope() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("go.mod"),
        "module example.test/profiles\ngo 1.25.0\n",
    )
    .unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let profile = json!({"id":"ci","language":"go","configPaths":["go.mod"],"settings":{}});
    for config in [
        json!({"version":2}),
        json!({"version":1,"buildProfiles":[profile.clone(),profile.clone()]}),
        json!({"version":1,"buildProfiles":[{"id":"ci","language":"web","configPaths":["go.mod"],"settings":{}}]}),
        json!({"version":1,"buildProfiles":[{"id":"ci","language":"go","configPaths":["./go.mod"],"settings":{}}]}),
        json!({"version":1,"buildProfiles":[{"id":"ci","language":"go","configPaths":["go.mod"],"settings":[]}]}),
        json!({"version":1,"buildProfiles":[{"id":"ci","language":"go","configPaths":["go.mod","go.mod"],"settings":{}}]}),
        json!({"version":1,"buildProfiles":(0..65).map(|n| { let mut item = profile.clone(); item["id"] = json!(format!("p{n}")); item }).collect::<Vec<_>>()}),
    ] {
        fs::write(root.path().join(".zwip.json"), config.to_string()).unwrap();
        assert!(
            core.request("workspace.open", json!({"root":root.path()}))
                .is_err(),
            "accepted {config}"
        );
    }
}

#[test]
fn workspace_switch_rejects_unsaved_buffers_until_saved() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = first.path().join("note.txt");
    fs::write(&file, "saved").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let before = core
        .request("workspace.open", json!({"root":first.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    core.request(
        "document.change",
        json!({"path":file,"revision":1,"changes":[{"from":0,"to":5,"insert":"unsaved"}]}),
    )
    .unwrap();

    let error = core
        .request("workspace.open", json!({"root":second.path()}))
        .unwrap_err();
    assert!(error.contains("unsaved"), "{error}");
    let document = core.request("document.open", json!({"path":file})).unwrap();
    assert_eq!(document["content"], "unsaved");
    assert_eq!(document["workspaceGeneration"], before["generation"]);
    assert_eq!(
        core.request("workspace.status", json!({})).unwrap()["generation"],
        before["generation"]
    );
    assert_eq!(
        core.request("recovery.list", json!({})).unwrap()[0]["preview"],
        "unsaved"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "saved");

    core.request("document.save", json!({"path":file,"revision":2}))
        .unwrap();
    let after = core
        .request("workspace.open", json!({"root":second.path()}))
        .unwrap();
    assert!(after["generation"].as_u64().unwrap() > before["generation"].as_u64().unwrap());
    assert_eq!(fs::read_to_string(&file).unwrap(), "unsaved");
}

#[test]
fn failed_workspace_open_keeps_the_current_generation_and_unsaved_work() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = root.path().join("a.ts");
    fs::write(&file, "original").unwrap();
    fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    core.request(
        "document.change",
        json!({"path":file,"revision":1,"changes":[{"from":0,"to":8,"insert":"unsaved"}]}),
    )
    .unwrap();
    assert!(core
        .request("workspace.open", json!({"root":root.path().join("absent")}))
        .is_err());
    let reply = core
        .request(
            "workspace.symbols",
            json!({"id":"after","query":"name","workspaceGeneration":workspace["generation"]}),
        )
        .unwrap();
    assert!(
        reply["reasons"].to_string().contains("Install and enable"),
        "{reply}"
    );
    let doc = core.request("document.open", json!({"path":file})).unwrap();
    assert_eq!(doc["content"], "unsaved");
    assert_eq!(doc["workspaceGeneration"], workspace["generation"]);
}

#[test]
fn deleted_source_recovery_can_be_exported_without_overwriting_another_file() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let source = workspace.path().join("deleted.txt");
    let copy = workspace.path().join("recovered.txt");
    fs::write(&source, "saved").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let doc = core
        .request("document.open", json!({"path":source}))
        .unwrap();
    core.request("document.change",json!({"path":source,"revision":doc["revision"],"changes":[{"from":0,"to":5,"insert":"precious unsaved text"}]})).unwrap();
    drop(core);
    fs::remove_file(&source).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let entries = core.request("recovery.list", json!({})).unwrap();
    let entry = &entries[0];
    assert_eq!(entry["missing"], true);
    assert_eq!(entry["preview"], "precious unsaved text");
    fs::write(&copy, "preserve").unwrap();
    let args = json!({"path":entry["path"],"revision":entry["revision"],"destination":copy});
    assert!(core.request("recovery.restoreCopy", args.clone()).is_err());
    assert_eq!(fs::read_to_string(&copy).unwrap(), "preserve");
    fs::remove_file(&copy).unwrap();
    core.request("recovery.restoreCopy", args).unwrap();
    assert_eq!(fs::read_to_string(&copy).unwrap(), "precious unsaved text");
    assert_eq!(
        core.request("recovery.list", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(core
        .request(
            "recovery.discard",
            json!({"path":entry["path"],"revision":1})
        )
        .is_err());
    core.request(
        "recovery.discard",
        json!({"path":entry["path"],"revision":entry["revision"]}),
    )
    .unwrap();
    assert!(core
        .request("recovery.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn external_deletion_does_not_interrupt_edit_recovery() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let source = root.path().join("removed.txt");
    fs::write(&source, "first").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    let opened = core
        .request("document.open", json!({"path":source}))
        .unwrap();
    let path = &opened["path"];
    fs::remove_file(&source).unwrap();
    core.request(
        "document.change",
        json!({"path":path,"revision":1,"changes":[{"from":5,"to":5,"insert":" after deletion"}]}),
    )
    .unwrap();
    assert!(core
        .request("document.save", json!({"path":path,"revision":2}))
        .is_err());
    assert!(!source.exists());
    let recovery = core.request("recovery.list", json!({})).unwrap();
    assert_eq!(recovery[0]["preview"], "first after deletion");
}

#[test]
fn closing_clean_document_releases_its_mirror_but_dirty_recovery_survives() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let source = workspace.path().join("source.txt");
    fs::write(&source, "first").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    core.request("document.open", json!({"path":source}))
        .unwrap();
    assert_eq!(
        core.request("document.close", json!({"path":source,"revision":1}))
            .unwrap()["released"],
        true
    );
    fs::write(&source, "second").unwrap();
    assert_eq!(
        core.request("document.open", json!({"path":source}))
            .unwrap()["content"],
        "second"
    );
    core.request(
        "document.change",
        json!({"path":source,"revision":1,"changes":[{"from":0,"to":6,"insert":"unsaved"}]}),
    )
    .unwrap();
    assert_eq!(
        core.request("document.close", json!({"path":source,"revision":2}))
            .unwrap()["released"],
        false
    );
    assert_eq!(
        core.request("document.open", json!({"path":source}))
            .unwrap()["content"],
        "unsaved"
    );
}

#[test]
fn symbol_search_reports_missing_project_providers_and_obsolete_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::write(
        workspace.path().join("go.mod"),
        "module example.test/app\ngo 1.25.0\n",
    )
    .unwrap();
    fs::write(workspace.path().join("tsconfig.json"), "{}").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let snapshot = core
        .request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let reply = core
        .request(
            "workspace.symbols",
            json!({"id":"s", "query":"Missing", "workspaceGeneration":snapshot["generation"]}),
        )
        .unwrap();
    assert_eq!(reply["state"], "partial");
    assert_eq!(reply["totalContexts"], 2);
    assert_eq!(reply["searchedContexts"], 0);
    assert_eq!(reply["reasons"].as_array().unwrap().len(), 2);
    core.request("workspace.refresh", json!({})).unwrap();
    assert!(core
        .request(
            "workspace.symbols",
            json!({"id":"old", "query":"Missing", "workspaceGeneration":snapshot["generation"]})
        )
        .is_err());
}

#[test]
fn edits_use_utf16_offsets_and_reject_obsolete_revisions() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = workspace.path().join("unicode.txt");
    fs::write(&file, "a😀b").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let doc = core.request("document.open", json!({"path":file})).unwrap();
    let revision = doc["revision"].as_u64().unwrap();
    let next = core
        .request(
            "document.change",
            json!({"path":file,"revision":revision,"changes":[{"from":1,"to":3,"insert":"x"}]}),
        )
        .unwrap();
    assert!(
        next.get("content").is_none(),
        "acks must not copy documents"
    );
    assert!(core
        .request(
            "document.change",
            json!({"path":file,"revision":revision,"changes":[]})
        )
        .is_err());
    core.request(
        "document.save",
        json!({"path":file,"revision":next["revision"]}),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(file).unwrap(), "axb");
}

#[test]
fn disk_conflicts_preserve_unsaved_buffers_and_original_disk() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = workspace.path().join("source.txt");
    fs::write(&file, "original").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    core.request(
        "document.change",
        json!({"path":file,"revision":1,"changes":[{"from":0,"to":8,"insert":"buffer"}]}),
    )
    .unwrap();
    fs::write(&file, "external").unwrap();
    assert!(core
        .request("document.save", json!({"path":file,"revision":2}))
        .is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "external");
    assert_eq!(
        core.request("document.open", json!({"path":file})).unwrap()["content"],
        "buffer"
    );
}

#[test]
fn workspace_includes_untracked_source_and_excludes_nested_worktrees() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::write(workspace.path().join("new.go"), "package main").unwrap();
    fs::create_dir_all(workspace.path().join(".claude/worktrees/copy")).unwrap();
    fs::write(
        workspace.path().join(".claude/worktrees/copy/duplicate.go"),
        "package main",
    )
    .unwrap();
    fs::write(
        workspace.path().join("go.mod"),
        "module example.test/main\ngo 1.25.0\n",
    )
    .unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let snapshot = core
        .request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let paths: Vec<_> = snapshot["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["relativePath"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"new.go"));
    assert!(!paths.iter().any(|p| p.contains("duplicate")));
    assert_eq!(snapshot["contexts"].as_array().unwrap().len(), 1);
}

#[test]
fn project_refresh_keeps_unsaved_buffer_and_revision() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = workspace.path().join("source.txt");
    fs::write(&file, "old").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    core.request(
        "document.change",
        json!({"path":file,"revision":1,"changes":[{"from":0,"to":3,"insert":"unsaved"}]}),
    )
    .unwrap();
    core.request("workspace.refresh", json!({})).unwrap();
    let doc = core.request("document.open", json!({"path":file})).unwrap();
    assert_eq!(doc["content"], "unsaved");
    assert_eq!(doc["revision"], 2);
    core.request("document.save", json!({"path":file,"revision":2}))
        .unwrap();
    assert_eq!(fs::read_to_string(file).unwrap(), "unsaved");
}

#[test]
fn sync_rollback_preserves_local_edit_base_and_recovery() {
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = workspace.path().join("race.txt");
    fs::write(&file, "old").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    fs::write(&file, "external replacement").unwrap();
    let sync = core.request("document.sync", json!({"path":file})).unwrap();
    let rollback = core
        .request(
            "document.rejectSync",
            json!({"path":file,"revision":sync["rollbackRevision"]}),
        )
        .unwrap();
    core.request("document.change",json!({"path":file,"revision":rollback["revision"],"changes":[{"from":3,"to":3,"insert":" local"}]})).unwrap();
    assert!(core
        .request("document.save", json!({"path":file,"revision":4}))
        .is_err());
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    assert_eq!(
        core.request("document.open", json!({"path":file})).unwrap()["content"],
        "old local"
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "external replacement");
}

#[test]
fn workspace_edit_validates_all_files_before_atomic_recovery_update() {
    use sha2::{Digest, Sha256};
    let workspace = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let a = workspace.path().join("a.ts");
    let b = workspace.path().join("b.ts");
    fs::write(&a, "Name").unwrap();
    fs::write(&b, "Name").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let snapshot = core
        .request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    let edit = |path: &std::path::Path| json!({"path":path,"fileHash":format!("{:x}",Sha256::digest(b"Name")),"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":4}},"newText":"Other"});
    let preview = core
        .request(
            "workspace.editPreview",
            json!({"workspaceGeneration":snapshot["generation"],"edits":[edit(&a),edit(&b)]}),
        )
        .unwrap();
    fs::write(&b, "changed").unwrap();
    assert!(core
        .request("workspace.editApply", json!({"id":preview["id"]}))
        .is_err());
    assert_eq!(
        core.request("document.open", json!({"path":a})).unwrap()["content"],
        "Name"
    );
    fs::write(&b, "Name").unwrap();
    let applied = core
        .request("workspace.editApply", json!({"id":preview["id"]}))
        .unwrap();
    assert_eq!(applied.as_array().unwrap().len(), 2);
    assert_eq!(fs::read_to_string(&a).unwrap(), "Name"); // explicit save remains required
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    for file in [a, b] {
        assert_eq!(
            core.request("document.open", json!({"path":file})).unwrap()["content"],
            "Other"
        );
    }
}

#[test]
fn user_excluded_directories_leave_the_index_and_persist_until_restored() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("vendor/lib")).unwrap();
    fs::write(root.path().join("vendor/lib/a.txt"), "needle").unwrap();
    fs::write(root.path().join("keep.txt"), "needle").unwrap();
    let paths = |workspace: &serde_json::Value| -> Vec<String> {
        workspace["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["relativePath"].as_str().unwrap().to_owned())
            .collect()
    };
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    for bad in ["", "../outside", "missing", "keep.txt"] {
        assert!(
            core.request("workspace.setExcluded", json!({"path":bad,"excluded":true}))
                .is_err(),
            "accepted {bad:?}"
        );
    }
    let excluded = core
        .request(
            "workspace.setExcluded",
            json!({"path":"vendor","excluded":true}),
        )
        .unwrap();
    assert_eq!(paths(&excluded), ["keep.txt"]);
    assert!(excluded["excludedDirectories"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["path"] == "vendor" && item["reason"] == "Excluded by you"));
    assert_eq!(
        core.request("workspace.search", json!({"query":"needle"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reopened = Core::new(data.path().to_owned())
        .unwrap()
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    assert_eq!(paths(&reopened), ["keep.txt"]);
    let restored = core
        .request(
            "workspace.setExcluded",
            json!({"path":"vendor","excluded":false}),
        )
        .unwrap();
    assert_eq!(paths(&restored), ["keep.txt", "vendor/lib/a.txt"]);
}
