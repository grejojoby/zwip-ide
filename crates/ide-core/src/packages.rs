use crate::{worker::Worker, workspace::Workspace};
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::Duration,
};

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 768 * 1024 * 1024;
fn worker_kind() -> String {
    "worker".into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxAsset {
    pub abi: u32,
    pub asset: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Exact file names without an extension, such as `Makefile`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_names: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub core_version: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub languages: Vec<String>,
    #[serde(default)]
    pub document_extensions: Vec<String>,
    #[serde(default)]
    pub discovery: Vec<crate::workspace::DiscoveryRule>,
    #[serde(default)]
    pub syntax: Option<SyntaxAsset>,
    #[serde(default = "worker_kind")]
    pub kind: String,
    #[serde(default)]
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    pub checksums: HashMap<String, String>,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub architecture: String,
}
#[derive(Clone, PartialEq, Eq)]
struct Installed {
    id: String,
    version: String,
    directory: String,
    enabled: bool,
    manifest_hash: String,
    manifest_json: Option<String>,
    previous_version: Option<String>,
    error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    id: String,
    name: String,
    version: String,
    url: String,
    sha256: String,
    platform: String,
    architecture: String,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
struct Catalog {
    version: u32,
    packages: Vec<CatalogEntry>,
}
struct StartSpec {
    supervisor: Arc<crate::worker::Supervisor>,
    directory: PathBuf,
    manifest: Manifest,
    manifest_hash: String,
    cache: PathBuf,
    workspace_root: String,
    generation: u64,
    params: Value,
}
/// An immutable launch ticket. Expensive hashing and initialize happen without the host lock.
pub struct WorkerPlan {
    id: String,
    ready: bool,
    spec: Option<StartSpec>,
    result: OnceLock<Result<Arc<Worker>, String>>,
    active: Mutex<Option<Arc<Worker>>>,
    canceled: AtomicBool,
}
impl WorkerPlan {
    pub fn start(&self) -> Result<Arc<Worker>, String> {
        self.result
            .get_or_init(|| {
                let spec = self
                    .spec
                    .as_ref()
                    .ok_or("Missing worker launch specification")?;
                if self.canceled.load(Ordering::SeqCst) {
                    return Err("Package startup superseded".into());
                }
                if hash_file(&spec.directory.join("manifest.json"))? != spec.manifest_hash {
                    return Err("Installed package manifest changed before launch".into());
                }
                validate_package(&spec.directory)?;
                let worker = spec.supervisor.spawn(|| {
                    Worker::spawn(
                        &spec.directory.join(&spec.manifest.executable),
                        &spec.manifest.args,
                        &spec.directory,
                        &spec.workspace_root,
                        &spec.cache,
                        &spec.manifest.document_extensions,
                    )
                })?;
                *self.active.lock().map_err(|e| e.to_string())? = Some(worker.clone());
                if self.canceled.load(Ordering::SeqCst) {
                    worker.stop();
                    return Err("Package startup superseded".into());
                }
                let initialized = initialize_worker(&worker, spec.params.clone(), spec.generation);
                if let Err(error) = initialized {
                    worker.stop();
                    return Err(error);
                }
                if self.canceled.load(Ordering::SeqCst) {
                    worker.stop();
                    return Err("Package startup superseded".into());
                }
                Ok(worker)
            })
            .clone()
    }
    fn cancel(&self) {
        self.canceled.store(true, Ordering::SeqCst);
        if let Some(worker) = self.active.lock().ok().and_then(|active| active.clone()) {
            std::thread::spawn(move || worker.stop());
        }
    }
}
/// Prepared replacement. Initialize it outside the host lock, then validate and
/// commit it under the lock. Dropping an unaccepted install removes only its own
/// newly created version directory and stops its candidate, never the old worker.
pub struct MutationPlan {
    manifest: Manifest,
    directory: PathBuf,
    old: Option<Installed>,
    manifest_hash: String,
    archive_hash: Option<String>,
    restart: bool,
    remove_on_failure: bool,
    accepted: bool,
    epoch: u64,
    generation: Option<u64>,
    candidate: Arc<WorkerPlan>,
    initialize: bool,
}
impl MutationPlan {
    pub fn start(&self) -> Result<Option<Arc<Worker>>, String> {
        if self.candidate.canceled.load(Ordering::SeqCst) {
            return Err("Package replacement superseded".into());
        }
        if self.initialize {
            self.candidate.start().map(Some)
        } else {
            Ok(None)
        }
    }
}
impl Drop for MutationPlan {
    fn drop(&mut self) {
        if !self.accepted {
            self.candidate.cancel();
            if self.remove_on_failure {
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
    }
}
fn initialize_worker(worker: &Arc<Worker>, params: Value, generation: u64) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let candidate = worker.clone();
    std::thread::spawn(move || {
        let _ = sender.send(candidate.request("initialize", params));
    });
    let value = receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "Package initialization timed out after 30 seconds".to_owned())??;
    if !value.is_object() {
        return Err("Package initialize returned an invalid response".into());
    }
    if value
        .get("generation")
        .is_some_and(|returned| returned.as_u64() != Some(generation))
    {
        return Err("Package initialized an obsolete workspace generation".into());
    }
    if value["contexts"].as_array().is_some_and(|contexts| {
        !contexts.is_empty() && contexts.iter().all(|context| context["state"] == "failed")
    }) {
        return Err(format!(
            "Package initialized no usable contexts: {}",
            value["contexts"]
        ));
    }
    if !worker.is_running() {
        return Err("Package exited during initialization".into());
    }
    Ok(())
}
/// Download inputs copied under the host lock; all HTTPS I/O runs on this value outside it.
pub struct CatalogRequest {
    url: String,
}
pub struct DownloadedPackage {
    archive: tempfile::NamedTempFile,
    entry: CatalogEntry,
    catalog_url: String,
}
impl CatalogRequest {
    fn load(&self) -> Result<Catalog, String> {
        let mut response = https_client()?
            .get(https_url(&self.url)?)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| format!("Cannot fetch curated catalog: {e}"))?;
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 {
            return Err("Catalog exceeds 1 MiB".into());
        }
        parse_catalog(&bytes)
    }
    pub fn catalog(&self) -> Result<Value, String> {
        Ok(json!({"url":self.url,"packages":self.load()?.packages}))
    }
    /// `progress` receives bytes downloaded so far and the expected total, when known.
    pub fn download(
        &self,
        id: &str,
        version: &str,
        progress: impl Fn(u64, Option<u64>),
    ) -> Result<DownloadedPackage, String> {
        let catalog = self.load()?;
        let candidates: Vec<_> = catalog
            .packages
            .into_iter()
            .filter(|entry| {
                entry.id == id
                    && entry.version == version
                    && target_matches(&entry.platform, &entry.architecture)
            })
            .collect();
        if candidates.len() != 1 {
            return Err("Catalog has no unique compatible package for this ID and version".into());
        }
        let entry = candidates.into_iter().next().unwrap();
        let mut response = https_client()?
            .get(https_url(&entry.url)?)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|e| format!("Package download failed: {e}"))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARCHIVE)
        {
            return Err("Package archive exceeds 256 MiB".into());
        }
        let total = response.content_length();
        progress(0, total);
        let mut archive = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        let mut count = 0_u64;
        let mut buffer = [0_u8; 32768];
        let mut digest = Sha256::new();
        loop {
            let read = response.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            count += read as u64;
            if count > MAX_ARCHIVE {
                return Err("Package archive exceeds 256 MiB".into());
            }
            digest.update(&buffer[..read]);
            archive
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
            progress(count, total);
        }
        if format!("{:x}", digest.finalize()) != entry.sha256 {
            return Err("Downloaded archive checksum does not match the trusted catalog".into());
        }
        Ok(DownloadedPackage {
            archive,
            entry,
            catalog_url: self.url.clone(),
        })
    }
}
pub struct PackageHost {
    supervisor: Arc<crate::worker::Supervisor>,
    root: PathBuf,
    db: Connection,
    workers: HashMap<String, Arc<Worker>>,
    starting: HashMap<String, Arc<WorkerPlan>>,
    replacing: HashMap<String, Arc<WorkerPlan>>,
    mutation_epoch: u64,
}
impl PackageHost {
    pub fn new(data: &Path) -> Result<Self, String> {
        let root = data.join("packages");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let db = Connection::open(data.join("packages.sqlite")).map_err(|e| e.to_string())?;
        // Each IDE window has its own core and connection to this shared store.
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS packages(id TEXT PRIMARY KEY, version TEXT NOT NULL, directory TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS package_versions(id TEXT NOT NULL,version TEXT NOT NULL,directory TEXT NOT NULL,manifest_hash TEXT NOT NULL,archive_hash TEXT,PRIMARY KEY(id,version)); CREATE TABLE IF NOT EXISTS package_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
        let columns = {
            let mut statement = db
                .prepare("PRAGMA table_info(packages)")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for (column, definition) in [
            ("manifest_hash", "TEXT NOT NULL DEFAULT ''"),
            ("previous_version", "TEXT"),
            ("error", "TEXT"),
            ("manifest_json", "TEXT"),
        ] {
            if !columns.contains(column) {
                db.execute_batch(&format!(
                    "ALTER TABLE packages ADD COLUMN {column} {definition}"
                ))
                .map_err(|e| e.to_string())?;
            }
        }
        let host = Self {
            supervisor: Arc::new(crate::worker::Supervisor::default()),
            root,
            db,
            workers: HashMap::new(),
            starting: HashMap::new(),
            replacing: HashMap::new(),
            mutation_epoch: 0,
        };
        // Upgrade old registries only from their pinned manifest. A damaged legacy
        // package is left quarantined; it must not prevent opening the registry.
        for item in host.installed()? {
            if item.manifest_json.is_none() {
                if let Ok(manifest) = host.verified_manifest(&item) {
                    host.db
                        .execute(
                            "UPDATE packages SET manifest_json=?1 WHERE id=?2",
                            params![
                                serde_json::to_string(&manifest).map_err(|e| e.to_string())?,
                                item.id
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(host)
    }
    pub fn supervisor(&self) -> Arc<crate::worker::Supervisor> {
        self.supervisor.clone()
    }
    fn installed(&self) -> Result<Vec<Installed>, String> {
        let mut statement=self.db.prepare("SELECT id,version,directory,enabled,manifest_hash,previous_version,error,manifest_json FROM packages ORDER BY id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(Installed {
                    id: row.get(0)?,
                    version: row.get(1)?,
                    directory: row.get(2)?,
                    enabled: row.get(3)?,
                    manifest_hash: row.get(4)?,
                    previous_version: row.get(5)?,
                    error: row.get(6)?,
                    manifest_json: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    fn verified_manifest(&self, installed: &Installed) -> Result<Manifest, String> {
        if installed.manifest_hash.is_empty() {
            return Err(
                "Reinstall this legacy package to establish a trusted manifest digest".into(),
            );
        }
        if hash_file(&Path::new(&installed.directory).join("manifest.json"))?
            != installed.manifest_hash
        {
            return Err("Installed package manifest changed since installation".into());
        }
        read_manifest(Path::new(&installed.directory))
    }
    fn trusted_manifest(&self, installed: &Installed) -> Result<Manifest, String> {
        // Routing and dependency bookkeeping use the validated installation snapshot,
        // never mutable files in another package's directory. Execution still verifies
        // the selected package's pinned manifest and every asset before spawning it.
        serde_json::from_str(
            installed
                .manifest_json
                .as_deref()
                .ok_or("Reinstall this package to establish trusted routing metadata")?,
        )
        .map_err(|error| format!("Invalid installed package metadata: {error}"))
    }
    pub fn syntax_asset(&self, extension: &str, file_name: Option<&str>) -> Result<Value, String> {
        for item in self.installed()?.into_iter().filter(|item| item.enabled) {
            let Ok(manifest) = self.trusted_manifest(&item) else {
                continue;
            };
            let Some(syntax) = manifest.syntax else {
                continue;
            };
            if !syntax
                .extensions
                .iter()
                .any(|candidate| candidate == extension)
                && !file_name.is_some_and(|name| syntax.file_names.iter().any(|item| item == name))
            {
                continue;
            }
            let directory = Path::new(&item.directory)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let path = directory
                .join(relative_path(&syntax.asset)?)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !path.starts_with(&directory)
                || fs::metadata(&path)
                    .map_err(|error| error.to_string())?
                    .len()
                    > 4 * 1024 * 1024
            {
                return Err("Syntax asset exceeds its package boundary or size limit".into());
            }
            let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
            if manifest.checksums.get(&syntax.asset) != Some(&digest) {
                return Err("Installed syntax asset changed since installation".into());
            }
            return Ok(
                json!({"id":item.id,"version":item.version,"abi":syntax.abi,"sha256":digest,"source":source}),
            );
        }
        Ok(Value::Null)
    }
    pub fn list(&self) -> Result<Value, String> {
        let mut descriptions: BTreeMap<String, (String, String)> = [
            ("go", "Go", "Navigation, interfaces, tests and debugging"),
            ("web", "Web", "JavaScript and TypeScript semantic support"),
            (
                "react-next",
                "React / Next.js",
                "Project Next.js TypeScript plugin integration",
            ),
            ("sql", "SQL databases", "MySQL, PostgreSQL and SQLite"),
            ("redis", "Redis", "Key and value browsing"),
            ("http", "HTTP client", "Request files and responses"),
            (
                "make",
                "Makefile",
                "Makefile highlighting and IntelliJ Makefile run configurations",
            ),
        ]
        .into_iter()
        .map(|(id, name, description)| (id.into(), (name.into(), description.into())))
        .collect();
        let installed = self.installed()?;
        for item in &installed {
            descriptions
                .entry(item.id.clone())
                .or_insert((item.id.clone(), String::new()));
        }
        let mut result = Vec::new();
        for (id, (name, description)) in descriptions {
            let found = installed.iter().find(|item| item.id == id);
            let read = found.map(|item| self.verified_manifest(item));
            let trusted = found.and_then(|item| self.trusted_manifest(item).ok());
            let manifest = trusted.as_ref();
            let error = read
                .as_ref()
                .and_then(|result| result.as_ref().err())
                .cloned()
                .or_else(|| found.and_then(|item| item.error.clone()));
            result.push(json!({"id":id,"name":manifest.map_or(name.as_str(),|m|&m.name),"description":manifest.map_or(description.as_str(),|m|&m.description),"version":found.map_or("",|item|item.version.as_str()),"installed":found.is_some(),"enabled":found.is_some_and(|item|item.enabled),"running":self.workers.get(&id).is_some_and(|worker|worker.is_running()),"capabilities":manifest.map(|m|m.capabilities.clone()).unwrap_or_default(),"kind":manifest.map(|m|m.kind.clone()),"dependencies":manifest.map(|m|m.dependencies.clone()).unwrap_or_default(),"rollbackAvailable":found.is_some_and(|item|item.previous_version.is_some()),"error":error}));
        }
        Ok(json!(result))
    }
    fn validate_dependencies(&self, manifest: &Manifest, enabled: bool) -> Result<(), String> {
        let installed = self.installed()?;
        let mut pending: Vec<_> = manifest.dependencies.keys().cloned().collect();
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if id == manifest.id {
                return Err("Package dependency cycle is not allowed".into());
            }
            if !visited.insert(id.clone()) {
                continue;
            }
            if let Some(item) = installed.iter().find(|item| item.id == id) {
                pending.extend(self.verified_manifest(item)?.dependencies.keys().cloned());
            }
        }
        for (id, range) in &manifest.dependencies {
            if id == &manifest.id {
                return Err("A package cannot depend on itself".into());
            }
            let item = installed
                .iter()
                .find(|item| &item.id == id)
                .ok_or_else(|| format!("Install dependency {id} {range} first"))?;
            let dependency = self.verified_manifest(item)?;
            if !semver::VersionReq::parse(range)
                .map_err(|e| e.to_string())?
                .matches(&semver::Version::parse(&dependency.version).map_err(|e| e.to_string())?)
            {
                return Err(format!(
                    "Dependency {id} requires {range}; installed {}",
                    dependency.version
                ));
            }
            if enabled && !item.enabled {
                return Err(format!("Enable dependency {id} first"));
            }
        }
        for item in installed.iter().filter(|item| item.id != manifest.id) {
            let Ok(dependent) = self.trusted_manifest(item) else {
                continue;
            };
            if let Some(range) = dependent.dependencies.get(&manifest.id) {
                if !semver::VersionReq::parse(range)
                    .map_err(|e| e.to_string())?
                    .matches(&semver::Version::parse(&manifest.version).map_err(|e| e.to_string())?)
                {
                    return Err(format!(
                        "{} requires {} {range}; this version would break that dependency",
                        item.id, manifest.id
                    ));
                }
            }
        }
        Ok(())
    }
    fn enabled_ids(&self) -> Result<Vec<String>, String> {
        Ok(self
            .installed()?
            .into_iter()
            .filter(|item| item.enabled)
            .map(|item| item.id)
            .collect())
    }
    fn affected_workers(&self, manifest: &Manifest) -> Result<HashSet<String>, String> {
        let mut affected = HashSet::from([manifest.id.clone()]);
        // Declarative extensions are consumed by their dependency providers.
        if manifest.kind == "feature" {
            affected.extend(manifest.dependencies.keys().cloned());
        }
        let installed = self.installed()?;
        loop {
            let before = affected.len();
            for item in installed.iter().filter(|item| item.enabled) {
                let Ok(dependent) = self.trusted_manifest(item) else {
                    continue;
                };
                if dependent
                    .dependencies
                    .keys()
                    .any(|id| affected.contains(id))
                {
                    affected.insert(item.id.clone());
                }
            }
            if before == affected.len() {
                break;
            }
        }
        Ok(affected)
    }
    fn stop_affected(&mut self, affected: &HashSet<String>, except: Option<&str>) {
        for id in affected {
            if let Some(plan) = self.replacing.remove(id) {
                plan.cancel();
            }
            if let Some(plan) = self.starting.remove(id) {
                plan.cancel();
            }
            if Some(id.as_str()) != except {
                if let Some(worker) = self.workers.remove(id) {
                    worker.stop();
                }
            }
        }
    }
    fn prepare_mutation(
        &mut self,
        manifest: Manifest,
        directory: PathBuf,
        old: Option<Installed>,
        workspace: Option<&Workspace>,
        archive_hash: Option<String>,
        restart: bool,
    ) -> Result<MutationPlan, String> {
        let enabled = old.as_ref().is_some_and(|item| item.enabled);
        self.validate_dependencies(&manifest, enabled)?;
        let initialize = enabled && manifest.kind == "worker";
        let manifest_hash = hash_file(&directory.join("manifest.json"))?;
        let spec = if initialize {
            let workspace =
                workspace.ok_or("Open a workspace before updating an enabled worker package")?;
            let contexts: Vec<_> = workspace
                .contexts
                .iter()
                .filter(|context| manifest.languages.contains(&context.language))
                .collect();
            Some(StartSpec {
                supervisor: self.supervisor.clone(),
                directory: directory.clone(),
                manifest: manifest.clone(),
                manifest_hash: manifest_hash.clone(),
                cache: self.root.join(".cache").join(&manifest.id),
                workspace_root: workspace.root.clone(),
                generation: workspace.generation,
                params: json!({"root":workspace.root,"contexts":contexts,"generation":workspace.generation,"enabledPackages":self.enabled_ids()?}),
            })
        } else {
            None
        };
        let candidate = Arc::new(WorkerPlan {
            id: manifest.id.clone(),
            ready: false,
            spec,
            result: OnceLock::new(),
            active: Mutex::new(None),
            canceled: AtomicBool::new(false),
        });
        if let Some(previous) = self
            .replacing
            .insert(manifest.id.clone(), candidate.clone())
        {
            previous.cancel();
        }
        Ok(MutationPlan {
            manifest,
            directory,
            old,
            manifest_hash,
            archive_hash,
            restart,
            remove_on_failure: false,
            accepted: false,
            epoch: self.mutation_epoch,
            generation: workspace.map(|workspace| workspace.generation),
            candidate,
            initialize,
        })
    }
    pub fn prepare_install(
        &mut self,
        source: &Path,
        workspace: Option<&Workspace>,
    ) -> Result<MutationPlan, String> {
        self.prepare_install_source(source, workspace, None)
    }
    fn prepare_install_source(
        &mut self,
        source: &Path,
        workspace: Option<&Workspace>,
        catalog: Option<&CatalogEntry>,
    ) -> Result<MutationPlan, String> {
        let stage = tempfile::tempdir_in(&self.root).map_err(|e| e.to_string())?;
        if source.is_dir() {
            if catalog.is_some() {
                return Err("Catalog packages must be verified ZIP archives".into());
            }
            copy_tree(source, stage.path())?;
        } else {
            if let Some(entry) = catalog {
                if hash_file(source)? != entry.sha256 {
                    return Err(
                        "Downloaded archive checksum does not match the trusted catalog".into(),
                    );
                }
            }
            extract_archive(source, stage.path())?;
        }
        let manifest = validate_package(stage.path())?;
        if let Some(entry) = catalog {
            if manifest.id != entry.id
                || manifest.version != entry.version
                || manifest.platform != entry.platform
                || manifest.architecture != entry.architecture
                || manifest.dependencies != entry.dependencies
            {
                return Err("Archive manifest does not match the selected catalog identity, target or dependencies".into());
            }
        }
        let old = self
            .installed()?
            .into_iter()
            .find(|item| item.id == manifest.id);
        self.validate_dependencies(&manifest, old.as_ref().is_some_and(|item| item.enabled))?;
        let destination = self
            .root
            .join(format!("{}-{}", manifest.id, manifest.version));
        if destination.exists() {
            return Err(
                "This package version already exists; use rollback to activate a retained version"
                    .into(),
            );
        }
        if manifest.kind == "worker" {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    stage.path().join(&manifest.executable),
                    fs::Permissions::from_mode(0o755),
                )
                .map_err(|e| e.to_string())?;
            }
        }
        fs::rename(stage.path(), &destination).map_err(|e| e.to_string())?;
        match self.prepare_mutation(
            manifest,
            destination.clone(),
            old,
            workspace,
            catalog.map(|entry| entry.sha256.clone()),
            false,
        ) {
            Ok(mut plan) => {
                plan.remove_on_failure = true;
                Ok(plan)
            }
            Err(error) => {
                let _ = fs::remove_dir_all(destination);
                Err(error)
            }
        }
    }
    pub fn prepare_rollback(
        &mut self,
        id: &str,
        workspace: Option<&Workspace>,
    ) -> Result<MutationPlan, String> {
        let old = self
            .installed()?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("Package is not installed")?;
        let previous = old
            .previous_version
            .as_deref()
            .ok_or("No previous package version is retained")?;
        let (directory, digest): (String, String) = self
            .db
            .query_row(
                "SELECT directory,manifest_hash FROM package_versions WHERE id=?1 AND version=?2",
                params![id, previous],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if hash_file(&Path::new(&directory).join("manifest.json"))? != digest {
            return Err("Retained package manifest changed; rollback rejected".into());
        }
        let manifest = validate_package(Path::new(&directory))?;
        self.prepare_mutation(
            manifest,
            PathBuf::from(directory),
            Some(old),
            workspace,
            None,
            false,
        )
    }
    pub fn prepare_restart(
        &mut self,
        id: &str,
        workspace: &Workspace,
    ) -> Result<MutationPlan, String> {
        let old = self
            .installed()?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("Package is not installed")?;
        if !old.enabled {
            return Err("Enable this package before restarting it".into());
        }
        let manifest = self.verified_manifest(&old)?;
        validate_package(Path::new(&old.directory))?;
        self.prepare_mutation(
            manifest,
            PathBuf::from(&old.directory),
            Some(old),
            Some(workspace),
            None,
            true,
        )
    }
    pub fn accept_mutation(
        &mut self,
        plan: &mut MutationPlan,
        result: Result<Option<Arc<Worker>>, String>,
        generation: Option<u64>,
    ) -> Result<Value, String> {
        let id = &plan.manifest.id;
        let current_ticket = self
            .replacing
            .get(id)
            .is_some_and(|ticket| Arc::ptr_eq(ticket, &plan.candidate));
        if !current_ticket
            || plan.epoch != self.mutation_epoch
            || plan.generation != generation
            || plan.candidate.canceled.load(Ordering::SeqCst)
        {
            if current_ticket {
                self.replacing.remove(id);
            }
            plan.candidate.cancel();
            return Err("Package or workspace changed during replacement; review and retry".into());
        }
        self.replacing.remove(id);
        let current = self.installed()?.into_iter().find(|item| item.id == *id);
        if current != plan.old {
            plan.candidate.cancel();
            return Err("Installed package changed during replacement; review and retry".into());
        }
        let candidate = match result {
            Ok(candidate) => candidate,
            Err(error) => {
                plan.candidate.cancel();
                if let Some(old) = &plan.old {
                    let _ = self.db.execute(
                        "UPDATE packages SET error=?1 WHERE id=?2",
                        params![
                            format!(
                                "Replacement rejected; version {} retained: {error}",
                                old.version
                            ),
                            id
                        ],
                    );
                }
                return Err(error);
            }
        };
        if plan.initialize && candidate.as_ref().is_none_or(|worker| !worker.is_running()) {
            return Err("Replacement worker exited before activation".into());
        }
        if hash_file(&plan.directory.join("manifest.json"))? != plan.manifest_hash {
            return Err("Replacement manifest changed before activation".into());
        }
        let enabled = plan.old.as_ref().is_some_and(|item| item.enabled);
        self.validate_dependencies(&plan.manifest, enabled)?;
        let affected = if enabled {
            self.affected_workers(&plan.manifest)?
        } else {
            HashSet::new()
        };
        if plan.restart {
            self.db
                .execute("UPDATE packages SET error=NULL WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        } else {
            let transaction = self.db.transaction().map_err(|e| e.to_string())?;
            transaction.execute("INSERT INTO package_versions(id,version,directory,manifest_hash,archive_hash) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id,version) DO UPDATE SET directory=excluded.directory,manifest_hash=excluded.manifest_hash", params![id,plan.manifest.version,plan.directory.to_string_lossy(),plan.manifest_hash,plan.archive_hash]).map_err(|e|e.to_string())?;
            transaction.execute("INSERT INTO packages(id,version,directory,enabled,manifest_hash,previous_version,error,manifest_json) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7) ON CONFLICT(id) DO UPDATE SET version=excluded.version,directory=excluded.directory,enabled=excluded.enabled,manifest_hash=excluded.manifest_hash,previous_version=excluded.previous_version,error=NULL,manifest_json=excluded.manifest_json",params![id,plan.manifest.version,plan.directory.to_string_lossy(),enabled,plan.manifest_hash,plan.old.as_ref().map(|item|item.version.as_str()),serde_json::to_string(&plan.manifest).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        plan.accepted = true;
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        if let Some(previous) = self.workers.remove(id) {
            previous.stop();
        }
        if let Some(candidate) = candidate {
            self.workers.insert(id.clone(), candidate);
        }
        self.stop_affected(&affected, Some(id));
        self.list()
    }
    pub fn enable(&mut self, id: &str, enabled: bool) -> Result<Value, String> {
        let installed = self.installed()?;
        let item = installed
            .iter()
            .find(|item| item.id == id)
            .ok_or("Install this package first")?;
        let mut affected = HashSet::from([id.to_owned()]);
        if enabled {
            let manifest = self.verified_manifest(item)?;
            validate_package(Path::new(&item.directory))?;
            self.validate_dependencies(&manifest, true)?;
            affected = self.affected_workers(&manifest)?;
        } else {
            for other in installed
                .iter()
                .filter(|other| other.enabled && other.id != id)
            {
                if self
                    .trusted_manifest(other)
                    .is_ok_and(|manifest| manifest.dependencies.contains_key(id))
                {
                    return Err(format!("Disable dependent package {} first", other.id));
                }
            }
            if let Ok(manifest) = self.trusted_manifest(item) {
                affected = self.affected_workers(&manifest)?;
            }
        }
        if item.enabled == enabled {
            return self.list();
        }
        self.db
            .execute(
                "UPDATE packages SET enabled=?1,error=NULL WHERE id=?2",
                params![enabled, id],
            )
            .map_err(|e| e.to_string())?;
        // Unrelated workers may have tests/debug sessions in progress; keep them alive.
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        self.stop_affected(&affected, None);
        self.list()
    }
    pub fn cancel(&self, id: &str, token: &Arc<AtomicBool>) {
        for worker in self.workers.values() {
            worker.cancel(id, token);
        }
    }
    pub fn changed(&self, paths: &[String]) {
        for worker in self.workers.values() {
            let _ = worker.write(
                json!({"jsonrpc":"2.0","method":"workspace.changed","params":{"paths":paths}}),
            );
        }
    }
    pub fn running_workers(&self) -> Vec<Arc<Worker>> {
        self.workers
            .values()
            .filter(|worker| worker.is_running())
            .cloned()
            .collect()
    }
    pub fn discovery_rules(&self) -> Result<Vec<crate::workspace::DiscoveryRule>, String> {
        let mut rules = crate::workspace::default_rules()?;
        for item in self.installed()? {
            let Ok(manifest) = self.trusted_manifest(&item) else {
                continue;
            };
            for rule in manifest.discovery {
                rules.retain(|old| old.language != rule.language);
                rules.push(rule);
            }
        }
        Ok(rules)
    }
    pub fn stop_languages(&mut self, languages: &HashSet<String>) -> Result<(), String> {
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        for item in self.installed()? {
            let Ok(manifest) = self.trusted_manifest(&item) else {
                continue;
            };
            if manifest
                .languages
                .iter()
                .any(|language| languages.contains(language))
            {
                if let Some(plan) = self.replacing.remove(&item.id) {
                    plan.cancel();
                }
                if let Some(plan) = self.starting.remove(&item.id) {
                    plan.cancel();
                }
                if let Some(worker) = self.workers.remove(&item.id) {
                    worker.stop();
                }
            }
        }
        Ok(())
    }
    pub fn stop_all(&mut self) {
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        for (_, plan) in self.replacing.drain() {
            plan.cancel();
        }
        for (_, plan) in self.starting.drain() {
            plan.cancel();
        }
        for (_, worker) in self.workers.drain() {
            worker.stop();
        }
    }
    pub fn prepare_worker(
        &mut self,
        language: &str,
        workspace: &Workspace,
    ) -> Result<Arc<WorkerPlan>, String> {
        for item in self.installed()?.into_iter().filter(|item| item.enabled) {
            let Ok(metadata) = self.trusted_manifest(&item) else {
                continue;
            };
            if metadata.kind != "worker"
                || !metadata
                    .languages
                    .iter()
                    .any(|candidate| candidate == language)
            {
                continue;
            }
            let manifest = self.verified_manifest(&item)?;
            if let Some(worker) = self
                .workers
                .get(&item.id)
                .filter(|worker| worker.is_running())
            {
                return Ok(Arc::new(WorkerPlan {
                    id: item.id,
                    ready: true,
                    spec: None,
                    result: OnceLock::from(Ok(worker.clone())),
                    active: Mutex::new(None),
                    canceled: AtomicBool::new(false),
                }));
            }
            if let Some(plan) = self.starting.get(&item.id) {
                return Ok(plan.clone());
            }
            self.validate_dependencies(&manifest, true)?;
            let contexts: Vec<_> = workspace
                .contexts
                .iter()
                .filter(|context| manifest.languages.contains(&context.language))
                .collect();
            let params = json!({"root":workspace.root,"contexts":contexts,"generation":workspace.generation,"enabledPackages":self.enabled_ids()?});
            let plan = Arc::new(WorkerPlan {
                id: item.id.clone(),
                ready: false,
                result: OnceLock::new(),
                active: Mutex::new(None),
                canceled: AtomicBool::new(false),
                spec: Some(StartSpec {
                    supervisor: self.supervisor.clone(),
                    directory: PathBuf::from(&item.directory),
                    manifest,
                    manifest_hash: item.manifest_hash,
                    cache: self.root.join(".cache").join(&item.id),
                    workspace_root: workspace.root.clone(),
                    generation: workspace.generation,
                    params,
                }),
            });
            self.starting.insert(item.id, plan.clone());
            return Ok(plan);
        }
        Err(format!(
            "Install and enable the {language} package to use semantic navigation"
        ))
    }
    pub fn accept_worker(
        &mut self,
        plan: &Arc<WorkerPlan>,
        result: Result<Arc<Worker>, String>,
    ) -> Result<Arc<Worker>, String> {
        if plan.ready {
            let worker = result?;
            return if self
                .workers
                .get(&plan.id)
                .is_some_and(|active| Arc::ptr_eq(active, &worker))
                && worker.is_running()
            {
                Ok(worker)
            } else {
                Err("Package or workspace changed during request".into())
            };
        }
        // Concurrent callers share one launch; a second acceptance must not stop it.
        if let Ok(worker) = &result {
            if self
                .workers
                .get(&plan.id)
                .is_some_and(|active| Arc::ptr_eq(active, worker))
                && worker.is_running()
            {
                return Ok(worker.clone());
            }
        }
        if !self
            .starting
            .get(&plan.id)
            .is_some_and(|active| Arc::ptr_eq(active, plan))
        {
            plan.cancel();
            return Err("Package or workspace changed during startup".into());
        }
        self.starting.remove(&plan.id);
        match result {
            Ok(worker) => {
                self.workers.insert(plan.id.clone(), worker.clone());
                Ok(worker)
            }
            Err(error) => {
                let _ = self.db.execute(
                    "UPDATE packages SET error=?1 WHERE id=?2",
                    params![error, plan.id],
                );
                Err(error)
            }
        }
    }
    pub fn catalog_configure(&mut self, url: &str) -> Result<Value, String> {
        https_url(url)?;
        self.db.execute("INSERT INTO package_settings(key,value) VALUES('catalog_url',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[url]).map_err(|e|e.to_string())?;
        self.mutation_epoch = self.mutation_epoch.wrapping_add(1);
        Ok(json!({"url":url}))
    }
    fn catalog_url(&self) -> Result<String, String> {
        Ok(self
            .db
            .query_row(
                "SELECT value FROM package_settings WHERE key='catalog_url'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| DEFAULT_CATALOG_URL.into()))
    }
    pub fn catalog_request(&self) -> Result<CatalogRequest, String> {
        Ok(CatalogRequest {
            url: self.catalog_url()?,
        })
    }
    pub fn prepare_install_download(
        &mut self,
        downloaded: DownloadedPackage,
        workspace: Option<&Workspace>,
    ) -> Result<MutationPlan, String> {
        if self.catalog_url()? != downloaded.catalog_url {
            return Err(
                "Curated catalog changed during download; review the new catalog before installing"
                    .into(),
            );
        }
        self.prepare_install_source(
            downloaded.archive.path(),
            workspace,
            Some(&downloaded.entry),
        )
    }
}
/// Built-in catalog used until the user configures their own.
const DEFAULT_CATALOG_URL: &str =
    "https://github.com/grejojoby/zwip-ide/releases/download/packages/catalog.json";
fn https_url(value: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Catalog and archive URLs must use HTTPS without embedded credentials or fragments"
                .into(),
        );
    }
    Ok(url)
}
fn https_client() -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                attempt.error("HTTPS redirects cannot downgrade transport")
            } else if attempt.previous().len() >= 5 {
                attempt.error("Too many HTTPS redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}
fn parse_catalog(bytes: &[u8]) -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if catalog.version != 1 {
        return Err("Unsupported catalog version".into());
    }
    let mut identities = HashSet::new();
    for entry in &catalog.packages {
        valid_id(&entry.id)?;
        semver::Version::parse(&entry.version).map_err(|e| e.to_string())?;
        https_url(&entry.url)?;
        if !valid_digest(&entry.sha256) {
            return Err("Catalog archive checksum must be a lowercase SHA256 digest".into());
        }
        if !identities.insert((
            &entry.id,
            &entry.version,
            &entry.platform,
            &entry.architecture,
        )) {
            return Err("Duplicate catalog package identity".into());
        }
        for (id, range) in &entry.dependencies {
            valid_id(id)?;
            semver::VersionReq::parse(range).map_err(|e| e.to_string())?;
        }
    }
    Ok(catalog)
}
fn target_matches(platform: &str, architecture: &str) -> bool {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    (platform == os || platform == "any") && (architecture == arch || architecture == "any")
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        Err("Invalid package id".into())
    } else {
        Ok(())
    }
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn read_manifest(directory: &Path) -> Result<Manifest, String> {
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(directory.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    validate_routing(&manifest)?;
    Ok(manifest)
}
fn validate_routing(manifest: &Manifest) -> Result<(), String> {
    let valid_language = |language: &str| {
        !language.is_empty()
            && !language
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
    };
    if manifest
        .languages
        .iter()
        .any(|language| !valid_language(language))
    {
        return Err("Invalid package discovery language".into());
    }
    let mut extensions = manifest.document_extensions.iter().collect::<Vec<_>>();
    if let Some(syntax) = &manifest.syntax {
        if syntax.abi != 1 || syntax.extensions.is_empty() && syntax.file_names.is_empty() {
            return Err("Unsupported syntax ABI or empty extension list".into());
        }
        if syntax.file_names.iter().any(|name| {
            name.is_empty()
                || name.starts_with('.')
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        }) {
            return Err("Package syntax file names must be plain file names".into());
        }
        relative_path(&syntax.asset)?;
        if !manifest.checksums.contains_key(&syntax.asset) {
            return Err("Package syntax asset must have a checksum".into());
        }
        extensions.extend(syntax.extensions.iter());
    }
    for rule in &manifest.discovery {
        if !valid_language(&rule.language) {
            return Err("Invalid package discovery language".into());
        }
        extensions.extend(rule.document_extensions.iter());
        for pattern in rule.config_globs.iter().chain(&rule.configuration_globs) {
            if pattern.is_empty() {
                return Err("Package discovery glob cannot be empty".into());
            }
            globset::Glob::new(pattern)
                .map_err(|error| format!("Invalid package discovery glob: {error}"))?;
        }
    }
    if extensions.iter().any(|extension| {
        extension.is_empty()
            || !extension
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    }) {
        return Err(
            "Package document extensions must be suffixes without dots or path separators".into(),
        );
    }
    Ok(())
}
fn relative_path(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Package paths must be relative without traversal".into());
    }
    Ok(path)
}
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32768];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub fn validate_package(directory: &Path) -> Result<Manifest, String> {
    let manifest = read_manifest(directory)?;
    valid_id(&manifest.id)?;
    semver::Version::parse(&manifest.version).map_err(|e| e.to_string())?;
    if !semver::VersionReq::parse(&manifest.core_version)
        .map_err(|e| e.to_string())?
        .matches(&semver::Version::new(0, 1, 0))
    {
        return Err("Package requires a different IDE version".into());
    }
    match manifest.kind.as_str() {
        "worker" => {
            relative_path(&manifest.executable)?;
            if !manifest.checksums.contains_key(&manifest.executable) {
                return Err("Package executable must have a checksum".into());
            }
            for arg in &manifest.args {
                relative_path(arg)?;
                if !manifest.checksums.contains_key(arg) {
                    return Err(
                        "Package entry arguments must be checksummed relative assets".into(),
                    );
                }
            }
        }
        "feature" => {
            if !manifest.executable.is_empty() || !manifest.args.is_empty() {
                return Err("Declarative feature packages cannot execute processes".into());
            }
        }
        _ => return Err("Unknown package kind".into()),
    }
    if !target_matches(&manifest.platform, &manifest.architecture)
        || manifest.kind == "worker"
            && (manifest.platform == "any" || manifest.architecture == "any")
    {
        return Err("Package architecture/platform is incompatible with this host".into());
    }
    for (id, range) in &manifest.dependencies {
        valid_id(id)?;
        semver::VersionReq::parse(range).map_err(|e| e.to_string())?;
    }
    let mut inventory = HashSet::new();
    collect_assets(directory, directory, &mut inventory)?;
    for (name, expected) in &manifest.checksums {
        relative_path(name)?;
        if name == "manifest.json" || !valid_digest(expected) {
            return Err("Invalid asset checksum record".into());
        }
        if !inventory.remove(name) {
            return Err(format!("Package checksum names a missing asset: {name}"));
        }
        if hash_file(&directory.join(name))? != *expected {
            return Err(format!("Package checksum mismatch: {name}"));
        }
    }
    if !inventory.is_empty() {
        return Err(format!(
            "Package contains unchecked assets: {}",
            inventory.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(manifest)
}
fn collect_assets(
    root: &Path,
    directory: &Path,
    assets: &mut HashSet<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Package symlinks are not supported".into());
        }
        if kind.is_dir() {
            collect_assets(root, &entry.path(), assets)?;
        } else if kind.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative != "manifest.json" {
                assets.insert(relative);
            }
        } else {
            return Err("Package contains a non-regular asset".into());
        }
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let destination = target.join(entry.file_name());
        if kind.is_symlink() {
            return Err("Package symlinks are not supported".into());
        }
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), destination).map_err(|e| e.to_string())?;
        } else {
            return Err("Package contains a non-regular asset".into());
        }
    }
    Ok(())
}
fn extract_archive(source: &Path, target: &Path) -> Result<(), String> {
    if fs::metadata(source).map_err(|e| e.to_string())?.len() > MAX_ARCHIVE {
        return Err("Package archive exceeds 256 MiB".into());
    }
    let mut archive = zip::ZipArchive::new(fs::File::open(source).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if archive.len() > 50000 {
        return Err("Package archive contains too many entries".into());
    }
    let mut total = 0_u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry
            .enclosed_name()
            .ok_or("Unsafe package archive path")?
            .to_owned();
        relative_path(name.to_str().ok_or("Archive path is not UTF-8")?)?;
        if !names.insert(name.clone()) {
            return Err("Package archive contains duplicate paths".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Package symlinks are not supported".into());
        }
        total = total.checked_add(entry.size()).ok_or("Archive too large")?;
        if total > MAX_EXPANDED {
            return Err("Package expands beyond 768 MiB".into());
        }
        let path = target.join(name);
        if entry.is_dir() {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let expected = entry.size();
            let written = std::io::copy(
                &mut entry.by_ref().take(expected + 1),
                &mut fs::File::create(&path).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if written != expected {
                return Err("Archive entry size does not match its header".into());
            }
            // Keep archived executables (such as a bundled debugger) runnable; never setuid.
            #[cfg(unix)]
            if entry.unix_mode().is_some_and(|mode| mode & 0o111 != 0) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn archive(root: &Path, manifest_id: &str) -> PathBuf {
        let bytes = b"{\"feature\":true}";
        let checksum = format!("{:x}", Sha256::digest(bytes));
        let manifest = json!({"id":manifest_id,"name":"Feature","version":"0.1.0","coreVersion":"^0.1.0","description":"fixture","kind":"feature","platform":"any","architecture":"any","capabilities":[],"languages":[],"checksums":{"features.json":checksum}});
        let path = root.join("package.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("features.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
        zip.finish().unwrap();
        path
    }
    fn entry(digest: String) -> CatalogEntry {
        CatalogEntry {
            id: "fixture".into(),
            name: "Fixture".into(),
            version: "0.1.0".into(),
            url: "https://catalog.example.test/fixture.zip".into(),
            sha256: digest,
            platform: "any".into(),
            architecture: "any".into(),
            dependencies: BTreeMap::new(),
        }
    }
    #[test]
    fn trusted_catalog_archive_digest_and_manifest_identity_are_both_required() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let mut host = PackageHost::new(data.path()).unwrap();
        let path = archive(source.path(), "fixture");
        assert!(host
            .prepare_install_source(&path, None, Some(&entry("0".repeat(64))))
            .err()
            .unwrap()
            .contains("trusted catalog"));
        let valid = entry(hash_file(&path).unwrap());
        let mut plan = host
            .prepare_install_source(&path, None, Some(&valid))
            .unwrap();
        let result = plan.start();
        host.accept_mutation(&mut plan, result, None).unwrap();
        assert!(host
            .list()
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "fixture" && item["installed"] == true));
        let other_data = tempfile::tempdir().unwrap();
        let mut other = PackageHost::new(other_data.path()).unwrap();
        let substituted = archive(source.path(), "substituted");
        let expected = entry(hash_file(&substituted).unwrap());
        assert!(other
            .prepare_install_source(&substituted, None, Some(&expected))
            .err()
            .unwrap()
            .contains("catalog identity"));
    }
    #[test]
    fn catalog_defaults_to_builtin_url_until_configured() {
        let data = tempfile::tempdir().unwrap();
        let mut host = PackageHost::new(data.path()).unwrap();
        assert_eq!(host.catalog_url().unwrap(), DEFAULT_CATALOG_URL);
        https_url(DEFAULT_CATALOG_URL).unwrap();
        host.catalog_configure("https://catalog.example.test/catalog.json")
            .unwrap();
        assert_eq!(
            host.catalog_url().unwrap(),
            "https://catalog.example.test/catalog.json"
        );
    }
    #[test]
    fn catalog_rejects_insecure_archive_urls_and_duplicate_identities() {
        let mut item = entry("a".repeat(64));
        item.url = "http://catalog.example.test/fixture.zip".into();
        assert!(parse_catalog(
            &serde_json::to_vec(&Catalog {
                version: 1,
                packages: vec![item]
            })
            .unwrap()
        )
        .unwrap_err()
        .contains("HTTPS"));
        let item = entry("a".repeat(64));
        assert!(parse_catalog(
            &serde_json::to_vec(&Catalog {
                version: 1,
                packages: vec![item.clone(), item]
            })
            .unwrap()
        )
        .unwrap_err()
        .contains("Duplicate"));
    }

    #[cfg(unix)]
    #[test]
    fn extraction_keeps_archived_executable_bits() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("tools.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&source).unwrap());
        for (name, mode) in [("bin/dlv", 0o755), ("LICENSE", 0o644)] {
            writer
                .start_file(name, SimpleFileOptions::default().unix_permissions(mode))
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();
        let target = root.path().join("out");
        extract_archive(&source, &target).unwrap();
        let mode = |name: &str| {
            fs::metadata(target.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("bin/dlv"), 0o755);
        assert_eq!(mode("LICENSE") & 0o111, 0);
    }
}
