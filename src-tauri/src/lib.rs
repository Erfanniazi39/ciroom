//! CiRoom desktop shell.
//!
//! Installed app (release build): starts CiRoom's server (server/index.js on the bundled Node, shipped next to
//! this program) and opens the window on it. The server is stopped when CiRoom closes.
//! Test version / `npm run desktop` (debug build): the Vite dev server already runs CiRoom's server; the
//! window just opens the dev URL.
//!
//! Also: one CiRoom at a time (a second launch focuses the open window), in-app updates (Settings → Updates),
//! and an app-menu entry for the AppImage.

use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewWindowBuilder};

/// The server process, stopped on exit.
struct Server(Mutex<Option<std::process::Child>>);

#[cfg(not(debug_assertions))]
mod installed {
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    pub const PORT: u16 = 1420;

    /// The system proxy (what browsers use, e.g. a VPN app's local proxy): (proxy URL, addresses that skip it).
    /// Opened from the app menu, CiRoom doesn't get the terminal's proxy variables, so it reads the setting itself.
    fn system_proxy() -> Option<(String, String)> {
        #[cfg(target_os = "linux")]
        {
            let get = |key: &str, name: &str| -> Option<String> {
                // The AppImage points GSettings/GIO at its own bundled copies, which don't know the system proxy:
                // ask the system's own settings instead.
                let out = Command::new("gsettings").args(["get", key, name])
                    .env_remove("GSETTINGS_SCHEMA_DIR").env_remove("GIO_MODULE_DIR").env_remove("LD_LIBRARY_PATH")
                    .output().ok()?;
                let v = String::from_utf8_lossy(&out.stdout).trim().trim_matches('\'').to_string();
                (out.status.success() && !v.is_empty()).then_some(v)
            };
            if get("org.gnome.system.proxy", "mode")? != "manual" {
                return None;
            }
            let (host, port) = ["https", "http"].iter().find_map(|kind| {
                let key = format!("org.gnome.system.proxy.{kind}");
                let host = get(&key, "host")?;
                let port = get(&key, "port")?;
                (!host.is_empty() && port != "0").then_some((host, port))
            })?;
            let skip = get("org.gnome.system.proxy", "ignore-hosts").unwrap_or_default();
            let skip: Vec<String> = skip.trim_matches(['[', ']']).split(',').map(|h| h.trim().trim_matches('\'').to_string()).filter(|h| !h.is_empty()).collect();
            return Some((format!("http://{host}:{port}"), skip.join(",")));
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
            let query = |name: &str| -> Option<String> {
                let out = Command::new("reg").args(["query", key, "/v", name]).creation_flags(0x0800_0000).output().ok()?;
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                let line = text.lines().find(|l| l.trim_start().starts_with(name))?.to_string();
                line.split_whitespace().nth(2).map(|v| v.to_string())
            };
            if query("ProxyEnable")? != "0x1" {
                return None;
            }
            let server = query("ProxyServer")?; // "host:port" or "http=h:p;https=h:p"
            let pick = server.split(';').find(|p| p.starts_with("https=")).or_else(|| server.split(';').find(|p| p.starts_with("http=")))
                .map(|p| p.split_once('=').map(|x| x.1).unwrap_or(p).to_string()).unwrap_or(server.clone());
            let skip = query("ProxyOverride").unwrap_or_default().replace("<local>", "localhost,127.0.0.1").replace(';', ",");
            return Some((format!("http://{pick}"), skip));
        }
        #[allow(unreachable_code)]
        None
    }

    fn port_open() -> bool {
        TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(150)).is_ok()
    }

    /// Starts server/index.js on the bundled Node and waits until it answers (max 20 s).
    /// Returns None when something already serves CiRoom's port (e.g. the server from an earlier run).
    pub fn start_server(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
        // Right after an update the previous version's server may still be shutting down: give it a moment.
        let wait = Instant::now();
        while port_open() && wait.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(200));
        }
        if port_open() {
            return Ok(None); // something else serves CiRoom here (e.g. `npm run desktop`): use it
        }
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let node = exe.parent().ok_or("no program folder")?.join(if cfg!(windows) { "node.exe" } else { "node" });
        // Windows paths can come as \\?\C:\…; plain C:\… is safer for Node and for PATH.
        let res = PathBuf::from(app.path().resource_dir().map_err(|e| e.to_string())?.to_string_lossy().trim_start_matches(r"\\?\").to_string());
        let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(log_dir.join("server.log")).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&node);
        cmd.arg(res.join("server").join("index.js"))
            .env("CIROOM_PORT", PORT.to_string())
            .env("CIROOM_DIST", res.join("dist"))
            .env("NODE_USE_ENV_PROXY", "1")
            .env("NODE_NO_WARNINGS", "1")
            .env("CIROOM_SHARE_DATA", "1") // Linux: move the data next to the library once, for the Windows app
            // The server quits when this pipe closes, i.e. whenever CiRoom ends (even if it is killed or crashes).
            .env("CIROOM_EXIT_WITH_STDIN", "1")
            .stdin(Stdio::piped())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        #[cfg(windows)]
        {
            // mpv, ffmpeg and ffprobe ship with CiRoom on Windows (resources/bin): the server finds them on PATH.
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut dirs = vec![res.join("bin")];
            dirs.extend(std::env::split_paths(&path));
            if let Ok(joined) = std::env::join_paths(dirs) {
                cmd.env("PATH", joined);
            }
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window
        }
        let has_proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].iter().any(|k| std::env::var_os(k).is_some());
        if !has_proxy {
            if let Some((proxy, skip)) = system_proxy() {
                let skip = if skip.is_empty() { "localhost,127.0.0.1,::1".to_string() } else { format!("{skip},localhost,127.0.0.1,::1") };
                for k in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
                    cmd.env(k, &proxy);
                }
                cmd.env("NO_PROXY", &skip).env("no_proxy", &skip);
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start {}: {e}", node.display()))?;
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(20) {
            if port_open() {
                return Ok(Some(child));
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("CiRoom's server stopped ({status}); see {}", log_dir.join("server.log").display()));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(Some(child))
    }

    /// AppImage: add CiRoom to the app menu (and keep the entry pointing at the current file).
    pub fn menu_entry() {
        let (Ok(appimage), Some(home)) = (std::env::var("APPIMAGE"), std::env::var_os("HOME")) else { return };
        let home = PathBuf::from(home);
        let icon_dir = home.join(".local/share/icons/hicolor/256x256/apps");
        let apps_dir = home.join(".local/share/applications");
        let _ = std::fs::create_dir_all(&icon_dir);
        let _ = std::fs::create_dir_all(&apps_dir);
        let icon = icon_dir.join("ciroom.png");
        if !icon.exists() {
            let _ = std::fs::write(&icon, include_bytes!("../icons/128x128@2x.png"));
        }
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=CiRoom\nComment=Your movies and series\nExec=\"{appimage}\"\nIcon=ciroom\nTerminal=false\nCategories=AudioVideo;Video;Player;\nStartupWMClass=ciroom\n"
        );
        let file = apps_dir.join("ciroom.desktop");
        if std::fs::read_to_string(&file).ok().as_deref() != Some(entry.as_str()) {
            let _ = std::fs::write(&file, entry);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }
    let app = builder
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            #[allow(unused_mut)]
            let mut cfg = app.config().app.windows.first().cloned().ok_or("no window in tauri.conf.json")?;
            #[cfg(not(debug_assertions))]
            {
                installed::menu_entry();
                match installed::start_server(app.handle()) {
                    Ok(child) => *app.state::<Server>().0.lock().unwrap() = child,
                    Err(e) => eprintln!("[ciroom] {e}"),
                }
                let url = format!("http://127.0.0.1:{}/", installed::PORT).parse().expect("valid url");
                cfg.url = tauri::WebviewUrl::External(url);
            }
            WebviewWindowBuilder::from_config(app.handle(), &cfg)?.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting CiRoom");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
