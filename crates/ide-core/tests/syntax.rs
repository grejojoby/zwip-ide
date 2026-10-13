use ide_core::Core;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;

#[test]
fn syntax_requires_enabled_checked_assets_and_never_starts_a_worker() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let source = "export function createSyntax() { return []; }";
    fs::write(package.path().join("syntax.mjs"), source).unwrap();
    let manifest = json!({"id":"syntax-fixture","name":"Syntax","description":"test","version":"0.1.0","coreVersion":"^0.1.0","platform":"any","architecture":"any","kind":"feature","capabilities":[],"languages":[],"syntax":{"abi":1,"asset":"syntax.mjs","extensions":["demo"]},"checksums":{"syntax.mjs":format!("{:x}",Sha256::digest(source))}});
    fs::write(package.path().join("manifest.json"), manifest.to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("package.install", json!({"path":package.path()}))
        .unwrap();
    assert!(core
        .request("package.syntax", json!({"extension":"demo"}))
        .unwrap()
        .is_null());
    core.request(
        "package.enable",
        json!({"id":"syntax-fixture","enabled":true}),
    )
    .unwrap();
    let asset = core
        .request("package.syntax", json!({"extension":"demo"}))
        .unwrap();
    assert_eq!(asset["source"], source);
    assert_eq!(asset["abi"], 1);
    assert!(core
        .request("package.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["running"] == false));
    let installed = data.path().join("packages/syntax-fixture-0.1.0/syntax.mjs");
    assert!(installed.exists(), "{}", installed.display());
    fs::write(installed, "tampered").unwrap();
    assert!(core
        .request("package.syntax", json!({"extension":"demo"}))
        .unwrap_err()
        .contains("changed"));
    core.request(
        "package.enable",
        json!({"id":"syntax-fixture","enabled":false}),
    )
    .unwrap();
    assert!(core
        .request("package.syntax", json!({"extension":"demo"}))
        .unwrap()
        .is_null());
}
