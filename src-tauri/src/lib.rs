use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn ide_request(
    core: tauri::State<'_, Arc<ide_core::Core>>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.request(&method, params))
        .await
        .map_err(|error| error.to_string())?
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
            let core = Arc::new(ide_core::Core::new(data)?);
            app.manage(core);
            // The standard macOS menu, plus Settings… in the application menu after About.
            let menu = Menu::default(app.handle())?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            if let Some(MenuItemKind::Submenu(application)) = menu.items()?.into_iter().next() {
                application.insert_items(&[&settings, &PredefinedMenuItem::separator(app)?], 2)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "settings" {
                    let _ = app.emit("zwip://open-settings", ());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ide_request])
        .build(tauri::generate_context!())
        .expect("failed to start Zwip")
        .run(|app, event| {
            // App::run exits the process directly; destructors alone cannot
            // guarantee that language workers and their subprocesses finish.
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Arc<ide_core::Core>>().shutdown();
            }
        });
}
