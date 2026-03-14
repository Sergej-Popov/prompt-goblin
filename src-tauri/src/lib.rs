mod audio;
mod keyboard;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            audio::start_recording,
            audio::stop_recording,
            keyboard::type_text,
            keyboard::type_text_incremental,
        ])
        .manage(audio::AudioState::default())
        .setup(|app| {
            // Build tray menu
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            // Build tray icon
            let _tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Prompt Goblin")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Position overlay window at top-center of primary monitor
            if let Some(overlay) = app.get_webview_window("overlay") {
                if let Ok(Some(monitor)) = overlay.primary_monitor() {
                    let screen_width = monitor.size().width as f64 / monitor.scale_factor();
                    let x = (screen_width / 2.0 - 170.0).max(0.0);
                    let _ =
                        overlay.set_position(tauri::PhysicalPosition::new(x as i32, 40));
                }
                // Make overlay ignore mouse events (click-through)
                let _ = overlay.set_ignore_cursor_events(true);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide main window to tray instead of closing
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
