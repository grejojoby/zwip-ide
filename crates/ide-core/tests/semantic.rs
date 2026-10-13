#![cfg(unix)]
use ide_core::Core;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
fn provider_receives_only_owned_documents_even_with_dependency_and_other_language_tabs() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let dependency = tempfile::tempdir().unwrap();
    let script = r#"#!/usr/bin/python3
import sys,json,os,time
root=''
documents={}
for line in sys.stdin:
    message=json.loads(line); method=message['method']; params=message.get('params') or {}; result=None
    if method=='initialize': root=params['root']; result={'generation':params['generation']}
    elif method=='document.update':
        if not params['path'].startswith(root+'/') or not params['path'].endswith('.ts'):
            print(json.dumps({'id':message['id'],'error':'foreign overlay'}),flush=True); continue
        if params['path'] in documents and params['revision']<=documents[params['path']]:
            print(json.dumps({'id':message['id'],'error':'obsolete overlay'}),flush=True); continue
        documents[params['path']]=params['revision']; result={}
    elif method=='document.close': documents.pop(params['path'],None)
    elif method=='navigation.query':
        if params['id']=='stream':
            print(json.dumps({'jsonrpc':'2.0','method':'navigation.progress','params':{**params,'state':'loading','locations':[],'searchedContexts':1,'totalContexts':2,'reasons':[]}}),flush=True)
            time.sleep(0.4)
        result={**params,'state':'complete','locations':[],'searchedContexts':1,'totalContexts':1,'reasons':[]}
    elif method=='shutdown': break
    if 'id' in message: print(json.dumps({'id':message['id'],'result':result}),flush=True)
"#;
    fs::write(package.path().join("worker"), script).unwrap();
    fs::set_permissions(
        package.path().join("worker"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let manifest = json!({"id":"web","name":"Contract worker","description":"fixture","version":"0.1.0","coreVersion":"^0.1.0","platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"capabilities":["references"],"languages":["web"],"documentExtensions":["ts"],"executable":"worker","args":[],"checksums":{"worker":format!("{:x}",Sha256::digest(script))}});
    // Package architecture names follow Node/Tauri packaging conventions.
    let mut manifest = manifest;
    manifest["platform"] = json!(if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    });
    manifest["architecture"] = json!(if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    });
    fs::write(package.path().join("manifest.json"), manifest.to_string()).unwrap();
    let source = root.path().join("main.ts");
    let go = root.path().join("main.go");
    let outside = dependency.path().join("dependency.ts");
    fs::write(root.path().join("tsconfig.json"), "{}").unwrap();
    fs::write(&source, "export const value=1;").unwrap();
    fs::write(&go, "package main").unwrap();
    fs::write(&outside, "export const external=1;").unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("package.install", json!({"path":package.path()}))
        .unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    let snapshot = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    for path in [&source, &go, &outside] {
        core.request("document.open", json!({"path":path})).unwrap();
    }
    let query = |id: &str| json!({"query":{"id":id,"path":source,"operation":"references","position":{"line":0,"character":14},"documentRevision":1,"workspaceGeneration":snapshot["generation"]}});
    let result = core.request("navigation.query", query("first")).unwrap();
    assert_eq!(result["state"], "complete", "{result}");
    core.request("document.close", json!({"path":source,"revision":1}))
        .unwrap();
    core.request("document.open", json!({"path":source}))
        .unwrap();
    let result = core.request("navigation.query", query("reopened")).unwrap();
    assert_eq!(result["state"], "complete", "{result}");
    let mut external = query("external");
    external["query"]["path"] = json!(outside);
    let result = core.request("navigation.query", external).unwrap();
    assert_eq!(result["state"], "complete");
    assert_eq!(result["documentRevision"], 1);
    std::thread::scope(|scope| {
        let pending = scope.spawn(|| core.request("navigation.query", query("stream")));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let batch = core
                .request("navigation.progress", json!({"id":"stream"}))
                .unwrap();
            if !batch.is_null() {
                assert_eq!(batch["state"], "loading");
                assert_eq!(batch["searchedContexts"], 1);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "provider progress was not delivered"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // A consumer edit invalidates progress even when the source stays unchanged.
        core.request(
            "document.change",
            json!({"path":go,"revision":1,"changes":[{"from":12,"to":12,"insert":"\n"}]}),
        )
        .unwrap();
        assert!(core
            .request("navigation.progress", json!({"id":"stream"}))
            .unwrap()
            .is_null());
        assert_eq!(pending.join().unwrap().unwrap()["state"], "canceled");
    });
    assert!(core
        .request("navigation.progress", json!({"id":"stream"}))
        .unwrap()
        .is_null());
}
