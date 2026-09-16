use tauri::{
    menu::{MenuBuilder, MenuItem},
    Emitter, Manager, WindowEvent,
};

#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

                let show_item =
                    MenuItem::with_id(app, "show", "打开 CalendarMark", true, None::<&str>)?;
                let settings_item =
                    MenuItem::with_id(app, "settings", "打开设置", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = MenuBuilder::new(app)
                    .items(&[&show_item, &settings_item, &quit_item])
                    .build()?;

                let mut tray_builder = TrayIconBuilder::with_id("main")
                    .menu(&menu)
                    .tooltip("CalendarMark")
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => show_main_window(app),
                        "settings" => {
                            show_main_window(app);
                            let _ = app.emit("calendar-mark:open-settings", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    });

                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
                tray_builder.build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CalendarMark");
}
