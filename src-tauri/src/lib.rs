use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// One IDE core per window, so each window holds its own workspace, workers and tasks.
struct Cores {
    data: PathBuf,
    windows: Mutex<HashMap<String, Window>>,
    sequence: AtomicU64,
}
#[derive(Default)]
struct Window {
    core: Option<Arc<ide_core::Core>>,
    /// Canonical workspace root; a project opens in at most one window.
    root: Option<String>,
}
impl Cores {
    fn core(&self, label: &str) -> Result<Arc<ide_core::Core>, String> {
        let mut windows = self.windows.lock().map_err(|e| e.to_string())?;
        let window = windows.entry(label.to_owned()).or_default();
        if let Some(core) = &window.core {
            return Ok(core.clone());
        }
        let core = Arc::new(ide_core::Core::new(self.data.clone()).map_err(|e| e.to_string())?);
        window.core = Some(core.clone());
        Ok(core)
    }
    /// The other window that already has `root` open.
    fn window_with(&self, root: &str, except: &str) -> Option<String> {
        let windows = self.windows.lock().ok()?;
        windows
            .iter()
            .find(|(label, window)| *label != except && window.root.as_deref() == Some(root))
            .map(|(label, _)| label.clone())
    }
    fn set_root(&self, label: &str, root: Option<String>) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.entry(label.to_owned()).or_default().root = root;
        }
    }
    fn close(&self, label: &str) {
        let window = self
            .windows
            .lock()
            .ok()
            .and_then(|mut windows| windows.remove(label));
        if let Some(core) = window.and_then(|window| window.core) {
            core.shutdown();
        }
    }
    fn shutdown(&self) {
        let windows = self
            .windows
            .lock()
            .map(|mut windows| std::mem::take(&mut *windows));
        for core in windows
            .into_iter()
            .flatten()
            .filter_map(|(_, window)| window.core)
        {
            core.shutdown();
        }
    }
}

#[tauri::command]
async fn ide_request(
    window: tauri::WebviewWindow,
    cores: tauri::State<'_, Arc<Cores>>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let label = window.label().to_owned();
    if method == "workspace.open" {
        let root = params["root"].as_str().map(PathBuf::from);
        let canonical = root.and_then(|root| root.canonicalize().ok());
        if let Some(root) = canonical.as_ref().and_then(|root| root.to_str()) {
            if let Some(other) = cores.window_with(root, &label) {
                if let Some(existing) = window.app_handle().get_webview_window(&other) {
                    let _ = existing.set_focus();
                }
                return Err(format!("{root} is already open in another window"));
            }
        }
    }
    let core = cores.core(&label)?;
    let cores = cores.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = core.request(&method, params);
        if method == "workspace.open" {
            if let Ok(workspace) = &result {
                cores.set_root(&label, workspace["root"].as_str().map(str::to_owned));
            }
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens another IDE window, optionally opening `root` in it.
#[tauri::command]
fn new_window(app: tauri::AppHandle, root: Option<String>) -> Result<(), String> {
    open_window(&app, root).map_err(|error| error.to_string())
}

fn open_window(app: &tauri::AppHandle, root: Option<String>) -> tauri::Result<()> {
    let cores = app.state::<Arc<Cores>>();
    let label = format!("window-{}", cores.sequence.fetch_add(1, Ordering::Relaxed));
    let url = match root {
        Some(root) => format!("index.html?root={}", urlencoding(&root)),
        None => "index.html".to_owned(),
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Zwip")
        .inner_size(1440.0, 940.0)
        .min_inner_size(900.0, 600.0)
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(feature = "e2e")]
            app.add_capability(r#"{"identifier":"e2e","windows":["main"],"permissions":["wdio:default","wdio-webdriver:default"]}"#)?;
            let data = std::env::var_os("ZWIP_DATA").map(std::path::PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            app.manage(Arc::new(Cores {
                data,
                windows: Mutex::new(HashMap::new()),
                sequence: AtomicU64::new(1),
            }));
            // The standard macOS menu, plus Settings… after About and New Window in the File menu.
            let menu = Menu::default(app.handle())?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let new_window = MenuItem::with_id(app, "new-window", "New Window", true, Some("CmdOrCtrl+Shift+N"))?;
            let mut submenus = menu.items()?.into_iter().filter_map(|item| match item {
                MenuItemKind::Submenu(submenu) => Some(submenu),
                _ => None,
            });
            if let Some(application) = submenus.next() {
                application.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
            }
            if let Some(file) = submenus.next() {
                file.insert(&new_window, 0)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    // Settings opens in the window the user is working in.
                    let focused = app.webview_windows().into_values().find(|window| window.is_focused().unwrap_or(false));
                    let _ = match focused {
                        Some(window) => window.emit("zwip://open-settings", ()),
                        None => app.emit("zwip://open-settings", ()),
                    };
                } else if event.id() == "new-window" {
                    let _ = open_window(app, None);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // A closed window stops its own workers and tasks; other windows keep running.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Arc<Cores>>().close(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![ide_request, new_window])
        .build(tauri::generate_context!())
        .expect("failed to start Zwip")
        .run(|app, event| {
            // App::run exits the process directly; destructors alone cannot
            // guarantee that language workers and their subprocesses finish.
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<Cores>>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_belongs_to_one_window_until_it_switches_or_closes() {
        let cores = Cores {
            data: PathBuf::new(),
            windows: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        };
        cores.set_root("main", Some("/work/api".into()));
        assert_eq!(
            cores.window_with("/work/api", "window-1").as_deref(),
            Some("main")
        );
        assert_eq!(cores.window_with("/work/api", "main"), None);
        cores.set_root("main", Some("/work/web".into()));
        assert_eq!(cores.window_with("/work/api", "window-1"), None);
        cores.close("main");
        assert_eq!(cores.window_with("/work/web", "window-1"), None);
        assert_eq!(urlencoding("/a b/é"), "/a%20b/%C3%A9");
    }
}
