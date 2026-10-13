use crate::{documents, string, worker, workspace, Core};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub(crate) enum Cancellation {
    Active(Arc<AtomicBool>),
    BeforeStart(Instant),
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[test]
    fn cancellation_leases_preserve_prestart_cancel_expire_tombstones_and_allow_reuse() {
        let data = tempfile::tempdir().unwrap();
        let core = Core::new(data.path().to_owned()).unwrap();
        assert!(core.cancel_query("before").unwrap().is_none());
        let before = QueryLease::new(&core, "before").unwrap();
        assert!(before.canceled.load(Ordering::Acquire));
        assert!(QueryLease::new(&core, "before").is_err());
        drop(before);
        let fresh = QueryLease::new(&core, "before").unwrap();
        assert!(!fresh.canceled.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(
            &core.cancel_query("before").unwrap().unwrap(),
            &fresh.canceled
        ));
        assert!(fresh.canceled.load(Ordering::Acquire));
        drop(fresh);
        core.canceled.lock().unwrap().insert(
            "expired".into(),
            Cancellation::BeforeStart(Instant::now() - Duration::from_secs(3601)),
        );
        assert!(!QueryLease::new(&core, "expired")
            .unwrap()
            .canceled
            .load(Ordering::Acquire));
    }
}

#[derive(Clone)]
pub(crate) struct ProgressSource {
    epoch: u64,
    generation: u64,
    revision: u64,
    path: String,
    external: bool,
    disk_hash: String,
    canceled: Arc<AtomicBool>,
}
struct QueryLease<'a> {
    core: &'a Core,
    id: &'a str,
    canceled: Arc<AtomicBool>,
}
impl<'a> QueryLease<'a> {
    fn new(core: &'a Core, id: &'a str) -> Result<Self, String> {
        let mut registry = core.canceled.lock().map_err(|e| e.to_string())?;
        registry.retain(|_, entry| !matches!(entry, Cancellation::BeforeStart(at) if at.elapsed() >= Duration::from_secs(3600)));
        if matches!(registry.get(id), Some(Cancellation::Active(_))) {
            return Err("Query ID is already active".into());
        }
        let canceled = Arc::new(AtomicBool::new(registry.remove(id).is_some()));
        registry.insert(id.into(), Cancellation::Active(canceled.clone()));
        Ok(Self { core, id, canceled })
    }
}
impl Drop for QueryLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.core.canceled.lock() {
            if matches!(registry.get(self.id), Some(Cancellation::Active(token)) if Arc::ptr_eq(token, &self.canceled))
            {
                // Keep ID reuse fenced until the prior progress source is removed.
                if let Ok(mut queries) = self.core.active_queries.lock() {
                    queries.remove(self.id);
                }
                registry.remove(self.id);
            }
        }
    }
}

impl Core {
    pub(crate) fn cancel_query(&self, id: &str) -> Result<Option<Arc<AtomicBool>>, String> {
        let mut registry = self.canceled.lock().map_err(|e| e.to_string())?;
        registry.retain(|_, entry| !matches!(entry, Cancellation::BeforeStart(at) if at.elapsed() >= Duration::from_secs(3600)));
        if let Some(Cancellation::Active(token)) = registry.get(id) {
            token.store(true, Ordering::Release);
            Ok(Some(token.clone()))
        } else {
            registry.insert(id.into(), Cancellation::BeforeStart(Instant::now()));
            Ok(None)
        }
    }
    pub(crate) fn navigation_progress(&self, id: &str) -> Result<Value, String> {
        let source = self
            .active_queries
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned();
        let Some(source) = source else {
            return Ok(Value::Null);
        };
        if source.epoch != self.analysis_epoch.load(Ordering::SeqCst)
            || source.generation != self.generation.load(Ordering::SeqCst)
            || source.canceled.load(Ordering::Acquire)
            || self
                .documents
                .lock()
                .map_err(|e| e.to_string())?
                .open
                .get(&source.path)
                .is_none_or(|doc| doc.revision != source.revision)
            || (source.external
                && std::fs::read(&source.path)
                    .map(|bytes| documents::hash(&bytes) != source.disk_hash)
                    .unwrap_or(true))
        {
            return Ok(Value::Null);
        }
        let workers = self
            .packages
            .lock()
            .map_err(|e| e.to_string())?
            .running_workers();
        for worker in workers {
            if let Some(mut batch) = worker.progress(id) {
                let provider_revision = if source.external { 0 } else { source.revision };
                if batch["documentRevision"].as_u64() == Some(provider_revision)
                    && batch["workspaceGeneration"].as_u64() == Some(source.generation)
                    && batch["locations"].is_array()
                    && source.epoch == self.analysis_epoch.load(Ordering::SeqCst)
                    && source.generation == self.generation.load(Ordering::SeqCst)
                {
                    batch["documentRevision"] = json!(source.revision);
                    return Ok(batch);
                }
            }
        }
        Ok(Value::Null)
    }
    pub(crate) fn workspace_status(&self) -> Result<Value, String> {
        let workspace = self.current()?;
        let workers = self
            .packages
            .lock()
            .map_err(|e| e.to_string())?
            .running_workers();
        let replies = std::thread::scope(|scope| {
            let handles: Vec<_> = workers
                .iter()
                .map(|worker| {
                    scope.spawn(|| {
                        worker.probe(
                            "workspace.status",
                            json!({}),
                            std::time::Duration::from_secs(2),
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok().and_then(Result::ok))
                .collect::<Vec<_>>()
        });
        let mut contexts = Vec::new();
        for reply in replies {
            if reply["generation"].as_u64() != Some(workspace.generation) {
                continue;
            }
            if let Some(states) = reply["contexts"].as_array() {
                for context in states {
                    if workspace
                        .contexts
                        .iter()
                        .any(|known| context["id"].as_str() == Some(&known.id))
                    {
                        contexts.push(context.clone());
                    }
                }
            }
        }
        for context in &workspace.contexts {
            if !contexts.iter().any(|item| item["id"] == context.id) {
                let mut unavailable = serde_json::to_value(context).map_err(|e| e.to_string())?;
                unavailable["state"] = json!("unavailable");
                unavailable["reason"] = json!("Provider has not started, stopped, or is still responding. Activate its tools or check Packages.");
                contexts.push(unavailable);
            }
        }
        Ok(json!({"generation":workspace.generation,"contexts":contexts}))
    }
    fn worker_is_current(&self, worker: &Arc<worker::Worker>) -> bool {
        self.packages.lock().is_ok_and(|host| {
            host.running_workers()
                .iter()
                .any(|active| Arc::ptr_eq(active, worker))
        })
    }
    pub(crate) fn workspace_symbols(&self, query: &Value) -> Result<Value, String> {
        let workspace = self.current()?;
        let epoch = self.analysis_epoch.load(Ordering::SeqCst);
        let id = string(query, "id")?;
        string(query, "query")?;
        if query["workspaceGeneration"].as_u64() != Some(workspace.generation) {
            return Err("Workspace changed; search symbols again".into());
        }
        let lease = QueryLease::new(self, id)?;
        let languages: BTreeSet<_> = workspace
            .contexts
            .iter()
            .map(|c| c.language.as_str())
            .collect();
        let mut batch = json!({"id":id,"documentRevision":0,"workspaceGeneration":workspace.generation,"state":"complete","locations":[],"searchedContexts":0,"totalContexts":0,"reasons":[]});
        if lease.canceled.load(Ordering::Acquire) {
            batch["state"] = json!("canceled");
            batch["reasons"] = json!(["Query canceled"]);
            return Ok(batch);
        }
        if languages.is_empty() {
            batch["state"] = json!("unsupported");
            batch["reasons"] = json!(["No language project contexts were discovered"]);
            return Ok(batch);
        }
        let replies = std::thread::scope(|scope| {
            let handles: Vec<_> = languages
                .iter()
                .map(|language| {
                    scope.spawn(|| {
                        let result =
                            self.language_worker(language, &workspace)
                                .and_then(|worker| {
                                    self.synchronize_overlays(&worker)?;
                                    if lease.canceled.load(Ordering::Acquire) {
                                        return Err("Query canceled".into());
                                    }
                                    let result = worker.request_cancelable(
                                        "workspace.symbols",
                                        query.clone(),
                                        lease.canceled.clone(),
                                    );
                                    if !self.worker_is_current(&worker) {
                                        return Err("Package changed while searching".into());
                                    }
                                    result
                                });
                        (*language, result)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().map_err(|_| "Symbol worker failed".to_owned()))
                .collect::<Result<Vec<_>, _>>()
        })?;
        for (language, reply) in replies {
            let context_count = workspace
                .contexts
                .iter()
                .filter(|c| c.language == language)
                .count();
            match reply {
                Ok(value)
                    if value["id"] == query["id"]
                        && value["documentRevision"] == 0
                        && value["workspaceGeneration"] == query["workspaceGeneration"] =>
                {
                    if value["state"] != "complete" {
                        batch["state"] = json!("partial");
                    }
                    let searched = batch["searchedContexts"].as_u64().unwrap_or(0)
                        + value["searchedContexts"].as_u64().unwrap_or(0);
                    let total = batch["totalContexts"].as_u64().unwrap_or(0)
                        + value["totalContexts"]
                            .as_u64()
                            .unwrap_or(context_count as u64);
                    batch["searchedContexts"] = json!(searched);
                    batch["totalContexts"] = json!(total);
                    if let Some(locations) = value["locations"].as_array() {
                        batch["locations"]
                            .as_array_mut()
                            .unwrap()
                            .extend(locations.iter().cloned());
                    }
                    if let Some(reasons) = value["reasons"].as_array() {
                        batch["reasons"]
                            .as_array_mut()
                            .unwrap()
                            .extend(reasons.iter().cloned());
                    }
                }
                reply => {
                    batch["state"] = json!("partial");
                    batch["totalContexts"] =
                        json!(batch["totalContexts"].as_u64().unwrap_or(0) + context_count as u64);
                    let reason = reply
                        .err()
                        .unwrap_or_else(|| "Provider returned a mismatched symbol query".into());
                    batch["reasons"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(format!("{language}: {reason}")));
                }
            }
        }
        if lease.canceled.load(Ordering::Acquire)
            || self.analysis_epoch.load(Ordering::SeqCst) != epoch
            || self.generation.load(Ordering::SeqCst) != workspace.generation
        {
            batch["state"] = json!("canceled");
            batch["locations"] = json!([]);
            batch["reasons"] = json!(["Search canceled or workspace changed while searching"]);
        }
        Ok(batch)
    }

    pub(crate) fn synchronize_overlays(&self, worker: &Arc<worker::Worker>) -> Result<(), String> {
        // Take the provider fence before reading mirrors. Close removes the mirror
        // first, then takes this same fence: no old overlay can follow its close.
        // Other providers continue independently if this one is slow.
        let mut revisions = worker.revisions.lock().map_err(|e| e.to_string())?;
        let workspace = self.current()?;
        let overlays = self
            .documents
            .lock()
            .map_err(|e| e.to_string())?
            .open
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for document in overlays {
            if !PathBuf::from(&document.path).starts_with(&workspace.root)
                || !worker.accepts_document(&document.path)
            {
                continue;
            }
            if !document.dirty
                && std::fs::read(&document.path)
                    .map(|bytes| documents::hash(&bytes) != document.disk_hash)
                    .unwrap_or(true)
            {
                return Err("External file changes await editor synchronization".into());
            }
            if revisions.get(&document.path) == Some(&document.revision) {
                continue;
            }
            worker.request_with_timeout("document.update",json!({"path":document.path,"content":document.content,"revision":document.revision,"dirty":document.dirty}),std::time::Duration::from_secs(15))?;
            revisions.insert(document.path, document.revision);
        }
        Ok(())
    }
    pub(crate) fn semantic(&self, method: &str, query: &Value) -> Result<Value, String> {
        let workspace = self.current()?;
        let epoch = self.analysis_epoch.load(Ordering::SeqCst);
        let id = string(query, "id")?;
        let path = workspace::canonical_file(string(query, "path")?)?
            .to_string_lossy()
            .into_owned();
        let revision = query["documentRevision"]
            .as_u64()
            .ok_or("Missing document revision")?;
        if query["workspaceGeneration"].as_u64() != Some(workspace.generation) {
            return Err("Workspace changed; run navigation again".into());
        }
        let extension = PathBuf::from(&path)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        let rules = self.discovery_rules()?;
        let language = rules
            .iter()
            .find(|rule| rule.document_extensions.contains(&extension))
            .map(|rule| rule.language.as_str())
            .unwrap_or("unknown");
        let total = workspace
            .contexts
            .iter()
            .filter(|context| context.language == language)
            .count();
        let failure = |state: &str, reason: String| json!({"id":id,"documentRevision":revision,"workspaceGeneration":workspace.generation,"state":state,"locations":[],"searchedContexts":0,"totalContexts":total,"reasons":[reason]});
        let external = !PathBuf::from(&path).starts_with(&workspace.root);
        let source_hash = {
            let docs = self.documents.lock().map_err(|e| e.to_string())?;
            let source = docs
                .open
                .get(&path)
                .ok_or("Open the source document before querying")?;
            if source.revision != revision {
                return Err("Document changed; run navigation again".into());
            }
            source.disk_hash.clone()
        };
        let mut provider_query = query.clone();
        provider_query["path"] = json!(path);
        provider_query["reportProgress"] = json!(method == "navigation.query");
        let lease = QueryLease::new(self, id)?;
        if lease.canceled.load(Ordering::Acquire) {
            return Ok(failure("canceled", "Query canceled".into()));
        }
        {
            let mut active = self.active_queries.lock().map_err(|e| e.to_string())?;
            if active.contains_key(id) {
                return Err("Query ID is already active".into());
            }
            active.insert(
                id.to_owned(),
                ProgressSource {
                    epoch,
                    generation: workspace.generation,
                    revision,
                    path: path.clone(),
                    external,
                    disk_hash: source_hash.clone(),
                    canceled: lease.canceled.clone(),
                },
            );
        }
        if external {
            if method == "editor.request"
                && matches!(
                    query["operation"].as_str(),
                    Some("rename" | "format" | "codeActions")
                )
            {
                return Ok(failure(
                    "unsupported",
                    "Dependency source is read-only".into(),
                ));
            }
            if std::fs::read(&path)
                .map(|bytes| documents::hash(&bytes) != source_hash)
                .unwrap_or(true)
            {
                return Ok(failure(
                    "partial",
                    "Dependency source changed on disk; reopen it before navigating".into(),
                ));
            }
            // Dependencies use provider disk snapshots rather than mutable overlays.
            provider_query["documentRevision"] = json!(0);
        }
        let worker = match self.language_worker(language, &workspace) {
            Ok(worker) => worker,
            Err(error) => return Ok(failure("unsupported", error)),
        };
        if let Err(error) = self.synchronize_overlays(&worker) {
            return Ok(failure("partial", error));
        }
        if lease.canceled.load(Ordering::Acquire) {
            return Ok(failure("canceled", "Query canceled".into()));
        }
        let result =
            worker.request_cancelable(method, provider_query.clone(), lease.canceled.clone());
        if lease.canceled.load(Ordering::Acquire) {
            return Ok(failure("canceled", "Query canceled".into()));
        }
        if self.analysis_epoch.load(Ordering::SeqCst) != epoch
            || !self.worker_is_current(&worker)
            || (external
                && std::fs::read(&path)
                    .map(|bytes| documents::hash(&bytes) != source_hash)
                    .unwrap_or(true))
            || self.generation.load(Ordering::SeqCst) != workspace.generation
            || self
                .documents
                .lock()
                .map_err(|e| e.to_string())?
                .open
                .get(&path)
                .is_none_or(|doc| doc.revision != revision)
        {
            return Ok(failure(
                "canceled",
                "Source, consumer, or workspace changed while searching".into(),
            ));
        }
        match result {
            Ok(mut value) => {
                if value["id"] != query["id"]
                    || value["documentRevision"] != provider_query["documentRevision"]
                    || value["workspaceGeneration"] != query["workspaceGeneration"]
                {
                    return Ok(failure(
                        "failed",
                        "Provider returned a mismatched query revision".into(),
                    ));
                }
                value["documentRevision"] = query["documentRevision"].clone();
                Ok(value)
            }
            Err(error) => Ok(failure("failed", error)),
        }
    }
}
