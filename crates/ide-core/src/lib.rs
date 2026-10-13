mod connections;
mod documents;
mod edits;
mod files;
mod git;
mod intellij_import;
mod packages;
mod recovery;
mod semantic;
mod tasks;
mod terminal;
mod worker;
mod workspace;
use documents::{Delta, Documents};
use notify::Watcher;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub struct Core {
    active_queries: Mutex<HashMap<String, semantic::ProgressSource>>,
    closed: AtomicBool,
    shutdown_lock: Mutex<()>,
    worker_supervisor: Arc<worker::Supervisor>,
    file_plan: Mutex<Option<files::FilePlan>>,
    connections: Mutex<connections::Connections>,
    terminals: terminal::Terminals,
    edits: Mutex<edits::Edits>,
    analysis_epoch: Arc<AtomicU64>,
    workspace_transition: Mutex<()>,
    workspace: Mutex<Option<Arc<workspace::Workspace>>>,
    documents: Mutex<Documents>,
    generation: AtomicU64,
    data: PathBuf,
    packages: Mutex<packages::PackageHost>,
    canceled: Mutex<HashMap<String, semantic::Cancellation>>,
    tasks: tasks::Tasks,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    file_events: Arc<Mutex<HashSet<String>>>,
}
impl Core {
    pub fn new(data: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let documents = Documents::new(&data).map_err(std::io::Error::other)?;
        let connections = connections::Connections::new(&data).map_err(std::io::Error::other)?;
        let packages = packages::PackageHost::new(&data).map_err(std::io::Error::other)?;
        let worker_supervisor = packages.supervisor();
        Ok(Self {
            active_queries: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            shutdown_lock: Mutex::new(()),
            worker_supervisor,
            file_plan: Mutex::new(None),
            connections: Mutex::new(connections),
            terminals: terminal::Terminals::default(),
            edits: Mutex::new(edits::Edits::default()),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            workspace_transition: Mutex::new(()),
            watcher: Mutex::new(None),
            file_events: Arc::new(Mutex::new(HashSet::new())),
            tasks: tasks::Tasks::default(),
            packages: Mutex::new(packages),
            canceled: Mutex::new(HashMap::new()),
            workspace: Mutex::new(None),
            documents: Mutex::new(documents),
            generation: AtomicU64::new(0),
            data,
        })
    }
    fn current(&self) -> Result<Arc<workspace::Workspace>, String> {
        self.ensure_open()?;
        self.workspace
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("Open a workspace first".into())
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_open()?;
        let affects_analysis = matches!(
            method,
            "package.enable"
                | "package.install"
                | "package.installCatalog"
                | "package.restart"
                | "package.rollback"
        );
        if affects_analysis {
            self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
        }
        let result = self.dispatch(method, params);
        if affects_analysis {
            self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
        }
        result
    }
    fn ensure_open(&self) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            Err("Application is shutting down".into())
        } else {
            Ok(())
        }
    }
    /// Called at final application exit, never while holding the package host lock.
    /// Accepted document changes are already committed to the recovery database.
    pub fn shutdown(&self) {
        let _shutdown = self
            .shutdown_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _transition = self
            .workspace_transition
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
        self.watcher
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.tasks.stop_all();
        self.terminals.stop_all();
        // Closing the registry also cancels a worker initializing outside the
        // host lock and prevents any launch ticket from creating a late child.
        self.worker_supervisor.shutdown();
        self.packages
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .stop_all();
        // Wait for an already accepted document delta to finish persisting recovery.
        drop(
            self.documents
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
    }
    fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "workspace.createFile"
            | "workspace.createDirectory"
            | "workspace.filePreview"
            | "workspace.fileApply"
            | "workspace.trashList"
            | "workspace.trashRestore" => self.files(method, &params),
            "workspace.rescan" => {
                let _transition = self
                    .workspace_transition
                    .lock()
                    .map_err(|e| e.to_string())?;
                let previous = self.current()?;
                let mut workspace = workspace::scan(
                    &PathBuf::from(&previous.root),
                    previous.generation,
                    &self.discovery_rules()?,
                )?;
                if params["reanalyze"] == true || workspace.contexts != previous.contexts {
                    let languages = previous
                        .contexts
                        .iter()
                        .chain(workspace.contexts.iter())
                        .map(|context| context.language.clone())
                        .collect();
                    self.packages
                        .lock()
                        .map_err(|e| e.to_string())?
                        .stop_languages(&languages)?;
                    workspace.generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                    for document in self
                        .documents
                        .lock()
                        .map_err(|e| e.to_string())?
                        .open
                        .values_mut()
                    {
                        document.workspace_generation = workspace.generation;
                    }
                }
                *self.workspace.lock().map_err(|e| e.to_string())? =
                    Some(Arc::new(workspace.clone()));
                serde_json::to_value(workspace).map_err(|e| e.to_string())
            }
            "workspace.refresh" => {
                let _transition = self
                    .workspace_transition
                    .lock()
                    .map_err(|e| e.to_string())?;
                let previous = self.current()?;
                let generation = self.generation.load(Ordering::SeqCst) + 1;
                let workspace = workspace::scan(
                    &PathBuf::from(&previous.root),
                    generation,
                    &self.discovery_rules()?,
                )?;
                self.packages.lock().map_err(|e| e.to_string())?.stop_all();
                self.generation.store(generation, Ordering::SeqCst);
                for document in self
                    .documents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .open
                    .values_mut()
                {
                    document.workspace_generation = generation;
                }
                *self.workspace.lock().map_err(|e| e.to_string())? =
                    Some(Arc::new(workspace.clone()));
                serde_json::to_value(workspace).map_err(|e| e.to_string())
            }
            "workspace.open" => {
                let _transition = self
                    .workspace_transition
                    .lock()
                    .map_err(|e| e.to_string())?;
                self.ensure_open()?;
                let root = string(&params, "root")?.to_owned();
                let generation = self.generation.load(Ordering::SeqCst) + 1;
                let workspace =
                    workspace::scan(&PathBuf::from(root), generation, &self.discovery_rules()?)?;
                // Changes accepted while discovery was running must survive a
                // switch. Keep this guard through publication so no delta can
                // become dirty between the check and releasing the old mirrors.
                let mut documents = self.documents.lock().map_err(|e| e.to_string())?;
                if documents.open.values().any(|document| document.dirty) {
                    return Err("Save unsaved buffers before switching workspaces. Your edits and recovery records have been preserved.".into());
                }
                self.watch(&workspace.root)?;
                self.tasks.stop_all();
                self.terminals.stop_all();
                self.packages.lock().map_err(|e| e.to_string())?.stop_all();
                self.generation.store(generation, Ordering::SeqCst);
                documents.clear();
                *self.workspace.lock().map_err(|e| e.to_string())? =
                    Some(Arc::new(workspace.clone()));
                serde_json::to_value(workspace).map_err(|e| e.to_string())
            }
            "workspace.changes" => {
                let paths = self
                    .file_events
                    .lock()
                    .map_err(|e| e.to_string())?
                    .drain()
                    .collect::<Vec<_>>();
                if !paths.is_empty() {
                    self.packages
                        .lock()
                        .map_err(|e| e.to_string())?
                        .changed(&paths);
                }
                let rules = self.discovery_rules()?;
                let configuration_changed = paths
                    .iter()
                    .any(|path| workspace::is_configuration(path, &rules));
                Ok(json!({"paths":paths,"configurationChanged":configuration_changed}))
            }
            "workspace.status" => self.workspace_status(),
            "document.sync" => {
                self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                self.documents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .sync(&document_key(string(&params, "path")?))
            }
            "document.rejectSync" => {
                self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                self.documents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .reject_sync(
                        &document_key(string(&params, "path")?),
                        params["revision"].as_u64().ok_or("Missing sync revision")?,
                    )
            }
            "workspace.editPreview" => {
                let workspace = self.current()?;
                if params["workspaceGeneration"].as_u64() != Some(workspace.generation) {
                    return Err("Workspace changed since analysis".into());
                }
                let edits =
                    serde_json::from_value(params["edits"].clone()).map_err(|e| e.to_string())?;
                let mut docs = self.documents.lock().map_err(|e| e.to_string())?;
                serde_json::to_value(self.edits.lock().map_err(|e| e.to_string())?.preview(
                    edits,
                    &mut docs,
                    &workspace.root,
                    workspace.generation,
                )?)
                .map_err(|e| e.to_string())
            }
            "workspace.editApply" => {
                let workspace = self.current()?;
                let mut docs = self.documents.lock().map_err(|e| e.to_string())?;
                let result = self.edits.lock().map_err(|e| e.to_string())?.apply(
                    string(&params, "id")?,
                    &mut docs,
                    workspace.generation,
                )?;
                self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "document.open" => {
                let workspace = self.current()?;
                let path = workspace::canonical_file(string(&params, "path")?)?;
                let doc = self
                    .documents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .open(&path, workspace.generation)?;
                serde_json::to_value(doc).map_err(|e| e.to_string())
            }
            "document.close" => {
                let path = document_key(string(&params, "path")?);
                let revision = params["revision"].as_u64().ok_or("Missing revision")?;
                let released = self
                    .documents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .close(&path, revision)?;
                if released {
                    self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                    let workers = self
                        .packages
                        .lock()
                        .map_err(|e| e.to_string())?
                        .running_workers();
                    for worker in workers {
                        let mut revisions = worker.revisions.lock().map_err(|e| e.to_string())?;
                        worker.write(json!({"jsonrpc":"2.0","method":"document.close","params":{"path":path}}))?;
                        revisions.remove(&path);
                    }
                }
                Ok(json!({"released":released}))
            }
            "recovery.list" | "recovery.restoreCopy" | "recovery.discard" => {
                let workspace = self.current()?;
                self.documents.lock().map_err(|e| e.to_string())?.recovery(
                    method,
                    &params,
                    &workspace.root,
                )
            }
            "document.change" | "document.save" => {
                let workspace = self.current()?;
                // Existing mirrors remain editable after external deletion. Saves
                // still compare the disk baseline and cannot recreate implicitly.
                let path = PathBuf::from(document_key(string(&params, "path")?));
                Documents::ensure_writable(&path, &workspace.root)?;
                let path = path.to_string_lossy().into_owned();
                let revision = params["revision"]
                    .as_u64()
                    .ok_or("Missing document revision")?;
                let mut docs = self.documents.lock().map_err(|e| e.to_string())?;
                if method == "document.change" {
                    self.analysis_epoch.fetch_add(1, Ordering::SeqCst);
                    let changes: Vec<Delta> = serde_json::from_value(params["changes"].clone())
                        .map_err(|e| e.to_string())?;
                    docs.change(&path, revision, changes)
                } else {
                    serde_json::to_value(docs.save(&path, revision)?).map_err(|e| e.to_string())
                }
            }
            "settings.get" => {
                use rusqlite::OptionalExtension;
                let key = string(&params, "key")?;
                let docs = self.documents.lock().map_err(|e| e.to_string())?;
                let value: Option<String> = docs
                    .db
                    .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                        row.get(0)
                    })
                    .optional()
                    .map_err(|e| e.to_string())?;
                match value {
                    Some(value) => serde_json::from_str(&value).map_err(|e| e.to_string()),
                    None => Ok(Value::Null),
                }
            }
            "settings.set" => {
                let key = string(&params, "key")?;
                let value = params.get("value").ok_or("Missing setting value")?;
                if key.len() > 1024 || value.to_string().len() > 256 * 1024 {
                    return Err("Setting is too large".into());
                }
                if key == "history" {
                    let days = value["retentionDays"]
                        .as_u64()
                        .ok_or("Missing history retention days")?;
                    let bytes = value["maxBytes"]
                        .as_u64()
                        .ok_or("Missing history size limit")?;
                    if !(1..=365).contains(&days)
                        || !(16 * 1024 * 1024..=1024 * 1024 * 1024).contains(&bytes)
                    {
                        return Err("History retention must be 1–365 days and 16–1024 MiB".into());
                    }
                }
                self.documents.lock().map_err(|e|e.to_string())?.db.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,value.to_string()]).map_err(|e|e.to_string())?;
                Ok(value.clone())
            }
            "document.history" => self
                .documents
                .lock()
                .map_err(|e| e.to_string())?
                .history(&document_key(string(&params, "path")?)),
            "workspace.search" => {
                let workspace = self.current()?;
                let query = string(&params, "query")?;
                if query.is_empty() {
                    return Ok(json!([]));
                }
                let mut matches = Vec::new();
                for file in workspace
                    .files
                    .iter()
                    .filter(|file| file.size <= 2 * 1024 * 1024)
                {
                    if let Ok(content) = std::fs::read_to_string(&file.path) {
                        for (line, text) in content.lines().enumerate() {
                            if text.contains(query) {
                                matches.push(json!({"path":file.path,"line":line,"text":text}));
                                if matches.len() >= 1000 {
                                    return Ok(json!(matches));
                                }
                            }
                        }
                    }
                }
                Ok(json!(matches))
            }
            "terminal.start" => {
                let _starting = self.shutdown_lock.lock().map_err(|e| e.to_string())?;
                self.ensure_open()?;
                let workspace = self.current()?;
                self.terminals.start(
                    std::path::Path::new(&workspace.root),
                    number(&params, "rows")?,
                    number(&params, "cols")?,
                )
            }
            "terminal.read" => self.terminals.read(
                string(&params, "id")?,
                params["cursor"].as_u64().unwrap_or(0),
            ),
            "terminal.write" => {
                let bytes: Vec<u8> =
                    serde_json::from_value(params["bytes"].clone()).map_err(|e| e.to_string())?;
                self.terminals.write(string(&params, "id")?, &bytes)?;
                Ok(Value::Null)
            }
            "terminal.resize" => {
                self.terminals.resize(
                    string(&params, "id")?,
                    number(&params, "rows")?,
                    number(&params, "cols")?,
                )?;
                Ok(Value::Null)
            }
            "terminal.stop" => {
                self.terminals.stop(string(&params, "id")?);
                Ok(Value::Null)
            }
            "task.start" => {
                let _starting = self.shutdown_lock.lock().map_err(|e| e.to_string())?;
                self.ensure_open()?;
                let workspace = self.current()?;
                let cwd = PathBuf::from(params["cwd"].as_str().unwrap_or(&workspace.root))
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !cwd.starts_with(&workspace.root) {
                    return Err("Task directory must be inside the workspace".into());
                }
                self.tasks.start(string(&params, "command")?, &cwd)
            }
            "task.status" => self.tasks.status(string(&params, "id")?),
            "task.stop" => {
                self.tasks.stop(string(&params, "id")?)?;
                Ok(Value::Null)
            }
            method if method.starts_with("git.") => {
                git::dispatch(&self.current()?.root, &self.data, method, &params)
            }
            "intellij.preview" => {
                let mut preview = intellij_import::read(&params)?;
                preview.check_duplicates(&*self.connections.lock().map_err(|e| e.to_string())?)?;
                serde_json::to_value(preview).map_err(|_| "Cannot encode import preview".into())
            }
            "intellij.importConnections" => {
                let preview = intellij_import::read(&params)?;
                if params["fingerprint"].as_str() != Some(preview.fingerprint.as_str()) {
                    return Err("Import source changed; preview it again before importing".into());
                }
                let selected = preview.select(&params["ids"])?;
                self.connections
                    .lock()
                    .map_err(|e| e.to_string())?
                    .import_batch(&selected)
            }
            "connection.list" => self.connections.lock().map_err(|e| e.to_string())?.list(),
            "connection.save" => self
                .connections
                .lock()
                .map_err(|e| e.to_string())?
                .save(&params),
            "connection.delete" => self
                .connections
                .lock()
                .map_err(|e| e.to_string())?
                .delete(string(&params, "id")?),
            "tool.request" => {
                let workspace = self.current()?;
                let package = string(&params, "packageId")?;
                let mut args = params["params"].clone();
                if let Some(id) = args["connectionId"].as_str() {
                    let config = self
                        .connections
                        .lock()
                        .map_err(|e| e.to_string())?
                        .resolved(id)?;
                    let required = if config["kind"] == "redis" {
                        "redis"
                    } else {
                        "sql"
                    };
                    if package != required {
                        return Err("Connection and package do not match".into());
                    }
                    args["connection"] = config;
                }
                let worker = self.language_worker(package, &workspace)?;
                if params["synchronizeDocuments"] == true {
                    self.synchronize_overlays(&worker)?;
                }
                worker.request(
                    "tool.request",
                    json!({"method":string(&params,"method")?,"params":args}),
                )
            }
            "package.list" => self.packages.lock().map_err(|e| e.to_string())?.list(),
            "package.syntax" => self
                .packages
                .lock()
                .map_err(|e| e.to_string())?
                .syntax_asset(string(&params, "extension")?),
            "package.install" => self.package_mutation(|host, workspace| {
                host.prepare_install(&PathBuf::from(string(&params, "path")?), workspace)
            }),
            "package.catalogConfigure" => self
                .packages
                .lock()
                .map_err(|e| e.to_string())?
                .catalog_configure(string(&params, "url")?),
            "package.catalog" => {
                let request = self
                    .packages
                    .lock()
                    .map_err(|e| e.to_string())?
                    .catalog_request()?;
                request.catalog()
            }
            "package.installCatalog" => {
                let request = self
                    .packages
                    .lock()
                    .map_err(|e| e.to_string())?
                    .catalog_request()?;
                let downloaded =
                    request.download(string(&params, "id")?, string(&params, "version")?)?;
                self.package_mutation(|host, workspace| {
                    host.prepare_install_download(downloaded, workspace)
                })
            }
            "package.restart" => self.package_mutation(|host, workspace| {
                host.prepare_restart(
                    string(&params, "id")?,
                    workspace.ok_or("Open a workspace first")?,
                )
            }),
            "package.rollback" => self.package_mutation(|host, workspace| {
                host.prepare_rollback(string(&params, "id")?, workspace)
            }),
            "package.enable" => self.packages.lock().map_err(|e| e.to_string())?.enable(
                string(&params, "id")?,
                params["enabled"].as_bool().ok_or("Missing enabled flag")?,
            ),
            "workspace.symbols" => self.workspace_symbols(&params),
            "navigation.progress" => self.navigation_progress(string(&params, "id")?),
            "navigation.query" | "editor.request" => self.semantic(method, &params["query"]),
            "navigation.cancel" => {
                let id = string(&params, "id")?;
                if let Some(token) = self.cancel_query(id)? {
                    self.packages
                        .lock()
                        .map_err(|e| e.to_string())?
                        .cancel(id, &token);
                }
                Ok(Value::Null)
            }
            "app.info" => Ok(json!({"version":"0.1.0","dataDirectory":self.data})),
            _ => Err(format!("Unsupported operation: {method}")),
        }
    }
    fn discovery_rules(&self) -> Result<Vec<workspace::DiscoveryRule>, String> {
        self.packages
            .lock()
            .map_err(|e| e.to_string())?
            .discovery_rules()
    }
    fn package_mutation(
        &self,
        prepare: impl FnOnce(
            &mut packages::PackageHost,
            Option<&workspace::Workspace>,
        ) -> Result<packages::MutationPlan, String>,
    ) -> Result<Value, String> {
        let workspace = self.current().ok();
        let mut plan = {
            let mut host = self.packages.lock().map_err(|e| e.to_string())?;
            self.ensure_open()?;
            if workspace.as_ref().is_some_and(|workspace| {
                self.generation.load(Ordering::SeqCst) != workspace.generation
            }) {
                return Err("Workspace is changing; retry when ready".into());
            }
            prepare(&mut host, workspace.as_deref())?
        };
        let result = plan.start();
        // Serialize only acceptance with workspace replacement, never initialization.
        let _transition = self
            .workspace_transition
            .lock()
            .map_err(|e| e.to_string())?;
        self.ensure_open()?;
        let generation = self.current().ok().map(|workspace| workspace.generation);
        self.packages
            .lock()
            .map_err(|e| e.to_string())?
            .accept_mutation(&mut plan, result, generation)
    }
    fn language_worker(
        &self,
        language: &str,
        workspace: &workspace::Workspace,
    ) -> Result<Arc<worker::Worker>, String> {
        self.ensure_open()?;
        if self.closed.load(Ordering::Acquire)
            || self.generation.load(Ordering::SeqCst) != workspace.generation
        {
            return Err("Workspace is changing; retry when ready".into());
        }
        let plan = self
            .packages
            .lock()
            .map_err(|e| e.to_string())?
            .prepare_worker(language, workspace)?;
        let result = plan.start();
        let worker = self
            .packages
            .lock()
            .map_err(|e| e.to_string())?
            .accept_worker(&plan, result)?;
        if self.generation.load(Ordering::SeqCst) != workspace.generation {
            worker.stop();
            return Err("Workspace changed during package startup".into());
        }
        Ok(worker)
    }
    fn watch(&self, root: &str) -> Result<(), String> {
        let events = self.file_events.clone();
        let epoch = self.analysis_epoch.clone();
        let watched_root = root.to_owned();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    if let Ok(mut events) = events.lock() {
                        for path in event.paths {
                            if path.components().any(|part| {
                                matches!(
                                    part.as_os_str().to_str(),
                                    Some(
                                        "node_modules"
                                            | "target"
                                            | "dist"
                                            | ".next"
                                            | ".cache"
                                            | ".claude"
                                    )
                                )
                            }) {
                                continue;
                            }
                            let display = path.to_string_lossy().into_owned();
                            if let Some((_, suffix)) = display.split_once("/.git/") {
                                if suffix != "HEAD" && !suffix.starts_with("refs/") {
                                    continue;
                                }
                            }
                            epoch.fetch_add(1, Ordering::SeqCst);
                            if events.len() < 2048 {
                                events.insert(display);
                            } else {
                                events.clear();
                                events.insert(watched_root.clone());
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        watcher
            .watch(std::path::Path::new(root), notify::RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        *self.watcher.lock().map_err(|e| e.to_string())? = Some(watcher);
        self.file_events.lock().map_err(|e| e.to_string())?.clear();
        Ok(())
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing string field: {key}"))
}

fn number(value: &Value, key: &str) -> Result<u16, String> {
    value[key]
        .as_u64()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| format!("Invalid integer field: {key}"))
}

fn document_key(path: &str) -> String {
    std::path::Path::new(path)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.into())
}

#[cfg(test)]
mod workspace_transition_tests {
    use super::*;
    use std::{
        fs, thread,
        time::{Duration, Instant},
    };

    #[test]
    fn edits_accepted_during_workspace_discovery_prevent_switch() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let path = first.path().join("note.txt");
        fs::write(&path, "saved").unwrap();
        let core = Core::new(data.path().to_owned()).unwrap();
        let before = core
            .request("workspace.open", json!({"root":first.path()}))
            .unwrap();
        core.request("document.open", json!({"path":path})).unwrap();
        // Hold discovery at its package-rules read, after the transition began.
        // A document delta remains available while the next workspace is scanned.
        let packages = core.packages.lock().unwrap();
        thread::scope(|scope| {
            let opening =
                scope.spawn(|| core.request("workspace.open", json!({"root":second.path()})));
            let deadline = Instant::now() + Duration::from_secs(5);
            let began = loop {
                if matches!(
                    core.workspace_transition.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ) {
                    break true;
                }
                if Instant::now() >= deadline {
                    break false;
                }
                thread::sleep(Duration::from_millis(1));
            };
            let edited = core.request("document.change", json!({"path":path,"revision":1,"changes":[{"from":0,"to":5,"insert":"typed during discovery"}]}));
            drop(packages);
            let result = opening.join().unwrap();
            assert!(began, "workspace transition did not start");
            edited.unwrap();
            assert!(result.unwrap_err().contains("unsaved"));
        });
        let document = core.request("document.open", json!({"path":path})).unwrap();
        assert_eq!(document["content"], "typed during discovery");
        assert_eq!(document["workspaceGeneration"], before["generation"]);
        assert_eq!(
            core.request("workspace.status", json!({})).unwrap()["generation"],
            before["generation"]
        );
        assert_eq!(
            core.request("recovery.list", json!({})).unwrap()[0]["preview"],
            "typed during discovery"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
    }
}
