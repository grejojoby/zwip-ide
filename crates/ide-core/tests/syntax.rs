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

#[test]
fn syntax_matches_declared_file_names_for_extensionless_files() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let source = "export function createSyntax() { return []; }";
    fs::write(package.path().join("syntax.mjs"), source).unwrap();
    let manifest = json!({"id":"make-fixture","name":"Make","description":"test","version":"0.1.0","coreVersion":"^0.1.0","platform":"any","architecture":"any","kind":"feature","capabilities":[],"languages":["makefile"],"syntax":{"abi":1,"asset":"syntax.mjs","extensions":["mk"],"fileNames":["Makefile","GNUmakefile"]},"checksums":{"syntax.mjs":format!("{:x}",Sha256::digest(source))}});
    fs::write(package.path().join("manifest.json"), manifest.to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("package.install", json!({"path":package.path()}))
        .unwrap();
    core.request(
        "package.enable",
        json!({"id":"make-fixture","enabled":true}),
    )
    .unwrap();
    let lookup = |extension: &str, file_name: &str| {
        core.request(
            "package.syntax",
            json!({"extension":extension,"fileName":file_name}),
        )
        .unwrap()
    };
    assert_eq!(lookup("", "Makefile")["source"], source);
    assert_eq!(lookup("mk", "rules.mk")["source"], source);
    assert!(lookup("", "Dockerfile").is_null());
    // Requests without a file name keep the extension-only contract.
    assert!(core
        .request("package.syntax", json!({"extension":""}))
        .unwrap()
        .is_null());
}

#[test]
fn syntax_file_names_must_be_plain_names() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    let source = "export function createSyntax() { return []; }";
    fs::write(package.path().join("syntax.mjs"), source).unwrap();
    let manifest = json!({"id":"bad-fixture","name":"Bad","description":"test","version":"0.1.0","coreVersion":"^0.1.0","platform":"any","architecture":"any","kind":"feature","capabilities":[],"languages":[],"syntax":{"abi":1,"asset":"syntax.mjs","fileNames":["../Makefile"]},"checksums":{"syntax.mjs":format!("{:x}",Sha256::digest(source))}});
    fs::write(package.path().join("manifest.json"), manifest.to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    assert!(core
        .request("package.install", json!({"path":package.path()}))
        .unwrap_err()
        .contains("file names"));
}
