#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// SPDX-License-Identifier: GPL-3.0-or-later
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Serialize)]
struct Connection {
    port: u16,
    token: String,
}
struct Backend {
    child: Mutex<Child>,
    connection: Connection,
}
impl Backend {
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn start_backend(app: &tauri::App) -> Result<Backend, Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?.join("runtime");
    let portable = std::env::current_exe()?
        .parent()
        .ok_or("Missing executable folder")?
        .join("runtime");
    let root = std::env::var_os("PHOTOALL_PRODUCT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if resources.join("service.py").is_file() {
                resources
            } else {
                portable
            }
        });
    #[cfg(debug_assertions)]
    let root = if !root.join("service.py").is_file() {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned()
    } else {
        root
    };
    let python = root.join("python/python.exe");
    #[cfg(debug_assertions)]
    let python = if !python.is_file() {
        std::env::var_os("PHOTOALL_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(
                    ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
                )
            })
    } else {
        python
    };
    if !python.is_file() || !root.join("service.py").is_file() {
        return Err("运行文件不完整。请完整解压便携包，或重新运行安装程序。".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let data = std::env::var_os("PHOTOALL_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_local_data_dir()?);
    fs::create_dir_all(&data)?;
    let log_path = data.join("backend.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut command = Command::new(&python);
    command
        .arg("-u")
        .arg(root.join("service.py"))
        .arg("--data-dir")
        .arg(&data)
        .current_dir(&root)
        .env("PHOTOALL_SESSION_TOKEN", &token)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(Stdio::piped())
        .env("PHOTOALL_PYTHON", &python)
        .env("PHOTOALL_DATA_DIR", &data)
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or("No backend stdout")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut handshake = String::new();
        let result = reader
            .read_line(&mut handshake)
            .map(|_| handshake)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
        // Keep the pipe open for the lifetime of the backend.
        for line in reader.lines() {
            if line.is_err() {
                break;
            }
        }
    });
    let parsed = receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|error| error.to_string())
        .and_then(|value| value)
        .and_then(|handshake| {
            let value: serde_json::Value =
                serde_json::from_str(&handshake).map_err(|e| e.to_string())?;
            let port = value["port"]
                .as_u64()
                .ok_or("Backend did not return a port")?;
            if port == 0 || port > 65535 {
                return Err("Backend port is invalid".into());
            }
            Ok(Connection {
                port: port as u16,
                token,
            })
        });
    match parsed {
        Ok(connection) => Ok(Backend {
            child: Mutex::new(child),
            connection,
        }),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "本地处理服务无法启动：{error}\n诊断日志：{}",
                log_path.display()
            )
            .into())
        }
    }
}

#[tauri::command]
fn connection(state: tauri::State<'_, Backend>) -> Connection {
    state.connection.clone()
}

#[tauri::command]
async fn pick_photos() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("导入照片")
            .add_filter(
                "照片与 RAW",
                &[
                    "jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "heic", "heif", "dng",
                    "nef", "arw", "cr2", "cr3", "raf", "rw2", "orf", "pef",
                ],
            )
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择文件夹")
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn finish_close(window: tauri::Window) -> Result<(), String> {
    window.destroy().map_err(|error| error.to_string())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle, backend: tauri::State<'_, Backend>) {
    // Called only after the frontend has flushed edits. AppHandle::exit also
    // falls back to process exit when the runtime event channel is already dead.
    // Stop explicitly: that fallback does not deliver RunEvent::Exit.
    backend.stop();
    app.exit(0);
}

#[tauri::command]
fn viewer_fullscreen(window: tauri::Window, enabled: Option<bool>) -> Result<bool, String> {
    if let Some(value) = enabled {
        window
            .set_fullscreen(value)
            .map_err(|error| error.to_string())?;
    }
    window.is_fullscreen().map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(start_backend(app)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connection,
            pick_photos,
            pick_folder,
            finish_close,
            exit_app,
            viewer_fullscreen
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            rfd::MessageDialog::new()
                .set_title("Photo All Studio 启动失败")
                .set_description(format!("{error}"))
                .set_level(rfd::MessageLevel::Error)
                .show();
            std::process::exit(1);
        })
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(backend) = app.try_state::<Backend>() {
                    backend.stop();
                }
            }
        });
}
