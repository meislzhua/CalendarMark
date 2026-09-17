#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

mod notion;
// 七牛适配器暂时下线：实现保留在测试编译单元中，运行时不再暴露 IPC 命令。
#[cfg(test)]
#[allow(dead_code)]
mod qiniu;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowWorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
fn get_window_work_area(
    window: tauri::WebviewWindow,
) -> Result<WindowWorkArea, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("无法读取当前显示器：{error}"))?
        .ok_or_else(|| "没有检测到当前显示器。".to_string())?;
    let area = monitor.work_area();
    Ok(WindowWorkArea {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    })
}

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            notion::notion_discover_datasets,
            notion::notion_check_connection,
            notion::notion_pull_entries,
            notion::notion_push_entries,
            notion::notion_archive_page,
            notion::notion_search_pages,
            notion::notion_create_database,
            get_window_work_area
        ])
        .setup(|_app| {
            #[cfg(desktop)]
            {
                _app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

                _app.handle()
                    .plugin(tauri_plugin_autostart::Builder::new().build())?;

                let show_item =
                    MenuItem::with_id(_app, "show", "打开 CalendarMark", true, None::<&str>)?;
                let settings_item =
                    MenuItem::with_id(_app, "settings", "打开设置", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(_app, "quit", "退出", true, None::<&str>)?;
                let menu = MenuBuilder::new(_app)
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

                if let Some(icon) = _app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
                tray_builder.build(_app)?;
            }

            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running CalendarMark");
}


