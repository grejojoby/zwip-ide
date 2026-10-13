use ide_core::Core;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn target() -> (&'static str, &'static str) {
    (
        match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        },
        match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        },
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Core) {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    (data, workspace, core)
}
fn package(id: &str, version: &str, good: bool) -> tempfile::TempDir {
    let package = tempfile::tempdir().unwrap();
    let script = if good {
        r##"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s' "$line" > initialized.json
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ready":true}}\n' "$id"
      ;;
  esac
done
"##
    } else {
        "#!/bin/sh\nexit 17\n"
    };
    fs::write(package.path().join("worker.sh"), script).unwrap();
    let (platform, architecture) = target();
    fs::write(package.path().join("manifest.json"), json!({"id":id,"name":id,"version":version,"coreVersion":"^0.1.0","description":"fixture","platform":platform,"architecture":architecture,"capabilities":[],"languages":[id],"executable":"worker.sh","args":[],"checksums":{"worker.sh":digest(script.as_bytes())}}).to_string()).unwrap();
    package
}
fn feature() -> tempfile::TempDir {
    let package = tempfile::tempdir().unwrap();
    let content = b"{\"feature\":\"nextProjectPlugin\"}";
    fs::write(package.path().join("features.json"), content).unwrap();
    fs::write(package.path().join("manifest.json"), json!({"id":"react-next","name":"React / Next","version":"0.1.0","coreVersion":"^0.1.0","description":"fixture","kind":"feature","platform":"any","architecture":"any","dependencies":{"web":"^0.1.0"},"capabilities":["nextProjectPlugin"],"languages":[],"checksums":{"features.json":digest(content)}}).to_string()).unwrap();
    package
}
fn install(core: &Core, path: &Path) -> Result<Value, String> {
    core.request("package.install", json!({"path":path}))
}
fn entry(core: &Core, id: &str) -> Value {
    core.request("package.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .unwrap()
        .clone()
}

#[test]
fn enabled_upgrade_keeps_old_worker_on_failure_and_retains_previous_good_version() {
    let (_data, _workspace, core) = fixture();
    let first = package("web", "0.1.0", true);
    install(&core, first.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    assert_eq!(entry(&core, "web")["running"], true);
    let broken = package("web", "0.2.0", false);
    assert!(install(&core, broken.path()).is_err());
    let retained = entry(&core, "web");
    assert_eq!(retained["version"], "0.1.0");
    assert_eq!(retained["enabled"], true);
    assert_eq!(retained["running"], true);
    assert!(retained["error"].as_str().unwrap().contains("retained"));
    let second = package("web", "0.2.0", true);
    install(&core, second.path()).unwrap();
    assert_eq!(entry(&core, "web")["version"], "0.2.0");
    assert_eq!(entry(&core, "web")["rollbackAvailable"], true);
    core.request("package.rollback", json!({"id":"web"}))
        .unwrap();
    assert_eq!(entry(&core, "web")["version"], "0.1.0");
    assert_eq!(entry(&core, "web")["running"], true);
}

#[test]
fn declarative_features_require_enabled_compatible_dependencies_and_reinitialize_consumers() {
    let (_data, workspace, core) = fixture();
    let next = feature();
    assert!(install(&core, next.path())
        .unwrap_err()
        .contains("dependency web"));
    let web = package("web", "0.1.0", true);
    install(&core, web.path()).unwrap();
    install(&core, next.path()).unwrap();
    assert!(core
        .request("package.enable", json!({"id":"react-next","enabled":true}))
        .unwrap_err()
        .contains("Enable dependency"));
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    let http = package("http", "0.1.0", true);
    install(&core, http.path()).unwrap();
    core.request("package.enable", json!({"id":"http","enabled":true}))
        .unwrap();
    core.request("package.restart", json!({"id":"http"}))
        .unwrap();
    assert_eq!(entry(&core, "web")["running"], true);
    core.request("package.enable", json!({"id":"react-next","enabled":true}))
        .unwrap();
    assert_eq!(entry(&core, "web")["running"], false);
    assert_eq!(entry(&core, "http")["running"], true);
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    let initialized: Value =
        serde_json::from_slice(&fs::read(workspace.path().join("initialized.json")).unwrap())
            .unwrap();
    assert!(initialized["params"]["enabledPackages"]
        .as_array()
        .unwrap()
        .contains(&json!("react-next")));
    assert!(core
        .request("package.enable", json!({"id":"web","enabled":false}))
        .unwrap_err()
        .contains("dependent package"));
    let incompatible = package("web", "0.2.0", true);
    assert!(install(&core, incompatible.path())
        .unwrap_err()
        .contains("would break"));
    assert_eq!(entry(&core, "web")["version"], "0.1.0");
    let cycle = package("web", "0.1.1", true);
    let manifest_path = cycle.path().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["dependencies"] = json!({"react-next":"^0.1.0"});
    fs::write(manifest_path, manifest.to_string()).unwrap();
    assert!(install(&core, cycle.path())
        .unwrap_err()
        .contains("dependency cycle"));
}

#[test]
fn target_unchecked_assets_and_manifest_tampering_are_rejected() {
    let (data, _workspace, core) = fixture();
    let wrong = package("web", "0.1.0", true);
    let path = wrong.path().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["architecture"] = json!("different-architecture");
    fs::write(&path, manifest.to_string()).unwrap();
    assert!(install(&core, wrong.path())
        .unwrap_err()
        .contains("architecture"));
    let unchecked = package("web", "0.1.0", true);
    fs::write(unchecked.path().join("unlisted.js"), "unexpected").unwrap();
    assert!(install(&core, unchecked.path())
        .unwrap_err()
        .contains("unchecked"));
    let good = package("web", "0.1.0", true);
    install(&core, good.path()).unwrap();
    let installed = data.path().join("packages/web-0.1.0");
    fs::write(installed.join("worker.sh"), "#!/bin/sh\nexit 99\n").unwrap();
    assert!(core
        .request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap_err()
        .contains("checksum"));
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(installed.join("manifest.json")).unwrap()).unwrap();
    manifest["checksums"]["worker.sh"] = json!(digest(b"#!/bin/sh\nexit 99\n"));
    fs::write(installed.join("manifest.json"), manifest.to_string()).unwrap();
    assert!(core
        .request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap_err()
        .contains("manifest changed"));
    assert!(entry(&core, "web")["error"]
        .as_str()
        .unwrap()
        .contains("manifest changed"));
}

#[test]
fn catalog_configuration_requires_https_and_persists_without_network_on_list() {
    let (data, _workspace, core) = fixture();
    assert!(core
        .request(
            "package.catalogConfigure",
            json!({"url":"http://catalog.example.test/catalog.json"})
        )
        .unwrap_err()
        .contains("HTTPS"));
    assert!(core
        .request(
            "package.catalogConfigure",
            json!({"url":"https://user:secret@catalog.example.test/catalog.json"})
        )
        .is_err());
    core.request(
        "package.catalogConfigure",
        json!({"url":"https://catalog.example.test/catalog.json"}),
    )
    .unwrap();
    drop(core);
    let core = Core::new(data.path().to_owned()).unwrap();
    assert!(core.request("package.list", json!({})).is_ok());
    let db = rusqlite::Connection::open(data.path().join("packages.sqlite")).unwrap();
    let url: String = db
        .query_row(
            "SELECT value FROM package_settings WHERE key='catalog_url'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(url, "https://catalog.example.test/catalog.json");
}

fn slow_package() -> tempfile::TempDir {
    let package = package("web", "0.1.0", true);
    let script = r##"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf 'started\n' >> starting
      while [ ! -f release ]; do sleep 0.02; done
      ;;
    *'"method":"shutdown"'*) exit 0 ;;
  esac
  printf '{"jsonrpc":"2.0","id":%s,"result":{"ready":true}}\n' "$id"
done
"##;
    fs::write(package.path().join("worker.sh"), script).unwrap();
    let path = package.path().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["checksums"]["worker.sh"] = json!(digest(script.as_bytes()));
    fs::write(path, manifest.to_string()).unwrap();
    package
}
fn await_start(workspace: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !workspace.join("starting").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        workspace.join("starting").exists(),
        "Worker did not begin initialization"
    );
}
#[test]
fn startup_releases_host_lock_and_concurrent_requests_share_one_worker() {
    let (_data, workspace, core) = fixture();
    let package = slow_package();
    install(&core, package.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    let core = std::sync::Arc::new(core);
    let first_core = core.clone();
    let first = std::thread::spawn(move || {
        first_core.request(
            "tool.request",
            json!({"packageId":"web","method":"probe","params":{}}),
        )
    });
    await_start(workspace.path());
    let second_core = core.clone();
    let second = std::thread::spawn(move || {
        second_core.request(
            "tool.request",
            json!({"packageId":"web","method":"probe","params":{}}),
        )
    });
    let list_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let listing = std::thread::spawn(move || {
        let _ = send.send(list_core.request("package.list", json!({})));
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let first_result = first.join().unwrap();
    let second_result = second.join().unwrap();
    listing.join().unwrap();
    assert!(
        responsive.is_ok(),
        "Package list waited for slow worker initialization"
    );
    assert_eq!(first_result.unwrap()["ready"], true);
    assert_eq!(second_result.unwrap()["ready"], true);
    assert_eq!(
        fs::read_to_string(workspace.path().join("starting"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(entry(&core, "web")["running"], true);
}
#[test]
fn disabling_package_cancels_pending_startup_and_prevents_late_attachment() {
    let (_data, workspace, core) = fixture();
    let package = slow_package();
    install(&core, package.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    let core = std::sync::Arc::new(core);
    let start_core = core.clone();
    let starting = std::thread::spawn(move || {
        start_core.request(
            "tool.request",
            json!({"packageId":"web","method":"probe","params":{}}),
        )
    });
    await_start(workspace.path());
    let disable_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let disable = std::thread::spawn(move || {
        let _ =
            send.send(disable_core.request("package.enable", json!({"id":"web","enabled":false})));
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let start_result = starting.join().unwrap();
    disable.join().unwrap();
    assert!(responsive.is_ok(), "Disabling a package waited for startup");
    responsive.unwrap().unwrap();
    assert!(
        start_result.is_err(),
        "Canceled startup was attached after disabling the package"
    );
    assert_eq!(entry(&core, "web")["enabled"], false);
    assert_eq!(entry(&core, "web")["running"], false);
}

fn set_version(source: &Path, version: &str) {
    let path = source.join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["version"] = json!(version);
    fs::write(path, manifest.to_string()).unwrap();
}

fn live_web(core: &Core) {
    let source = responding_package("web", "web");
    install(core, source.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
}

#[test]
fn slow_upgrade_keeps_registry_and_previous_worker_responsive_until_acceptance() {
    let (_data, workspace, core) = fixture();
    live_web(&core);
    let replacement = slow_package();
    set_version(replacement.path(), "0.2.0");
    let core = std::sync::Arc::new(core);
    let install_core = core.clone();
    let upgrading = std::thread::spawn(move || install(&install_core, replacement.path()));
    await_start(workspace.path());
    let probe_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let probing = std::thread::spawn(move || {
        let listed = entry(&probe_core, "web");
        let response = probe_core.request(
            "tool.request",
            json!({"packageId":"web","method":"probe","params":{}}),
        );
        let _ = send.send((listed, response));
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let upgraded = upgrading.join().unwrap();
    probing.join().unwrap();
    let (during, probe) = responsive.expect("Upgrade initialization held the package host lock");
    assert_eq!(during["version"], "0.1.0");
    assert_eq!(during["running"], true);
    assert_eq!(probe.unwrap()["ready"], true);
    upgraded.unwrap();
    assert_eq!(entry(&core, "web")["version"], "0.2.0");
    assert_eq!(entry(&core, "web")["running"], true);
}

#[test]
fn slow_restart_keeps_previous_worker_responsive_until_acceptance() {
    let (_data, workspace, core) = fixture();
    let source = slow_package();
    install(&core, source.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    fs::write(workspace.path().join("release"), "").unwrap();
    core.request("package.restart", json!({"id":"web"}))
        .unwrap();
    fs::remove_file(workspace.path().join("release")).unwrap();
    fs::remove_file(workspace.path().join("starting")).unwrap();
    let core = std::sync::Arc::new(core);
    let restart_core = core.clone();
    let restarting =
        std::thread::spawn(move || restart_core.request("package.restart", json!({"id":"web"})));
    await_start(workspace.path());
    let probe_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let probing = std::thread::spawn(move || {
        let _ = send.send(probe_core.request(
            "tool.request",
            json!({"packageId":"web","method":"probe","params":{}}),
        ));
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let restarted = restarting.join().unwrap();
    probing.join().unwrap();
    assert_eq!(
        responsive
            .expect("Restart initialization blocked the previous worker")
            .unwrap()["ready"],
        true
    );
    restarted.unwrap();
    assert_eq!(entry(&core, "web")["running"], true);
}

#[test]
fn disabling_during_upgrade_cancels_candidate_and_removes_only_unaccepted_version() {
    let (data, workspace, core) = fixture();
    live_web(&core);
    let replacement = slow_package();
    set_version(replacement.path(), "0.2.0");
    let core = std::sync::Arc::new(core);
    let install_core = core.clone();
    let upgrading = std::thread::spawn(move || install(&install_core, replacement.path()));
    await_start(workspace.path());
    let disable_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let disabling = std::thread::spawn(move || {
        let _ =
            send.send(disable_core.request("package.enable", json!({"id":"web","enabled":false})));
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let upgraded = upgrading.join().unwrap();
    disabling.join().unwrap();
    responsive
        .expect("Disable waited for replacement initialization")
        .unwrap();
    assert!(
        upgraded.is_err(),
        "Canceled candidate replaced the disabled package"
    );
    assert_eq!(entry(&core, "web")["version"], "0.1.0");
    assert_eq!(entry(&core, "web")["enabled"], false);
    assert_eq!(entry(&core, "web")["running"], false);
    assert!(data.path().join("packages/web-0.1.0").exists());
    assert!(!data.path().join("packages/web-0.2.0").exists());
}

#[test]
fn workspace_change_during_restart_cancels_candidate_and_prevents_late_attachment() {
    let (_data, workspace, core) = fixture();
    let source = slow_package();
    install(&core, source.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    let core = std::sync::Arc::new(core);
    let restart_core = core.clone();
    let restarting =
        std::thread::spawn(move || restart_core.request("package.restart", json!({"id":"web"})));
    await_start(workspace.path());
    let next_workspace = tempfile::tempdir().unwrap();
    let open_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let opening = std::thread::spawn(move || {
        let _ =
            send.send(open_core.request("workspace.open", json!({"root":next_workspace.path()})));
        next_workspace
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_millis(500));
    fs::write(workspace.path().join("release"), "").unwrap();
    let restarted = restarting.join().unwrap();
    let _next_workspace = opening.join().unwrap();
    responsive
        .expect("Workspace replacement waited for candidate initialization")
        .unwrap();
    assert!(restarted.is_err());
    assert_eq!(entry(&core, "web")["running"], false);
}

#[test]
fn shutdown_cancels_replacement_initialization_without_waiting_for_its_timeout() {
    let (data, workspace, core) = fixture();
    live_web(&core);
    let replacement = slow_package();
    set_version(replacement.path(), "0.2.0");
    let core = std::sync::Arc::new(core);
    let install_core = core.clone();
    let upgrading = std::thread::spawn(move || install(&install_core, replacement.path()));
    await_start(workspace.path());
    let shutdown_core = core.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let stopping = std::thread::spawn(move || {
        shutdown_core.shutdown();
        let _ = send.send(());
    });
    let responsive = receive.recv_timeout(std::time::Duration::from_secs(3));
    fs::write(workspace.path().join("release"), "").unwrap();
    let upgraded = upgrading.join().unwrap();
    stopping.join().unwrap();
    responsive.expect("Shutdown waited for the 30-second replacement initialization timeout");
    assert!(upgraded.is_err());
    assert!(data.path().join("packages/web-0.1.0").exists());
    assert!(!data.path().join("packages/web-0.2.0").exists());
}

fn responding_package(id: &str, language: &str) -> tempfile::TempDir {
    let source = package(id, "0.1.0", true);
    let script = r##"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in *'"method":"shutdown"'*) exit 0 ;; esac
  printf '{"jsonrpc":"2.0","id":%s,"result":{"ready":true}}\n' "$id"
done
"##;
    fs::write(source.path().join("worker.sh"), script).unwrap();
    let path = source.path().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["checksums"]["worker.sh"] = json!(digest(script.as_bytes()));
    manifest["languages"] = json!([language]);
    manifest["documentExtensions"] = json!(["custom"]);
    manifest["discovery"] = json!([{
        "language":language,"documentExtensions":["custom"],
        "configGlobs":["custom.config"],"configurationGlobs":["custom.config"]
    }]);
    fs::write(path, manifest.to_string()).unwrap();
    source
}

#[test]
fn corrupt_unrelated_package_cannot_block_discovery_routing_or_disable() {
    let (data, workspace, core) = fixture();
    let broken = package("a-broken", "0.1.0", true);
    let healthy = responding_package("z-healthy", "custom");
    install(&core, broken.path()).unwrap();
    install(&core, healthy.path()).unwrap();
    core.request("package.enable", json!({"id":"a-broken","enabled":true}))
        .unwrap();
    fs::write(workspace.path().join("custom.config"), "{}").unwrap();
    fs::write(workspace.path().join("sample.custom"), "source").unwrap();
    // Neither malformed disk metadata nor its deleted executable may affect other packages.
    let damaged = data.path().join("packages/a-broken-0.1.0");
    fs::write(damaged.join("manifest.json"), "not a manifest").unwrap();
    fs::remove_file(damaged.join("worker.sh")).unwrap();
    core.request("package.enable", json!({"id":"z-healthy","enabled":true}))
        .unwrap();
    drop(core);

    let core = Core::new(data.path().to_owned()).unwrap();
    let opened = core
        .request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    assert!(opened["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|context| context["language"] == "custom"));
    assert_eq!(
        core.request(
            "tool.request",
            json!({"packageId":"custom","method":"probe","params":{}})
        )
        .unwrap()["ready"],
        true
    );
    core.request("workspace.rescan", json!({})).unwrap();
    assert_eq!(entry(&core, "z-healthy")["running"], true);
    core.request("workspace.rescan", json!({"reanalyze":true}))
        .unwrap();
    assert_eq!(entry(&core, "z-healthy")["running"], false);
    core.request(
        "tool.request",
        json!({"packageId":"custom","method":"probe","params":{}}),
    )
    .unwrap();
    assert!(entry(&core, "a-broken")["error"]
        .as_str()
        .unwrap()
        .contains("manifest changed"));
    assert_eq!(entry(&core, "a-broken")["version"], "0.1.0");
    core.request("package.enable", json!({"id":"a-broken","enabled":false}))
        .unwrap();
    assert_eq!(entry(&core, "a-broken")["enabled"], false);
    assert_eq!(entry(&core, "z-healthy")["running"], true);
}

#[test]
fn disable_uses_trusted_dependency_metadata_even_when_package_files_are_missing() {
    let (data, _workspace, core) = fixture();
    let web = package("web", "0.1.0", true);
    let next = feature();
    install(&core, web.path()).unwrap();
    install(&core, next.path()).unwrap();
    core.request("package.enable", json!({"id":"web","enabled":true}))
        .unwrap();
    core.request("package.enable", json!({"id":"react-next","enabled":true}))
        .unwrap();
    fs::remove_file(data.path().join("packages/web-0.1.0/manifest.json")).unwrap();
    fs::remove_file(data.path().join("packages/react-next-0.1.0/manifest.json")).unwrap();
    assert!(core
        .request("package.enable", json!({"id":"web","enabled":false}))
        .unwrap_err()
        .contains("dependent package react-next"));
    core.request("package.enable", json!({"id":"react-next","enabled":false}))
        .unwrap();
    core.request("package.enable", json!({"id":"web","enabled":false}))
        .unwrap();
    assert_eq!(entry(&core, "web")["enabled"], false);
    assert_eq!(entry(&core, "react-next")["enabled"], false);
}

#[test]
fn legacy_metadata_migration_quarantines_tampered_entries_without_trusting_them() {
    let (data, workspace, core) = fixture();
    let broken = package("a-broken", "0.1.0", true);
    let healthy = responding_package("z-healthy", "custom");
    install(&core, broken.path()).unwrap();
    install(&core, healthy.path()).unwrap();
    core.request("package.enable", json!({"id":"a-broken","enabled":true}))
        .unwrap();
    core.request("package.enable", json!({"id":"z-healthy","enabled":true}))
        .unwrap();
    drop(core);
    let db = rusqlite::Connection::open(data.path().join("packages.sqlite")).unwrap();
    db.execute("UPDATE packages SET manifest_json=NULL", [])
        .unwrap();
    // Simulate an older registry that never retained metadata, then alter the damaged
    // package to claim the healthy provider's language. Migration must not trust it.
    let path = data.path().join("packages/a-broken-0.1.0/manifest.json");
    let mut altered: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    altered["languages"] = json!(["custom"]);
    fs::write(path, altered.to_string()).unwrap();
    let core = Core::new(data.path().to_owned()).unwrap();
    core.request("workspace.open", json!({"root":workspace.path()}))
        .unwrap();
    assert_eq!(
        core.request(
            "tool.request",
            json!({"packageId":"custom","method":"probe","params":{}})
        )
        .unwrap()["ready"],
        true
    );
    let metadata: Option<String> = db
        .query_row(
            "SELECT manifest_json FROM packages WHERE id='a-broken'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(metadata.is_none());
    core.request("package.enable", json!({"id":"a-broken","enabled":false}))
        .unwrap();
    assert!(core
        .request("package.enable", json!({"id":"a-broken","enabled":true}))
        .unwrap_err()
        .contains("manifest changed"));
}

#[test]
fn invalid_discovery_rules_are_rejected_before_installation() {
    let (_data, _workspace, core) = fixture();
    let source = responding_package("custom", "custom");
    let path = source.path().join("manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    manifest["discovery"][0]["configGlobs"] = json!(["["]);
    fs::write(path, manifest.to_string()).unwrap();
    assert!(install(&core, source.path())
        .unwrap_err()
        .contains("discovery"));
    assert!(!core
        .request("package.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["id"] == "custom"));
}
