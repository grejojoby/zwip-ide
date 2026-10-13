use ide_core::Core;
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};

struct Fixture {
    data: tempfile::TempDir,
    source: tempfile::TempDir,
    core: Core,
}
impl Fixture {
    fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let core = Core::new(data.path().into()).unwrap();
        Self { data, source, core }
    }
    fn write(&self, name: &str, text: &str) {
        let path = self.source.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn preview(&self, path: &str) -> Value {
        self.core
            .request(
                "intellij.preview",
                json!({"path":self.source.path().join(path)}),
            )
            .unwrap()
    }
    fn import(&self, path: &str, preview: &Value, ids: Vec<Value>) -> Result<Value, String> {
        self.core.request("intellij.importConnections",json!({"path":self.source.path().join(path),"fingerprint":preview["fingerprint"],"ids":ids}))
    }
}
fn ds(id: &str, name: &str, url: &str, extra: &str) -> String {
    let driver = if url.starts_with("jdbc:mysql:") {
        "mysql"
    } else if url.starts_with("jdbc:sqlite:") {
        "sqlite"
    } else if url.starts_with("jdbc:redis:") || url.starts_with("jdbc:rediss:") {
        "redis"
    } else {
        "postgresql"
    };
    format!("<data-source name='{name}' uuid='{id}'><driver-ref>{driver}</driver-ref><jdbc-url>{url}</jdbc-url>{extra}</data-source>")
}
fn xml(sources: &[String]) -> String {
    format!("<?xml version='1.0' encoding='UTF-8'?><project version='4'><component name='DataSourceManagerImpl'>{}</component></project>",sources.join(""))
}
fn candidate<'a>(preview: &'a Value, name: &str) -> &'a Value {
    preview["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == name)
        .unwrap()
}
fn zip(path: &Path, entries: &[(&str, &str)]) {
    let file = fs::File::create(path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    for (name, content) in entries {
        archive
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
}

#[test]
fn preview_imports_raw_keymaps_active_stock_and_appearance_without_writing_settings() {
    let f = Fixture::new();
    f.write("keymaps/Personal.xml","<keymap version='1' name='Personal' parent='Mac OS X 10.5+'><action id='GotoFile'><keyboard-shortcut first-keystroke='meta shift P'/><keyboard-shortcut first-keystroke='ctrl K' second-keystroke='ctrl C'/><mouse-shortcut keystroke='button1 doubleClick'/></action><action id='Empty'/></keymap>");
    f.write("options/keymap.xml","<application><component name='KeymapManager'><active_keymap name='Mac OS X 10.5+'/></component></application>");
    f.write("options/laf.xml","<application><component name='LafManager'><laf class-name='com.intellij.ide.ui.laf.darcula.DarculaLaf'/></component></application>");
    f.write(
        "options/other.xml",
        "not xml; unrelated config is never parsed",
    );
    let p = f.preview("");
    assert_eq!(p["keymaps"][0]["parent"], "Mac OS X 10.5+");
    assert_eq!(
        p["keymaps"][0]["actions"][0]["shortcuts"][1],
        json!({"first":"ctrl K","second":"ctrl C"})
    );
    assert_eq!(p["keymaps"][0]["actions"][0]["hasMouse"], true);
    assert_eq!(p["keymaps"][0]["actions"][1]["shortcuts"], json!([]));
    assert_eq!(p["activeKeymap"], "Mac OS X 10.5+");
    assert_eq!(p["appearance"]["dark"], true);
    assert_eq!(
        f.core.request("connection.list", json!({})).unwrap(),
        json!([])
    );
    assert_eq!(f.preview("")["fingerprint"], p["fingerprint"]);
    fs::remove_file(f.source.path().join("keymaps/Personal.xml")).unwrap();
    assert_eq!(f.preview("")["keymaps"], json!([]));
    assert_eq!(f.preview("")["activeKeymap"], "Mac OS X 10.5+");
}
#[test]
fn project_metadata_merges_by_uuid_and_preserves_secure_tls_without_secrets() {
    let f = Fixture::new();
    let original = xml(&[
        ds(
            "pg",
            "Postgres",
            "jdbc:postgresql://localhost:5433/app?sslmode=verify-full",
            "",
        ),
        ds(
            "mysql",
            "MySQL",
            "jdbc:mysql://127.0.0.1:3307/db?sslMode=VERIFY_IDENTITY",
            "",
        ),
        ds(
            "redis",
            "Redis",
            "jdbc:rediss://[::1]:6380/2",
            "<jdbc-driver>jdbc.RedisDriver</jdbc-driver>",
        ),
    ]);
    f.write(".idea/dataSources.xml", &original);
    f.write(".idea/dataSources.local.xml","<project><component name='dataSourceStorageLocal'><data-source uuid='pg'><user-name>demo</user-name><password>DO_NOT_TRANSFER_PASSWORD_839</password><auth-provider>user-pass</auth-provider><schema-mapping><introspection-scope><node kind='schema' qname='SECRET_SCHEMA'/></introspection-scope></schema-mapping></data-source></component></project>");
    let p = f.preview("");
    assert_eq!(p["connections"].as_array().unwrap().len(), 3);
    let pg = candidate(&p, "Postgres");
    assert_eq!(
        pg["connection"]["config"],
        json!({"host":"localhost","port":5433,"database":"app","username":"demo","tls":true})
    );
    assert_eq!(
        candidate(&p, "Redis")["connection"]["config"],
        json!({"host":"::1","port":6380,"database":"2","tls":true})
    );
    assert_eq!(candidate(&p, "MySQL")["connection"]["config"]["tls"], true);
    assert!(!p.to_string().contains("DO_NOT_TRANSFER"));
    assert!(!p.to_string().contains("SECRET_SCHEMA"));
    assert!(!p.to_string().contains("jdbc:"));
    let ids = p["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].clone())
        .collect();
    let result = f.import("", &p, ids).unwrap();
    assert_eq!(result["imported"], 3);
    assert_eq!(result["connections"].as_array().unwrap().len(), 3);
    assert_eq!(
        fs::read_to_string(f.source.path().join(".idea/dataSources.xml")).unwrap(),
        original
    );
    let db = fs::read(f.data.path().join("connections.sqlite")).unwrap();
    assert!(!String::from_utf8_lossy(&db).contains("DO_NOT_TRANSFER"));
    assert!(f
        .core
        .request("package.list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["running"] == false));
}
#[test]
fn selected_database_xml_reads_sibling_local_metadata_and_archive_matches() {
    let f = Fixture::new();
    let definitions = xml(&[ds("p", "Main", "jdbc:postgresql://localhost/db", "")]);
    let local="<project><component name='dataSourceStorageLocal'><data-source uuid='p'><user-name>reader</user-name></data-source></component></project>";
    f.write("dataSources.xml", &definitions);
    f.write("dataSources.local.xml", local);
    let p = f.preview("dataSources.xml");
    assert_eq!(
        p["connections"][0]["connection"]["config"]["username"],
        "reader"
    );
    zip(
        &f.source.path().join("settings.zip"),
        &[
            ("options/dataSources.xml", &definitions),
            ("options/dataSources.local.xml", local),
            ("options/security.xml", "<!DOCTYPE secret>"),
            ("dataSources.passwords.xml", "<!DOCTYPE password-store>"),
        ],
    );
    let z = f.preview("settings.zip");
    assert_eq!(z["connections"], p["connections"]);
    let result = f
        .import("settings.zip", &z, vec![z["connections"][0]["id"].clone()])
        .unwrap();
    assert_eq!(result["imported"], 1);
    assert_eq!(
        f.preview("dataSources.xml")["connections"][0]["status"],
        "duplicate"
    );
    assert!(f
        .import("settings.zip", &z, vec![z["connections"][0]["id"].clone()])
        .unwrap_err()
        .contains("already exists"));
}
#[test]
fn unsupported_security_and_url_options_never_leak_or_silently_downgrade() {
    let f = Fixture::new();
    let sources=vec![
 ds("cred","jdbc:postgresql://u:SECRET@host/db","jdbc:postgresql://u:SECRET@host/db",""),
 ds("param","Parameters","jdbc:mysql://host/db?password=QUERY_SECRET&amp;useSSL=false",""),
 ds("ssh","Tunnel","jdbc:postgresql://host/db","<ssh-config host='PRIVATE_SSH' password='SSH_SECRET'/>") ,
 ds("cert","Certificate","jdbc:postgresql://host/db","<ssl-config enabled='true'><client-key>PRIVATE_KEY</client-key></ssl-config>"),
 ds("auth","Cloud auth","jdbc:postgresql://host/db","<auth-provider>aws-iam</auth-provider>"),
 ds("authattr","Cloud attribute","jdbc:postgresql://host/db","<auth-provider type='AWS_SECRET'/>") ,
 ds("prop","Driver options","jdbc:postgresql://host/db","<driver-properties><property name='password' value='PROP_SECRET'/></driver-properties>"),
 ds("unknown","Other database","jdbc:oracle:thin:@PRIVATE_ORACLE:1521/db","")];
    f.write("dataSources.xml", &xml(&sources));
    let p = f.preview("dataSources.xml");
    for item in p["connections"].as_array().unwrap() {
        assert_eq!(item["status"], "unsupported");
        assert!(item.get("connection").is_none());
        assert!(!item["notes"].as_array().unwrap().is_empty());
    }
    let text = p.to_string();
    for marker in ["SECRET", "PRIVATE_", "jdbc:", "password=", "<ssl"] {
        assert!(!text.contains(marker), "marker {marker} leaked");
    }
    assert!(f
        .import(
            "dataSources.xml",
            &p,
            vec![p["connections"][0]["id"].clone()]
        )
        .is_err());
    assert_eq!(
        f.core.request("connection.list", json!({})).unwrap(),
        json!([])
    );
}
#[test]
fn sqlite_requires_explicit_project_root_and_fingerprints_its_resolution() {
    let f = Fixture::new();
    f.write(
        "dataSources.xml",
        &xml(&[ds(
            "sqlite",
            "Local SQLite",
            "jdbc:sqlite:$PROJECT_DIR$/db/app.sqlite",
            "",
        )]),
    );
    let p = f.preview("dataSources.xml");
    assert_eq!(p["connections"][0]["status"], "unsupported");
    let project = tempfile::tempdir().unwrap();
    let args = json!({"path":f.source.path().join("dataSources.xml"),"projectRoot":project.path()});
    let resolved = f.core.request("intellij.preview", args.clone()).unwrap();
    assert_eq!(
        resolved["connections"][0]["connection"]["config"]["path"],
        json!(fs::canonicalize(project.path())
            .unwrap()
            .join("db/app.sqlite"))
    );
    assert_ne!(resolved["fingerprint"], p["fingerprint"]);
    let mut apply = args;
    apply["ids"] = json!([resolved["connections"][0]["id"]]);
    apply["fingerprint"] = resolved["fingerprint"].clone();
    assert_eq!(
        f.core.request("intellij.importConnections", apply).unwrap()["imported"],
        1
    );
    assert!(!project.path().join("db").exists());
}
#[test]
fn stale_duplicate_and_mixed_selections_preserve_every_existing_connection() {
    let f = Fixture::new();
    let first = ds("one", "First", "jdbc:postgresql://host/first", "");
    let second = ds("two", "Second", "jdbc:postgresql://host/second", "");
    f.write("dataSources.xml", &xml(&[first.clone(), second.clone()]));
    let p = f.preview("dataSources.xml");
    let ids: Vec<_> = p["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    f.write("dataSources.xml", &xml(std::slice::from_ref(&first)));
    assert!(f
        .import("dataSources.xml", &p, ids.clone())
        .unwrap_err()
        .contains("changed"));
    assert_eq!(
        f.core.request("connection.list", json!({})).unwrap(),
        json!([])
    );
    f.write("dataSources.xml", &xml(&[first, second]));
    f.core.request("connection.save",json!({"id":"existing","kind":"postgres","name":"Keep my name","config":{"host":"HOST","database":"second","port":5432,"tls":true}})).unwrap();
    assert!(f
        .import("dataSources.xml", &p, ids)
        .unwrap_err()
        .contains("already exists"));
    let listed = f.core.request("connection.list", json!({})).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "Keep my name");
    let current = f.preview("dataSources.xml");
    assert_eq!(candidate(&current, "Second")["status"], "duplicate");
    let first_id = candidate(&current, "First")["id"].clone();
    assert!(f
        .import(
            "dataSources.xml",
            &current,
            vec![first_id.clone(), json!("forged-id")]
        )
        .is_err());
    assert_eq!(
        f.import("dataSources.xml", &current, vec![first_id])
            .unwrap()["imported"],
        1
    );
}
#[test]
fn sqlite_transaction_rolls_back_prior_rows_on_insert_failure() {
    let f = Fixture::new();
    f.write(
        "dataSources.xml",
        &xml(&[
            ds("a", "First", "jdbc:postgresql://host/a", ""),
            ds("b", "Second", "jdbc:postgresql://host/b", ""),
        ]),
    );
    let p = f.preview("dataSources.xml");
    let database = rusqlite::Connection::open(f.data.path().join("connections.sqlite")).unwrap();
    database.execute_batch("CREATE TRIGGER block_second BEFORE INSERT ON connections WHEN NEW.name='Second' BEGIN SELECT RAISE(ABORT,'do not leak SQLITE_SECRET'); END;").unwrap();
    let ids = p["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].clone())
        .collect();
    let error = f.import("dataSources.xml", &p, ids).unwrap_err();
    assert!(!error.contains("SQLITE_SECRET"));
    assert_eq!(
        f.core.request("connection.list", json!({})).unwrap(),
        json!([])
    );
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM connection_imports", [], |row| row
                .get::<_, i32>(0))
            .unwrap(),
        0
    );
}
#[test]
fn malformed_dtd_oversized_and_unsafe_archives_fail_without_source_details() {
    let f = Fixture::new();
    for content in ["<keymap name='PRIVATE_NAME'><action>","<!DOCTYPE project [<!ENTITY leak SYSTEM 'file:///PRIVATE_SECRET'>]><project>&leak;</project>","<keymap name='x'>&unknown;</keymap>","<project/><project/>"]{f.write("bad.xml",content);let error=f.core.request("intellij.preview",json!({"path":f.source.path().join("bad.xml")})).unwrap_err();assert!(!error.contains("PRIVATE"));}
    f.write("large.xml", &" ".repeat(2 * 1024 * 1024 + 1));
    assert!(f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path().join("large.xml")})
        )
        .unwrap_err()
        .contains("size"));
    for name in [
        "../options/keymap.xml",
        "/options/keymap.xml",
        "options/../keymap.xml",
        "options\\keymap.xml",
    ] {
        zip(
            &f.source.path().join("bad.zip"),
            &[(name, "<application/>")],
        );
        assert!(f
            .core
            .request(
                "intellij.preview",
                json!({"path":f.source.path().join("bad.zip")})
            )
            .unwrap_err()
            .contains("path"));
    }
    fs::write(f.source.path().join("bad.zip"), b"not a zip").unwrap();
    assert!(f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path().join("bad.zip")})
        )
        .is_err());
}
#[cfg(unix)]
#[test]
fn filesystem_and_zip_symlinks_are_rejected_without_reading_targets() {
    let f = Fixture::new();
    let secret = tempfile::tempdir().unwrap();
    fs::write(secret.path().join("target"), "PRIVATE_PASSWORD_STORE").unwrap();
    std::os::unix::fs::symlink(
        secret.path().join("target"),
        f.source.path().join("dataSources.xml"),
    )
    .unwrap();
    let error = f
        .core
        .request("intellij.preview", json!({"path":f.source.path()}))
        .unwrap_err();
    assert!(error.contains("symbolic"));
    assert!(!error.contains("PRIVATE"));
    let path = f.source.path().join("links.zip");
    let mut archive = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    archive
        .add_symlink(
            "options/keymap.xml",
            "/PRIVATE_PASSWORD_STORE",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    archive.finish().unwrap();
    let error = f
        .core
        .request("intellij.preview", json!({"path":path}))
        .unwrap_err();
    assert!(error.contains("symbolic"));
    assert!(!error.contains("PRIVATE"));
}

#[test]
fn direct_keymap_and_options_folders_are_supported() {
    let f = Fixture::new();
    f.write("keymaps/One.xml","<keymap name='One' parent='Mac OS X 10.5+'><action id='GotoFile'><keyboard-shortcut first-keystroke='meta P'/></action></keymap>");
    f.write("options/keymap.xml","<application><component name='KeymapManager'><active_keymap name='One'/></component></application>");
    assert_eq!(f.preview("keymaps")["keymaps"][0]["name"], "One");
    assert_eq!(f.preview("options")["activeKeymap"], "One");
}
#[test]
fn implicit_jdbc_tls_import_is_verified_and_has_an_explicit_review_note() {
    let f = Fixture::new();
    f.write(
        "dataSources.xml",
        &xml(&[
            ds("a", "Default", "jdbc:postgresql://host/db", ""),
            ds(
                "b",
                "Explicit plain",
                "jdbc:mysql://host/db?sslMode=DISABLED",
                "",
            ),
            ds(
                "c",
                "Unverified TLS",
                "jdbc:postgresql://host/db?sslmode=require",
                "",
            ),
        ]),
    );
    let p = f.preview("dataSources.xml");
    assert_eq!(
        candidate(&p, "Default")["connection"]["config"]["tls"],
        true
    );
    assert!(candidate(&p, "Default")["notes"]
        .to_string()
        .contains("requires verified TLS"));
    assert_eq!(
        candidate(&p, "Explicit plain")["connection"]["config"]["tls"],
        false
    );
    assert_eq!(candidate(&p, "Unverified TLS")["status"], "unsupported");
}
#[test]
fn go_import_path_packages_resolve_through_the_working_directory_module() {
    let f = Fixture::new();
    f.write("svc/go.mod", "module svc\n\ngo 1.25\n");
    f.write("svc/cmd/api/main.go", "package main\n");
    // Configurations without Go fields must not affect package resolution.
    f.write(".run/Web.run.xml", "<component name='ProjectRunConfigurationManager'><configuration name='Web' type='js.build_tools.npm'><command value='run'/></configuration></component>");
    f.write(".idea/runConfigurations/Go.xml","<component name='ProjectRunConfigurationManager'><configuration name='Nested' type='GoApplicationRunConfiguration'><working_directory value='$PROJECT_DIR$/svc'/><kind value='PACKAGE'/><package value='svc/cmd/api'/><directory value='$PROJECT_DIR$'/><filePath value='$PROJECT_DIR$'/></configuration><configuration name='From root' type='GoApplicationRunConfiguration'><working_directory value='$PROJECT_DIR$'/><kind value='PACKAGE'/><package value='svc'/></configuration><configuration name='Missing' type='GoApplicationRunConfiguration'><working_directory value='$PROJECT_DIR$/svc'/><kind value='PACKAGE'/><package value='svc/nope'/></configuration></component>");
    let preview = f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path(),"projectRoot":f.source.path()}),
        )
        .unwrap();
    let field = |name: &str| {
        preview["runConfigurations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()["fields"]["packageDirectory"]
            .clone()
    };
    assert_eq!(field("Nested"), "$PROJECT_DIR$/svc/cmd/api");
    // The root has no go.mod; like IntelliJ, the module declaring the package is found instead.
    assert_eq!(field("From root"), "$PROJECT_DIR$/svc");
    let module = |name: &str| {
        preview["runConfigurations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()["fields"]["packageModule"]
            .clone()
    };
    assert_eq!(module("Nested"), "$PROJECT_DIR$/svc");
    assert_eq!(module("From root"), "$PROJECT_DIR$/svc");
    assert_eq!(field("Missing"), Value::Null);
}
#[test]
fn makefile_targets_import_their_file_target_arguments_and_environment() {
    let f = Fixture::new();
    f.write(".idea/runConfigurations/Make.xml","<component name='ProjectRunConfigurationManager'><configuration name='dev-all' type='MAKEFILE_TARGET_RUN_CONFIGURATION' factoryName='Makefile'><makefile filename='$PROJECT_DIR$/Makefile' target='dev-all' workingDirectory='' arguments='-j4'><envs><env name='SETUP' value='c21'/></envs></makefile><method v='2'/></configuration><configuration name='odd' type='MAKEFILE_TARGET_RUN_CONFIGURATION'><makefile filename='$PROJECT_DIR$/Makefile' target='x' sudo='true'/></configuration></component>");
    let preview = f.preview("");
    let rows = preview["runConfigurations"].as_array().unwrap();
    let make = rows.iter().find(|row| row["name"] == "dev-all").unwrap();
    assert_eq!(make["status"], "ready");
    assert_eq!(
        make["fields"],
        json!({"makefile":"$PROJECT_DIR$/Makefile","target":"dev-all","programParameters":"-j4","env":[{"name":"SETUP","value":"c21","sensitive":false}]})
    );
    let odd = rows.iter().find(|row| row["name"] == "odd").unwrap();
    assert_eq!(odd["status"], "unsupported");
}
#[test]
fn run_environment_imports_plain_values_and_withholds_credentials_until_revealed() {
    let f = Fixture::new();
    f.write(".idea/runConfigurations/App.xml","<component name='ProjectRunConfigurationManager'><configuration name='Go env' type='GoApplicationRunConfiguration'><working_directory value='$PROJECT_DIR$'/><envs><env name='SETUP' value='c21-or'/><env name='DB_PASSWORD' value='PLAIN_SECRET'/><env name='DSN' value='postgres://u:URL_SECRET@db/app'/><env name='EMPTY'/></envs><kind value='PACKAGE'/><package value='.'/><method v='2'/></configuration><configuration name='Env file' type='GoApplicationRunConfiguration'><env-file value='.env'/></configuration></component>");
    let preview = f.preview("");
    let rows = preview["runConfigurations"].as_array().unwrap();
    let app = rows.iter().find(|row| row["name"] == "Go env").unwrap();
    assert_eq!(app["status"], "ready");
    assert_eq!(
        app["fields"]["env"],
        json!([
            {"name":"SETUP","value":"c21-or","sensitive":false},
            {"name":"DB_PASSWORD","value":null,"sensitive":true},
            {"name":"DSN","value":null,"sensitive":true},
            {"name":"EMPTY","value":"","sensitive":false},
        ])
    );
    assert!(!preview.to_string().contains("SECRET"));
    let file = rows.iter().find(|row| row["name"] == "Env file").unwrap();
    assert_eq!(file["status"], "unsupported");
    let revealed = f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path(),"revealEnvironment":true}),
        )
        .unwrap();
    let env = &revealed["runConfigurations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["name"] == "Go env")
        .unwrap()["fields"]["env"];
    assert_eq!(env[1]["value"], "PLAIN_SECRET");
    assert_eq!(env[2]["value"], "postgres://u:URL_SECRET@db/app");
    // Revealing values does not change what the user reviewed.
    assert_eq!(revealed["fingerprint"], preview["fingerprint"]);
}
#[test]
fn project_run_sources_expose_only_known_fields_and_never_environment_secrets() {
    let f = Fixture::new();
    let npm="<component name='ProjectRunConfigurationManager'><configuration name='Frontend' type='js.build_tools.npm' factoryName='npm'><package-json value='$PROJECT_DIR$/web/package.json'/><command value='run'/><scripts><script value='dev'/></scripts><node-interpreter value='project'/><envs/><method v='2'/></configuration></component>";
    f.write(".run/Frontend.run.xml", npm);
    f.write(".idea/runConfigurations/App.xml","<component name='ProjectRunConfigurationManager'><configuration name='Go app' type='GoApplicationRunConfiguration'><working_directory value='$PROJECT_DIR$'/><kind value='DIRECTORY'/><directory value='$PROJECT_DIR$/cmd/server'/><parameters value='--port 3000'/><method v='2'/></configuration></component>");
    f.write(".idea/workspace.xml","<project><component name='PasswordStore'><configuration name='PRIVATE_WORKSPACE' type='js.build_tools.npm'/></component><component name='RunManager'><configuration default='true' type='GoApplicationRunConfiguration'/><configuration name='Env config' type='GoApplicationRunConfiguration'><envs><env name='TOKEN' value='ENV_SECRET_VALUE'/></envs></configuration><configuration name='Credential args' type='GoApplicationRunConfiguration'><parameters value='--password ARG_SECRET'/></configuration><configuration name='Custom auth' type='Remote'><option name='password' value='REMOTE_SECRET'/></configuration><configuration name='Before launch' type='js.build_tools.npm'><method v='2'><option name='RunAnotherConfiguration' value='TASK_SECRET'/></method></configuration></component></project>");
    let p = f.preview("");
    let rows = p["runConfigurations"].as_array().unwrap();
    assert_eq!(rows.len(), 6);
    let frontend = rows.iter().find(|row| row["name"] == "Frontend").unwrap();
    assert_eq!(frontend["status"], "ready");
    assert_eq!(frontend["fields"]["scripts"], json!(["dev"]));
    assert_eq!(
        frontend["fields"]["packageJson"],
        "$PROJECT_DIR$/web/package.json"
    );
    let app = rows.iter().find(|row| row["name"] == "Go app").unwrap();
    assert_eq!(app["fields"]["programParameters"], "--port 3000");
    for row in rows.iter().filter(|row| row["status"] == "unsupported") {
        assert_eq!(row["fields"], json!({}));
    }
    for secret in [
        "PRIVATE_WORKSPACE",
        "ENV_SECRET",
        "ARG_SECRET",
        "REMOTE_SECRET",
        "TASK_SECRET",
    ] {
        assert!(!p.to_string().contains(secret));
    }
    assert_eq!(
        f.preview(".run")["runConfigurations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.preview(".idea/runConfigurations")["runConfigurations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.preview(".idea")["runConfigurations"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        f.preview(".run/Frontend.run.xml")["runConfigurations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[cfg(unix)]
#[test]
fn selected_paths_with_user_symlink_ancestors_are_rejected() {
    let f = Fixture::new();
    f.write(
        "real/dataSources.xml",
        &xml(&[ds("a", "A", "jdbc:postgresql://host/db", "")]),
    );
    std::os::unix::fs::symlink(f.source.path().join("real"), f.source.path().join("alias"))
        .unwrap();
    assert!(f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path().join("alias/dataSources.xml")})
        )
        .unwrap_err()
        .contains("symbolic"));
}

#[test]
fn conflicting_driver_and_relative_sqlite_working_directory_remain_nonimportable() {
    let f = Fixture::new();
    f.write(
        "dataSources.xml",
        &xml(&[
            ds(
                "custom",
                "Custom driver",
                "jdbc:postgresql://host/db",
                "<jdbc-driver>PRIVATE_CUSTOM_DRIVER</jdbc-driver>",
            ),
            ds(
                "sqlite",
                "Relative SQLite",
                "jdbc:sqlite:app.sqlite",
                "<working-dir>$PROJECT_DIR$/elsewhere</working-dir>",
            ),
        ]),
    );
    let project = tempfile::tempdir().unwrap();
    let p = f
        .core
        .request(
            "intellij.preview",
            json!({"path":f.source.path().join("dataSources.xml"),"projectRoot":project.path()}),
        )
        .unwrap();
    assert!(p["connections"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["status"] == "unsupported"));
    assert!(!p.to_string().contains("PRIVATE_CUSTOM_DRIVER"));
}
