use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRule {
    pub language: String,
    pub document_extensions: Vec<String>,
    pub config_globs: Vec<String>,
    #[serde(default)]
    pub configuration_globs: Vec<String>,
}
pub fn default_rules() -> Result<Vec<DiscoveryRule>, String> {
    serde_json::from_str(include_str!("../../../packages/capabilities.json"))
        .map_err(|e| e.to_string())
}
fn matches_globs(name: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| {
        globset::Glob::new(pattern).is_ok_and(|glob| glob.compile_matcher().is_match(name))
    })
}
pub fn is_configuration(path: &str, rules: &[DiscoveryRule]) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name == "HEAD"
                || name == ".zwip.json"
                || rules
                    .iter()
                    .any(|rule| matches_globs(name, &rule.configuration_globs))
        })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub relative_path: String,
    pub size: u64,
}
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildContext {
    pub id: String,
    pub root: String,
    pub language: String,
    pub config_path: String,
    pub state: String,
    #[serde(default)]
    pub document_extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceConfiguration {
    version: u32,
    #[serde(default)]
    build_profiles: Vec<BuildProfile>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BuildProfile {
    id: String,
    language: String,
    config_paths: Vec<String>,
    settings: serde_json::Map<String, serde_json::Value>,
}

/// The foundation expands contexts without interpreting provider-specific build settings.
fn add_profiles(root: &Path, contexts: &mut Vec<BuildContext>) -> Result<(), String> {
    let path = root.join(".zwip.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!(".zwip.json: {error}")),
    };
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err(".zwip.json must be a regular file no larger than 1 MiB".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err(".zwip.json exceeds 1 MiB".into());
    }
    let config: WorkspaceConfiguration =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid .zwip.json: {e}"))?;
    if config.version != 1 || config.build_profiles.len() > 64 {
        return Err(".zwip.json requires version 1 and at most 64 build profiles".into());
    }
    let mut profile_ids = HashSet::new();
    let mut context_ids: HashSet<_> = contexts.iter().map(|context| context.id.clone()).collect();
    let mut derived = Vec::new();
    for profile in config.build_profiles {
        if profile.id.is_empty()
            || profile.id.len() > 64
            || !profile.id.as_bytes()[0].is_ascii_alphanumeric()
            || !profile
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || !profile_ids.insert(profile.id.clone())
        {
            return Err("Build profile IDs must be unique, 1–64 characters, start with a letter or digit, and contain only letters, digits, '.', '_' or '-'".into());
        }
        if profile.config_paths.is_empty() {
            return Err(format!(
                "Build profile '{}' requires configPaths",
                profile.id
            ));
        }
        for config_path in profile.config_paths {
            let base = contexts.iter().find(|context| {
                context.id == config_path && context.language == profile.language
            }).ok_or_else(|| format!("Build profile '{}' refers to an undiscovered {} configuration: {config_path}", profile.id, profile.language))?;
            let id = format!("{}#{}", base.id, profile.id);
            if !context_ids.insert(id.clone()) {
                return Err(format!("Duplicate build context: {id}"));
            }
            let mut context = base.clone();
            context.id = id;
            context.profile_id = Some(profile.id.clone());
            context.settings = Some(profile.settings.clone());
            derived.push(context);
            if derived.len() > 256 {
                return Err(".zwip.json exceeds 256 additional build contexts".into());
            }
        }
    }
    contexts.extend(derived);
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: String,
    pub name: String,
    pub generation: u64,
    pub files: Vec<FileEntry>,
    #[serde(default)]
    pub directories: Vec<String>,
    pub contexts: Vec<BuildContext>,
    pub excluded: Vec<String>,
    #[serde(default)]
    pub excluded_directories: Vec<ExcludedDirectory>,
}
/// A directory left out of the file index, with the reason it was skipped.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedDirectory {
    pub path: String,
    pub reason: String,
}
const MAX_LISTED_EXCLUSIONS: usize = 1000;

/// `exclusions` are workspace-relative directory paths the user chose to skip.
/// `scanned` counts indexed files as the walk proceeds so callers can report progress.
pub fn scan(
    root: &Path,
    generation: u64,
    rules: &[DiscoveryRule],
    exclusions: &[String],
    scanned: &AtomicU64,
) -> Result<Workspace, String> {
    scanned.store(0, Ordering::Relaxed);
    let discovery = rules
        .iter()
        .map(|rule| {
            let mut patterns = globset::GlobSetBuilder::new();
            for pattern in &rule.config_globs {
                patterns.add(globset::Glob::new(pattern).map_err(|e| e.to_string())?);
            }
            Ok((rule, patterns.build().map_err(|e| e.to_string())?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Workspace must be a directory".into());
    }
    let root_filter = root.clone();
    let skipped = std::sync::Arc::new(std::sync::Mutex::new(Vec::<ExcludedDirectory>::new()));
    let skipped_filter = skipped.clone();
    let user_excluded: HashSet<String> = exclusions.iter().cloned().collect();
    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                let reason = if matches!(
                    name.as_ref(),
                    ".git" | "node_modules" | "target" | "dist" | ".next" | ".cache" | "coverage"
                ) {
                    Some("Dependency or build directory")
                } else if path.components().any(|c| c.as_os_str() == ".claude")
                    && name == "worktrees"
                {
                    Some("Agent worktrees")
                } else if path != root_filter && path.join(".git").is_file() {
                    // Linked worktrees have a .git file; nested standalone repositories remain valid roots.
                    Some("Linked worktree")
                } else if path.strip_prefix(&root_filter).is_ok_and(|relative| {
                    user_excluded.contains(relative.to_string_lossy().as_ref())
                }) {
                    Some("Excluded by you")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    if let (Ok(mut skipped), Ok(relative)) =
                        (skipped_filter.lock(), path.strip_prefix(&root_filter))
                    {
                        if skipped.len() < MAX_LISTED_EXCLUSIONS {
                            skipped.push(ExcludedDirectory {
                                path: relative.to_string_lossy().into_owned(),
                                reason: reason.to_owned(),
                            });
                        }
                    }
                    return false;
                }
            }
            true
        });
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut contexts = Vec::new();
    let mut excluded =
        vec!["Dependency/build directories and duplicate nested worktrees".to_owned()];
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                excluded.push(error.to_string());
                continue;
            }
        };
        if entry.depth() > 0 && entry.file_type().is_some_and(|kind| kind.is_dir()) {
            directories.push(entry.path().to_string_lossy().into_owned());
        }
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        scanned.fetch_add(1, Ordering::Relaxed);
        let path = entry.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let name = entry.file_name().to_string_lossy();
        let language = discovery
            .iter()
            .find(|(_, patterns)| patterns.is_match(name.as_ref()))
            .map(|(rule, _)| *rule);
        if let Some(rule) = language {
            contexts.push(BuildContext {
                id: relative.clone(),
                root: path.parent().unwrap_or(&root).to_string_lossy().into(),
                language: rule.language.clone(),
                config_path: path.to_string_lossy().into(),
                state: "loading".into(),
                document_extensions: rule.document_extensions.clone(),
                profile_id: None,
                settings: None,
            });
        }
        files.push(FileEntry {
            path: path.to_string_lossy().into(),
            relative_path: relative,
            size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        });
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    directories.sort();
    add_profiles(&root, &mut contexts)?;
    contexts.sort_by(|a, b| a.id.cmp(&b.id));
    let mut excluded_directories = skipped.lock().map_err(|e| e.to_string())?.clone();
    excluded_directories.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Workspace {
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        root: root.to_string_lossy().into(),
        generation,
        files,
        directories,
        contexts,
        excluded,
        excluded_directories,
    })
}

pub fn canonical_file(value: &str) -> Result<PathBuf, String> {
    Path::new(value)
        .canonicalize()
        .map_err(|e| format!("{value}: {e}"))
}
