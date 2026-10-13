//! Bounded, read-only import of selected IntelliJ settings. Never reads a password store.
use crate::connections::{Connections, ImportConnection};
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_TOTAL: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 128;
const XML_ERROR: &str = "Invalid or unsupported settings XML; no settings were imported";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    source: String,
    pub fingerprint: String,
    keymaps: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_keymap: Option<String>,
    connections: Vec<Candidate>,
    run_configurations: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    appearance: Option<Value>,
    notices: Vec<String>,
}
#[derive(Serialize)]
struct Candidate {
    id: String,
    name: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection: Option<Value>,
    notes: Vec<String>,
    #[serde(skip)]
    identity: String,
}
impl Candidate {
    fn import(&self) -> Option<ImportConnection> {
        self.connection.clone().map(|connection| ImportConnection {
            identity: self.identity.clone(),
            connection,
        })
    }
}
impl Preview {
    pub fn check_duplicates(&mut self, connections: &Connections) -> Result<(), String> {
        let mut endpoints = HashSet::new();
        for candidate in &mut self.connections {
            if let Some(item) = candidate.import() {
                let key = crate::connections::endpoint(&item.connection);
                if connections.import_duplicate(&item)? || !endpoints.insert(key) {
                    candidate.status = "duplicate".into();
                    candidate.notes.push(
                        "This connection is already present or repeated in the selected source."
                            .into(),
                    );
                }
            }
        }
        Ok(())
    }
    pub fn select(&self, ids: &Value) -> Result<Vec<ImportConnection>, String> {
        let ids = ids
            .as_array()
            .ok_or("Select connections from the preview")?;
        if ids.is_empty() || ids.len() > MAX_FILES {
            return Err("Select between one and 128 connections".into());
        }
        let mut seen = HashSet::new();
        let mut selected = Vec::new();
        for id in ids {
            let id = id.as_str().ok_or("Invalid connection selection")?;
            if !seen.insert(id) {
                return Err("A connection was selected more than once".into());
            }
            let candidate = self
                .connections
                .iter()
                .find(|candidate| candidate.id == id)
                .ok_or("Connection selection is no longer available")?;
            if candidate.status != "ready" {
                return Err("A selected connection cannot be imported; review its notes".into());
            }
            selected.push(candidate.import().ok_or("Connection is not importable")?);
        }
        Ok(selected)
    }
}

#[derive(Default, Clone)]
struct Node {
    name: String,
    attrs: BTreeMap<String, String>,
    text: String,
    children: Vec<Node>,
}
impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|node| node.name == name)
    }
    fn value(&self, name: &str) -> Option<&str> {
        self.child(name).map(|node| node.text.trim())
    }
    fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        if self.name == name {
            out.push(self);
        }
        for child in &self.children {
            child.descendants(name, out);
        }
    }
}
fn parse(bytes: &[u8]) -> Result<Node, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| XML_ERROR)?;
    let mut reader = Reader::from_str(text);
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        let event = reader.read_event().map_err(|_| XML_ERROR)?;
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                count += 1;
                if count > 50_000 || stack.len() > 32 {
                    return Err("Settings XML exceeds parsing limits".into());
                }
                let mut node = Node {
                    name: start.name().as_ref().into(),
                    ..Node::default()
                };
                for attr in start.attributes() {
                    let attr = attr.map_err(|_| XML_ERROR)?;
                    let name = attr.key.as_ref().to_owned();
                    let value = attr
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|_| XML_ERROR)?
                        .into_owned();
                    if value.len() > 65_536 || node.attrs.len() > 128 {
                        return Err("Settings XML exceeds parsing limits".into());
                    }
                    node.attrs.insert(name, value);
                }
                if matches!(event, Event::Empty(_)) {
                    stack.last_mut().unwrap().children.push(node);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err(XML_ERROR.into());
                }
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::Text(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.xml10_content()),
            Event::CData(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.xml10_content()),
            Event::GeneralRef(reference) => {
                let value = format!("&{};", reference.xml10_content());
                stack
                    .last_mut()
                    .unwrap()
                    .text
                    .push_str(&quick_xml::escape::unescape(&value).map_err(|_| XML_ERROR)?);
            }
            Event::DocType(_) => {
                return Err(
                    "DTD and entity declarations are not supported in settings imports".into(),
                )
            }
            Event::Eof => break,
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) => {}
        }
    }
    if stack.len() != 1 {
        return Err(XML_ERROR.into());
    }
    let mut document = stack.pop().unwrap();
    if document.children.len() != 1 || !document.text.trim().is_empty() {
        return Err(XML_ERROR.into());
    }
    Ok(document.children.remove(0))
}

fn data_name(name: &str) -> bool {
    matches!(name, "dataSources.xml" | "dataSources.local.xml")
}
fn allowed(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    match parts.as_slice() {
        [file] => data_name(file),
        ["keymaps", file] => file.ends_with(".xml"),
        ["options", file] => matches!(*file, "keymap.xml" | "laf.xml") || data_name(file),
        [".idea", file] => data_name(file) || *file == "workspace.xml",
        [".run", file] => file.ends_with(".run.xml"),
        ["runConfigurations", file] | [".idea", "runConfigurations", file] => {
            file.ends_with(".xml")
        }
        _ => false,
    }
}
fn no_symlinks(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let meta = fs::symlink_metadata(&current)
            .map_err(|_| "Cannot read the selected settings source")?;
        if meta.file_type().is_symlink() {
            // macOS exposes temporary directories through these system aliases.
            let system_alias = match current.to_str() {
                Some("/tmp") => Some(Path::new("/private/tmp")),
                Some("/var") => Some(Path::new("/private/var")),
                Some("/etc") => Some(Path::new("/private/etc")),
                _ => None,
            };
            if system_alias
                .is_none_or(|target| fs::canonicalize(&current).ok().as_deref() != Some(target))
            {
                return Err("Settings imports do not follow symbolic links".into());
            }
        }
    }
    Ok(())
}
fn bounded_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    no_symlinks(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "Cannot read the selected settings file")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect the selected settings file")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Settings source is not a regular file or exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read settings source")?;
    if bytes.len() as u64 > limit {
        return Err("Settings source exceeds its size limit".into());
    }
    Ok(bytes)
}
fn add_file(
    files: &mut BTreeMap<String, Vec<u8>>,
    name: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if files.len() >= MAX_FILES
        || files.values().map(Vec::len).sum::<usize>() + bytes.len() > MAX_TOTAL
    {
        return Err("Settings import exceeds its file or size limit".into());
    }
    if files.insert(name, bytes).is_some() {
        return Err("Settings source contains duplicate files".into());
    }
    Ok(())
}
fn directory_files(base: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    for sub in [
        "",
        "options",
        "keymaps",
        ".idea",
        ".run",
        "runConfigurations",
        ".idea/runConfigurations",
    ] {
        let directory = base.join(sub);
        if !directory
            .try_exists()
            .map_err(|_| "Cannot inspect settings folder")?
        {
            continue;
        }
        no_symlinks(&directory)?;
        let mut count = 0;
        for entry in fs::read_dir(&directory).map_err(|_| "Cannot read settings folder")? {
            count += 1;
            if count > 5000 {
                return Err("Settings folder contains too many entries".into());
            }
            let entry = entry.map_err(|_| "Cannot inspect settings folder")?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Settings filename is not valid UTF-8")?;
            let relative = if sub.is_empty() {
                match base.file_name().and_then(|s| s.to_str()) {
                    Some("keymaps" | "options" | ".idea" | ".run" | "runConfigurations") => {
                        format!("{}/{}", base.file_name().unwrap().to_string_lossy(), name)
                    }
                    _ => name,
                }
            } else {
                format!("{sub}/{name}")
            };
            if allowed(&relative) {
                add_file(files, relative, bounded_file(&entry.path(), MAX_FILE)?)?;
            }
        }
    }
    Ok(())
}
fn read_source(path: &Path) -> Result<(String, BTreeMap<String, Vec<u8>>), String> {
    no_symlinks(path)?;
    let mut files = BTreeMap::new();
    if path.is_dir() {
        directory_files(path, &mut files)?;
        return Ok(("Selected settings folder".into(), files));
    }
    if path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
    {
        let bytes = bounded_file(path, 64 * 1024 * 1024)?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|_| "Invalid settings ZIP archive")?;
        if archive.len() > 5000 {
            return Err("Settings archive contains too many entries".into());
        }
        let mut names = HashSet::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|_| "Cannot read settings archive entry")?;
            let name = entry.name().to_owned();
            if name.contains('\\')
                || name.starts_with('/')
                || name.contains(':')
                || name.split('/').any(|part| part == ".." || part == ".")
                || entry.enclosed_name().is_none()
            {
                return Err("Settings archive contains an unsafe path".into());
            }
            if !names.insert(name.to_lowercase()) {
                return Err("Settings archive contains duplicate paths".into());
            }
            if entry.unix_mode().is_some_and(|mode| {
                mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 && mode & 0o170000 != 0o040000
            }) {
                return Err(
                    "Settings archives cannot contain symbolic links or special files".into(),
                );
            }
            if entry.is_dir() || !allowed(&name) {
                continue;
            }
            if entry.size() > MAX_FILE {
                return Err("Settings archive entry exceeds its size limit".into());
            }
            let mut bytes = Vec::new();
            entry
                .by_ref()
                .take(MAX_FILE + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Invalid settings archive content")?;
            if bytes.len() as u64 > MAX_FILE {
                return Err("Settings archive entry exceeds its size limit".into());
            }
            add_file(&mut files, name, bytes)?;
        }
        return Ok(("Selected settings archive".into(), files));
    }
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("xml"))
    {
        return Err("Select an XML file, settings ZIP, or settings folder".into());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid settings filename")?;
    add_file(&mut files, name.into(), bounded_file(path, MAX_FILE)?)?;
    if data_name(name) {
        let parent = path.parent().ok_or("Cannot locate settings folder")?;
        for sibling in ["dataSources.xml", "dataSources.local.xml"] {
            let sibling_path = parent.join(sibling);
            if sibling != name
                && sibling_path
                    .try_exists()
                    .map_err(|_| "Cannot inspect local settings metadata")?
            {
                add_file(
                    &mut files,
                    sibling.into(),
                    bounded_file(&sibling_path, MAX_FILE)?,
                )?;
            }
        }
    }
    Ok(("Selected XML file".into(), files))
}

fn display(value: &str, fallback: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if value.trim().is_empty()
        || value.len() > 256
        || value.chars().any(char::is_control)
        || ["://", "jdbc:", "password=", "token=", "secret=", "<", ">"]
            .iter()
            .any(|part| lower.contains(part))
    {
        fallback.into()
    } else {
        value.trim().into()
    }
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn project_root(params: &Value) -> Result<Option<PathBuf>, String> {
    let Some(value) = params.get("projectRoot").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let path = PathBuf::from(value.as_str().ok_or("Project root must be a folder path")?);
    if !path.is_absolute() || !path.is_dir() {
        return Err("Project root must be an existing absolute folder".into());
    }
    fs::canonicalize(path)
        .map(Some)
        .map_err(|_| "Cannot resolve the selected project root".into())
}
pub fn read(params: &Value) -> Result<Preview, String> {
    let path = PathBuf::from(params["path"].as_str().ok_or("Select a settings source")?);
    if !path.is_absolute() {
        return Err("Select an absolute settings path".into());
    }
    let project = project_root(params)?;
    let (source, files) = read_source(&path)?;
    if files.is_empty() {
        return Err("No supported settings XML files were found in this source".into());
    }
    let mut digest = Sha256::new();
    digest.update(b"zwip-intellij-import-v1\0");
    digest.update(
        project
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
            .as_bytes(),
    );
    let mut roots = Vec::new();
    for (name, bytes) in &files {
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
        roots.push((name, parse(bytes)?));
    }
    let mut preview=Preview{source,fingerprint:format!("{:x}",digest.finalize()),keymaps:Vec::new(),active_keymap:None,connections:Vec::new(),run_configurations:Vec::new(),appearance:None,notices:vec!["Passwords and other saved credentials are never imported. Enter them separately in Zwip.".into(), "Only supported keymaps, appearance, run configurations and basic data-source metadata are considered; other IntelliJ settings are ignored.".into()]};
    let mut sources: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
    for (source_name, root) in &roots {
        collect_runs(
            root,
            source_name,
            params["revealEnvironment"] == true,
            project.as_deref(),
            &mut preview.run_configurations,
        )?;
        let mut nodes = Vec::new();
        root.descendants("keymap", &mut nodes);
        for node in nodes {
            if node.attr("name").is_some() {
                preview.keymaps.push(keymap(node)?);
            }
        }
        let mut active = Vec::new();
        root.descendants("active_keymap", &mut active);
        for node in active {
            if let Some(name) = node.attr("name") {
                preview.active_keymap = Some(display(name, "Unknown keymap"));
            }
        }
        let mut laf = Vec::new();
        root.descendants("laf", &mut laf);
        for node in laf {
            if let Some(value) = appearance(node) {
                preview.appearance = Some(value);
            } else {
                preview.notices.push(
                    "An IntelliJ theme could not be mapped safely; appearance is unchanged.".into(),
                );
            }
        }
        let mut nodes = Vec::new();
        root.descendants("data-source", &mut nodes);
        for node in nodes {
            let key = if let Some(uuid) = node.attr("uuid").filter(|s| !s.is_empty()) {
                format!("uuid:{uuid}")
            } else if let Some(url) = node.value("jdbc-url") {
                format!(
                    "anonymous:{}",
                    hash(
                        format!("{}\0{}", url, node.value("user-name").unwrap_or_default())
                            .as_bytes()
                    )
                )
            } else {
                continue;
            };
            sources.entry(key).or_default().push(node);
        }
    }
    if sources.len() > MAX_FILES
        || preview.keymaps.len() > MAX_FILES
        || preview.run_configurations.len() > MAX_FILES
    {
        return Err("Settings import contains too many items".into());
    }
    for (identity, nodes) in sources {
        preview
            .connections
            .push(connection_candidate(&identity, &nodes, project.as_deref()));
    }
    if preview.keymaps.is_empty()
        && preview.connections.is_empty()
        && preview.run_configurations.is_empty()
        && preview.appearance.is_none()
        && preview.active_keymap.is_none()
    {
        preview
            .notices
            .push("No supported keymaps, appearance settings, run configurations or data sources were found.".into());
    }
    Ok(preview)
}
fn keymap(node: &Node) -> Result<Value, String> {
    let mut actions = Vec::new();
    let mut seen = HashSet::new();
    for action in node.children.iter().filter(|child| child.name == "action") {
        let Some(id) = action.attr("id") else {
            return Err("A keymap action has no identifier".into());
        };
        if id.len() > 256 || id.chars().any(char::is_control) || !seen.insert(id) {
            return Err("Keymap action identifiers are invalid or repeated".into());
        }
        let mut shortcuts = Vec::new();
        for shortcut in action
            .children
            .iter()
            .filter(|child| child.name == "keyboard-shortcut")
        {
            let Some(first) = shortcut.attr("first-keystroke") else {
                return Err("A keymap shortcut has no first keystroke".into());
            };
            if first.len() > 256 || first.chars().any(char::is_control) {
                return Err("Invalid keymap keystroke".into());
            }
            let mut value = json!({"first":first});
            if let Some(second) = shortcut.attr("second-keystroke") {
                if second.len() > 256 || second.chars().any(char::is_control) {
                    return Err("Invalid keymap keystroke".into());
                }
                value["second"] = json!(second);
            }
            shortcuts.push(value);
        }
        actions.push(json!({"id":id,"shortcuts":shortcuts,"hasMouse":action.children.iter().any(|child|child.name=="mouse-shortcut")}));
    }
    let mut value = json!({"name":display(node.attr("name").unwrap_or_default(),"Imported keymap"),"actions":actions});
    if let Some(parent) = node.attr("parent") {
        value["parent"] = json!(display(parent, "Unknown parent"));
    }
    Ok(value)
}
fn appearance(node: &Node) -> Option<Value> {
    let raw = node
        .attr("name")
        .or_else(|| node.attr("themeId"))
        .or_else(|| node.attr("class-name"))?;
    let lower = raw.to_ascii_lowercase();
    let dark = match node.attr("dark") {
        Some("true") => true,
        Some("false") => false,
        _ if lower.contains("darcula") || lower == "dark" || lower == "experimentaldark" => true,
        _ if lower.contains("intellijlaf")
            || lower.contains("intellijlightlaf")
            || lower == "light"
            || lower == "experimentallight" =>
        {
            false
        }
        _ => return None,
    };
    Some(json!({"dark":dark,"name":display(raw,if dark{"Dark"}else{"Light"})}))
}
fn unique_value<'a>(nodes: &[&'a Node], name: &str) -> Result<Option<&'a str>, String> {
    let values: HashSet<_> = nodes
        .iter()
        .filter_map(|node| node.value(name))
        .filter(|s| !s.is_empty())
        .collect();
    if values.len() > 1 {
        return Err("Conflicting connection metadata requires manual setup.".into());
    }
    Ok(values.into_iter().next())
}
fn connection_candidate(identity: &str, nodes: &[&Node], project: Option<&Path>) -> Candidate {
    let id = format!("intellij-{}", hash(identity.as_bytes()));
    let name = display(
        nodes
            .iter()
            .find_map(|node| node.attr("name"))
            .unwrap_or_default(),
        "Imported connection",
    );
    let mut candidate = Candidate {
        id: id.clone(),
        name: name.clone(),
        status: "unsupported".into(),
        connection: None,
        notes: Vec::new(),
        identity: identity.into(),
    };
    let result = (|| -> Result<Value, String> {
        let raw = unique_value(nodes, "jdbc-url")?
            .ok_or("This source contains local metadata without a JDBC connection definition.")?;
        let (kind, mut config) = parse_jdbc(raw, project)?;
        if kind == "sqlite"
            && nodes.iter().any(|node| {
                node.value("working-dir")
                    .is_some_and(|value| !value.is_empty())
            })
            && raw
                .strip_prefix("jdbc:sqlite:")
                .is_some_and(|value| !value.starts_with('/') && !value.starts_with('$'))
        {
            return Err(
                "A relative SQLite URL with an IntelliJ working directory requires manual setup."
                    .into(),
            );
        }
        if matches!(kind, "mysql" | "postgres")
            && !raw.contains("sslmode=")
            && !raw.contains("sslMode=")
        {
            candidate.notes.push("IntelliJ’s default can fall back to unencrypted transport; this import requires verified TLS. Servers without trusted TLS need manual connection setup.".into());
        }
        let user = unique_value(nodes, "user-name")?;
        if let Some(user) = user {
            if user.len() > 256 || user.chars().any(char::is_control) {
                return Err("The connection username cannot be represented safely.".into());
            }
            config["username"] = json!(user);
        }
        for node in nodes {
            check_settings(node)?;
            if let Some(driver) = node.value("driver-ref") {
                let prefix = driver.split('.').next().unwrap_or_default();
                if !matches!(
                    (kind, prefix),
                    ("mysql", "mysql")
                        | ("postgres", "postgresql" | "postgres")
                        | ("sqlite", "sqlite" | "sqlite-jdbc")
                        | ("redis", "redis")
                ) {
                    return Err("A custom or conflicting JDBC driver requires manual setup.".into());
                }
            }
            if let Some(driver) = node.value("jdbc-driver") {
                if !matches!(
                    (kind, driver),
                    (
                        "mysql",
                        "com.mysql.cj.jdbc.Driver" | "com.mysql.jdbc.Driver"
                    ) | ("postgres", "org.postgresql.Driver")
                        | ("sqlite", "org.sqlite.JDBC")
                        | ("redis", "jdbc.RedisDriver")
                ) {
                    return Err("A custom JDBC driver requires manual setup.".into());
                }
            }
        }
        Ok(json!({"id":id,"kind":kind,"name":name,"config":config}))
    })();
    match result {
        Ok(value) => {
            candidate.status = "ready".into();
            candidate.connection = Some(value);
            candidate
                .notes
                .push("Connection metadata only; credentials must be entered separately.".into());
        }
        Err(reason) => candidate.notes.push(reason),
    }
    if nodes
        .iter()
        .any(|node| node.child("schema-mapping").is_some())
    {
        candidate.notes.push(
            "IntelliJ schema visibility and introspection selections are not imported.".into(),
        );
    }
    candidate
}
fn check_settings(node: &Node) -> Result<(), String> {
    for (name, value) in &node.attrs {
        if !matches!(name.as_str(), "source" | "name" | "uuid" | "group") && !value.is_empty() {
            return Err("Additional data-source options require manual setup.".into());
        }
    }
    for child in &node.children {
        match child.name.as_str() {
            "jdbc-url"|"user-name"|"driver-ref"|"jdbc-driver"|"database-info"|"synchronize"|"auto-sync"|"case-sensitivity"|"working-dir"|"schema-mapping"|"remarks"|"secret-storage"|"password"|"password-storage"=>{},
            "auth-provider" if child.attrs.is_empty() && child.children.is_empty() && matches!(child.text.trim(),""|"user-pass"|"password")=>{},
            "auth-provider"=>return Err("Custom authentication requires manual setup; it is not imported.".into()),
            "ssh-config"|"ssh-tunnel"=>return Err("SSH tunnel settings require manual setup; the connection is not imported directly.".into()),
            "ssl-config"|"ssl"|"tls"=>return Err("IntelliJ TLS, certificate or trust-store settings require manual setup; security settings will not be downgraded.".into()),
            "driver-properties"|"properties" if child.children.is_empty() && child.attrs.is_empty() && child.text.trim().is_empty()=>{},
            "driver-properties"|"properties"=>return Err("Custom driver properties require manual setup.".into()),
            _=>return Err("Additional data-source settings require manual setup.".into()),
        }
    }
    Ok(())
}
fn decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("Invalid encoded connection field.".into());
            }
            let first = (bytes[index + 1] as char)
                .to_digit(16)
                .ok_or("Invalid encoded connection field.")?;
            let second = (bytes[index + 2] as char)
                .to_digit(16)
                .ok_or("Invalid encoded connection field.")?;
            out.push((first * 16 + second) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    let value = String::from_utf8(out).map_err(|_| "Connection field is not valid UTF-8.")?;
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("Connection field exceeds supported limits.".into());
    }
    Ok(value)
}
fn parse_jdbc(raw: &str, project: Option<&Path>) -> Result<(&'static str, Value), String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return Err("Unsupported JDBC connection format.".into());
    }
    if let Some(raw) = raw.strip_prefix("jdbc:sqlite:") {
        if raw.contains('?')
            || raw.contains(';')
            || raw.starts_with("file:")
            || raw.contains(":memory:")
        {
            return Err("SQLite URI options or in-memory databases require manual setup.".into());
        }
        let mut path = raw.to_owned();
        for token in ["$PROJECT_DIR$", "$ProjectFileDir$"] {
            if path.contains(token) {
                path = path.replace(
                    token,
                    project
                        .ok_or(
                            "Choose an explicit project root to resolve the SQLite project path.",
                        )?
                        .to_str()
                        .ok_or("Project path is not valid UTF-8.")?,
                );
            }
        }
        if path.contains('$') || path.starts_with('~') {
            return Err("Unresolved SQLite path macros require manual setup.".into());
        }
        let path = PathBuf::from(path);
        let path = if path.is_absolute() {
            path
        } else {
            project
                .ok_or("Choose an explicit project root for this relative SQLite path.")?
                .join(path)
        };
        let mut normalized = PathBuf::new();
        for part in path.components() {
            match part {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::CurDir => {}
                part => normalized.push(part.as_os_str()),
            }
        }
        if normalized == Path::new("/") {
            return Err("SQLite database path must identify a file.".into());
        }
        return Ok(("sqlite", json!({"path":normalized})));
    }
    let raw = raw
        .strip_prefix("jdbc:")
        .ok_or("This database URL format is not supported.")?;
    let (kind, port) = if raw.starts_with("mysql://") {
        ("mysql", 3306)
    } else if raw.starts_with("postgresql://") {
        ("postgres", 5432)
    } else if raw.starts_with("redis://") || raw.starts_with("rediss://") {
        ("redis", 6379)
    } else {
        return Err(
            "Only basic MySQL, PostgreSQL, SQLite and Redis connections are supported.".into(),
        );
    };
    let url = url::Url::parse(raw).map_err(|_| "The JDBC connection requires manual setup.")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Embedded URL credentials or fragments are not imported; recreate this connection manually.".into());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or("A single database host is required.")?;
    if host.contains(',')
        || host.contains('%')
        || host.contains('$')
        || host.chars().any(char::is_control)
    {
        return Err("The database host requires manual setup.".into());
    }
    let mut tls = matches!(kind, "mysql" | "postgres") || url.scheme() == "rediss";
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err("Repeated JDBC parameters require manual setup.".into());
        }
        match (kind, key.as_ref(), value.as_ref()) {
            ("postgres", "sslmode", "verify-full") | ("mysql", "sslMode", "VERIFY_IDENTITY") => {
                tls = true
            }
            ("postgres", "sslmode", "disable") | ("mysql", "sslMode", "DISABLED") => tls = false,
            _ => {
                return Err(
                    "JDBC parameters, credentials or custom security options require manual setup."
                        .into(),
                )
            }
        }
    }
    let port = url.port().unwrap_or(port);
    if port == 0 {
        return Err("The database port is not supported.".into());
    }
    let mut config = json!({"host":host.trim_matches(['[',']']),"port":port,"tls":tls});
    let database = decode(url.path().trim_start_matches('/'))?;
    if database.contains('/') || database.contains(';') || database.contains('$') {
        return Err("The database name or URL format requires manual setup.".into());
    }
    if kind == "redis" && !database.is_empty() && database.parse::<u32>().is_err() {
        return Err("Redis database must be a nonnegative integer.".into());
    }
    if !database.is_empty() {
        config["database"] = json!(database);
    }
    Ok((kind, config))
}

/// Credential-like environment values are withheld unless `reveal` is set, which the
/// importer does only after the user confirms each value.
fn collect_runs(
    root: &Node,
    source: &str,
    reveal: bool,
    project: Option<&Path>,
    rows: &mut Vec<Value>,
) -> Result<(), String> {
    let mut configurations = Vec::new();
    if root.name == "configuration" {
        configurations.push(root);
    }
    if root.name == "component"
        && matches!(
            root.attr("name"),
            Some("ProjectRunConfigurationManager" | "RunManager")
        )
    {
        configurations.extend(
            root.children
                .iter()
                .filter(|node| node.name == "configuration"),
        );
    }
    let mut components = Vec::new();
    root.descendants("component", &mut components);
    for component in components {
        if !std::ptr::eq(component, root)
            && matches!(
                component.attr("name"),
                Some("ProjectRunConfigurationManager" | "RunManager")
            )
        {
            configurations.extend(
                component
                    .children
                    .iter()
                    .filter(|node| node.name == "configuration"),
            );
        }
    }
    for (index, node) in configurations.into_iter().enumerate() {
        if node.attr("default") == Some("true") {
            continue;
        }
        if rows.len() >= MAX_FILES {
            return Err("Settings import contains too many run configurations".into());
        }
        let kind = display(node.attr("type").unwrap_or_default(), "Unknown");
        let name = display(
            node.attr("name").unwrap_or_default(),
            "Imported run configuration",
        );
        let id = format!(
            "intellij-run-{}",
            hash(format!("{source}\0{index}\0{kind}\0{name}").as_bytes())
        );
        let mut fields = serde_json::Map::new();
        let mut notes = Vec::new();
        let status = match run_fields(node, reveal, &mut fields) {
            Ok(()) => {
                if let Some((directory, module)) =
                    project.and_then(|project| package_directory(project, &fields))
                {
                    fields.insert("packageDirectory".into(), json!(directory));
                    fields.insert("packageModule".into(), json!(module));
                }
                notes.push("Imported commands must be reviewed before saving. Nothing is executed during import.".into());
                "ready"
            }
            Err(note) => {
                fields.clear();
                notes.push(note);
                "unsupported"
            }
        };
        rows.push(
            json!({"id":id,"name":name,"type":kind,"status":status,"fields":fields,"notes":notes}),
        );
    }
    Ok(())
}
fn run_fields(
    node: &Node,
    reveal: bool,
    fields: &mut serde_json::Map<String, Value>,
) -> Result<(), String> {
    let kind = node.attr("type").unwrap_or_default();
    if !matches!(
        kind,
        "js.build_tools.npm"
            | "GoApplicationRunConfiguration"
            | "GoTestRunConfiguration"
            | "MAKEFILE_TARGET_RUN_CONFIGURATION"
    ) {
        return Err(
            "This run configuration type is not supported; its settings were not imported.".into(),
        );
    }
    for (name, value) in &node.attrs {
        if !matches!(
            name.as_str(),
            "default"
                | "name"
                | "type"
                | "factoryName"
                | "nameIsGenerated"
                | "temporary"
                | "folderName"
                | "singleton"
                | "activateToolWindowBeforeRun"
                | "focusToolWindowBeforeRun"
        ) && !value.is_empty()
        {
            return Err("Additional run configuration options require manual setup.".into());
        }
    }
    for child in &node.children {
        match child.name.as_str() {
            "module"
                if child.children.is_empty() && child.attrs.keys().all(|key| key == "name") =>
            {
                continue
            }
            "method" if child.children.is_empty() && child.attrs.keys().all(|key| key == "v") => {
                continue
            }
            "method" => {
                return Err(
                    "Before-launch tasks are not imported; recreate this configuration manually."
                        .into(),
                )
            }
            "envs" | "env_files" | "env-files"
                if child.children.is_empty()
                    && child.attrs.is_empty()
                    && child.text.trim().is_empty() =>
            {
                continue
            }
            "envs" => {
                if fields
                    .insert("env".into(), environment(child, reveal)?)
                    .is_some()
                {
                    return Err("Repeated run configuration fields require manual setup.".into());
                }
                continue;
            }
            "env_files" | "env-files" | "env-file" | "envFile" | "environment" => {
                return Err(
                    "Environment files are not imported; recreate this configuration manually."
                        .into(),
                )
            }
            "makefile" if kind == "MAKEFILE_TARGET_RUN_CONFIGURATION" => {
                makefile_fields(child, reveal, fields)?;
                continue;
            }
            "scripts" if kind == "js.build_tools.npm" => {
                let mut scripts = Vec::new();
                if !child.attrs.is_empty() || !child.text.trim().is_empty() {
                    return Err("Npm script options require manual setup.".into());
                }
                for script in &child.children {
                    if script.name != "script"
                        || script.attrs.len() != 1
                        || !script.children.is_empty()
                        || !script.text.trim().is_empty()
                    {
                        return Err("Npm script options require manual setup.".into());
                    }
                    let script = script.attr("value").ok_or("An npm script has no name.")?;
                    check_run_value(script)?;
                    scripts.push(json!(script));
                }
                if fields.insert("scripts".into(), json!(scripts)).is_some() {
                    return Err("Repeated run configuration fields require manual setup.".into());
                }
                continue;
            }
            _ => {}
        }
        let field=match (kind,child.name.as_str()) {
            ("js.build_tools.npm","package-json")=>"packageJson",
            ("js.build_tools.npm","command")=>"command",
            ("js.build_tools.npm","node-interpreter")=>"nodeInterpreter",
            ("js.build_tools.npm","package-manager")=>"packageManager",
            ("js.build_tools.npm","arguments")=>"programParameters",
            (_,"working_directory"|"working-directory")=>"workingDirectory",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","go_parameters")=>"goParameters",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","parameters")=>"programParameters",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","kind")=>"goKind",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","filePath")=>"filePath",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","package")=>"packagePath",
            ("GoApplicationRunConfiguration"|"GoTestRunConfiguration","directory")=>"directoryPath",
            ("GoTestRunConfiguration","pattern")=>"pattern",
            ("GoTestRunConfiguration","framework")=>"framework",
            _=>return Err("Additional run configuration settings require manual setup; unknown fields were not copied.".into()),
        };
        if !child.children.is_empty() || !child.text.trim().is_empty() || child.attrs.len() != 1 {
            return Err("Run configuration field options require manual setup.".into());
        }
        let value = child
            .attr("value")
            .ok_or("A run configuration field has no value.")?;
        check_run_value(value)?;
        if fields.insert(field.into(), json!(value)).is_some() {
            return Err("Repeated run configuration fields require manual setup.".into());
        }
    }
    Ok(())
}
/// `<envs><env name="…" value="…"/></envs>` as ordered `{name, value, sensitive}` rows.
fn environment(node: &Node, reveal: bool) -> Result<Value, String> {
    if !node.attrs.is_empty() || !node.text.trim().is_empty() {
        return Err("Environment options require manual setup.".into());
    }
    let mut names = HashSet::new();
    let mut rows = Vec::new();
    for env in &node.children {
        if env.name != "env"
            || !env.children.is_empty()
            || !env.text.trim().is_empty()
            || env.attrs.keys().any(|key| key != "name" && key != "value")
        {
            return Err("Environment options require manual setup.".into());
        }
        let name = env
            .attr("name")
            .ok_or("An environment variable has no name.")?;
        let value = env.attr("value").unwrap_or_default();
        let mut chars = name.chars();
        if !chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.len() > 256
        {
            return Err("An environment variable name is not supported.".into());
        }
        if !names.insert(name) {
            return Err("Repeated environment variables require manual setup.".into());
        }
        if value.len() > 8192 || value.chars().any(|c| c.is_control() && c != '\t') {
            return Err("An environment value exceeds supported limits.".into());
        }
        let sensitive = looks_sensitive(name) || looks_sensitive(value);
        rows.push(json!({
            "name": name,
            "value": if sensitive && !reveal { Value::Null } else { json!(value) },
            "sensitive": sensitive,
        }));
    }
    Ok(json!(rows))
}
/// Resolves a Go package configured by import path (such as "oscar" or "consumer/tools").
/// It is looked up through the working directory's go.mod, as `go run <path>` would, and
/// otherwise through any project module declaring it, as IntelliJ does for multi-module
/// projects. Returns `(packageDirectory, packageModule)` as `$PROJECT_DIR$/…` paths.
fn package_directory(
    project: &Path,
    fields: &serde_json::Map<String, Value>,
) -> Option<(String, String)> {
    let field = |name: &str| fields.get(name).and_then(Value::as_str);
    if !field("goKind")?.eq_ignore_ascii_case("PACKAGE") {
        return None;
    }
    let package = field("packagePath").filter(|path| *path != ".")?;
    let relative = field("workingDirectory")?
        .strip_prefix("$PROJECT_DIR$")?
        .trim_start_matches('/');
    if relative.split('/').any(|part| part == "..") {
        return None;
    }
    let declares = |module: &Path| -> Option<PathBuf> {
        let text = fs::read_to_string(module.join("go.mod")).ok()?;
        let path = text
            .lines()
            .find_map(|line| line.trim().strip_prefix("module "))?
            .trim()
            .trim_matches('"');
        let suffix = if package == path {
            ""
        } else {
            package.strip_prefix(&format!("{path}/"))?
        };
        Some(module.join(suffix)).filter(|directory| directory.is_dir())
    };
    let mut enclosing = project.join(relative);
    let found = loop {
        if enclosing.join("go.mod").is_file() {
            break declares(&enclosing).map(|directory| (directory, enclosing.clone()));
        }
        if enclosing == project || !enclosing.pop() || !enclosing.starts_with(project) {
            break None;
        }
    }
    .or_else(|| {
        // Shallow, ignore-aware scan for the module that declares this package.
        ignore::WalkBuilder::new(project)
            .max_depth(Some(4))
            .build()
            .flatten()
            .filter(|entry| entry.file_name() == "go.mod")
            .filter_map(|entry| {
                let module = entry.path().parent()?.to_path_buf();
                Some((declares(&module)?, module))
            })
            .max_by_key(|(_, module)| module.components().count())
    })?;
    let display = |path: &Path| -> Option<String> {
        let relative = path.strip_prefix(project).ok()?.to_str()?;
        Some(if relative.is_empty() {
            "$PROJECT_DIR$".into()
        } else {
            format!("$PROJECT_DIR$/{relative}")
        })
    };
    Some((display(&found.0)?, display(&found.1)?))
}
fn looks_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    CREDENTIAL_WORDS.iter().any(|part| lower.contains(part))
        // URLs carrying user information, such as postgres://user:pass@host.
        || lower.split_once("://").is_some_and(|(_, rest)| rest.split('/').next().is_some_and(|host| host.contains('@')))
}
const CREDENTIAL_WORDS: [&str; 10] = [
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "api-key",
    "api_key",
    "apikey",
    "credential",
    "private_key",
];
/// `<makefile filename="…" target="…" workingDirectory="…" arguments="…"><envs/></makefile>`.
fn makefile_fields(
    node: &Node,
    reveal: bool,
    fields: &mut serde_json::Map<String, Value>,
) -> Result<(), String> {
    let unsupported = || "Makefile options require manual setup.".to_owned();
    if !node.text.trim().is_empty() {
        return Err(unsupported());
    }
    let mut insert = |field: &str, value: Value| {
        if fields.insert(field.into(), value).is_some() {
            Err("Repeated run configuration fields require manual setup.".to_owned())
        } else {
            Ok(())
        }
    };
    for (name, value) in &node.attrs {
        let field = match name.as_str() {
            "filename" => "makefile",
            "target" => "target",
            "workingDirectory" => "workingDirectory",
            "arguments" => "programParameters",
            _ => return Err(unsupported()),
        };
        if !value.is_empty() {
            check_run_value(value)?;
            insert(field, json!(value))?;
        }
    }
    for child in &node.children {
        match child.name.as_str() {
            "envs"
                if child.children.is_empty()
                    && child.attrs.is_empty()
                    && child.text.trim().is_empty() => {}
            "envs" => insert("env", environment(child, reveal)?)?,
            _ => return Err(unsupported()),
        }
    }
    Ok(())
}
fn check_run_value(value: &str) -> Result<(), String> {
    if value.len() > 8192 || value.chars().any(|c| c.is_control() && c != '\t') {
        return Err("A run configuration field exceeds supported limits.".into());
    }
    let lower = value.to_ascii_lowercase();
    if [
        "password",
        "secret",
        "token",
        "authorization",
        "api-key",
        "api_key",
        "apikey",
    ]
    .iter()
    .any(|part| lower.contains(part))
    {
        return Err("Potential credentials in run arguments or paths were omitted; recreate this configuration manually.".into());
    }
    if value.contains("://") {
        return Err(
            "URLs in run arguments or paths require manual review and were not copied.".into(),
        );
    }
    Ok(())
}
