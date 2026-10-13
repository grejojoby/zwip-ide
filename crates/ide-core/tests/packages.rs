use ide_core::Core;
use serde_json::json;
use std::fs;

#[test]
fn installed_package_can_contribute_project_discovery_without_core_language_code() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    fs::write(root.path().join("project.demo"), "config").unwrap();
    fs::write(root.path().join("hello.demo"), "source").unwrap();
    fs::write(package.path().join("manifest.json"),json!({"id":"demo","name":"Demo","description":"test","version":"0.1.0","coreVersion":"^0.1.0","platform":if cfg!(target_os="macos"){"darwin"}else{"linux"},"architecture":if cfg!(target_arch="aarch64"){"arm64"}else{"x64"},"kind":"feature","capabilities":[],"languages":["demo"],"documentExtensions":["demo"],"discovery":[{"language":"demo","documentExtensions":["demo"],"configGlobs":["project.demo"],"configurationGlobs":["project.demo"]}],"checksums":{}}).to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("package.install", json!({"path":package.path()}))
        .unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    assert_eq!(workspace["contexts"][0]["language"], "demo");
    assert_eq!(workspace["contexts"][0]["id"], "project.demo");
}

#[test]
fn unavailable_semantics_are_never_reported_as_complete_empty_results() {
    let root = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let file = root.path().join("main.go");
    fs::write(&file, "package main\nfunc main() {}\n").unwrap();
    fs::write(
        root.path().join("go.mod"),
        "module example.test/main\ngo 1.25.0\n",
    )
    .unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let workspace = core
        .request("workspace.open", json!({"root":root.path()}))
        .unwrap();
    core.request("document.open", json!({"path":file})).unwrap();
    let result = core.request("navigation.query",json!({"query":{"id":"q","operation":"references","path":file,"position":{"line":1,"character":6},"documentRevision":1,"workspaceGeneration":workspace["generation"]}})).unwrap();
    assert_eq!(result["state"], "unsupported");
    assert!(!result["reasons"].as_array().unwrap().is_empty());
}

#[test]
fn package_install_rejects_traversal_before_launch() {
    let data = tempfile::tempdir().unwrap();
    let package = tempfile::tempdir().unwrap();
    fs::write(package.path().join("manifest.json"),json!({"id":"go","name":"Go","version":"0.1.0","coreVersion":"^0.1.0","description":"test","capabilities":[],"languages":["go"],"executable":"../escape","args":[],"checksums":{"../escape":"invalid"}}).to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    let error = core
        .request("package.install", json!({"path":package.path()}))
        .unwrap_err();
    assert!(error.contains("relative"), "{error}");
    let packages = core.request("package.list", json!({})).unwrap();
    assert!(packages
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["installed"] == false));
}
