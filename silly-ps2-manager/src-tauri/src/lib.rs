use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
pub struct Ps2Game {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub path: String,
    pub size_gb: f64,
    pub media_type: String,
    pub has_cover: bool,
}

#[derive(Serialize, Clone)]
pub struct BatchProgressPayload {
    pub current: usize,
    pub total: usize,
    pub game_title: String,
    pub action: String,
}

// Extrae el Game ID (ej. SLES_533.83) de la cabecera de la ISO
fn extract_game_id(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buffer = vec![0u8; 4 * 1024 * 1024];
    let bytes_read = file.read(&mut buffer).ok()?;
    let content = String::from_utf8_lossy(&buffer[..bytes_read]);

    let re = Regex::new(r"(?i)(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_](\d{3})\.?(\d{2})").ok()?;

    if let Some(caps) = re.captures(&content) {
        let prefix = caps[1].to_uppercase();
        let num1 = &caps[2];
        let num2 = &caps[3];
        Some(format!("{}_{}.{}", prefix, num1, num2))
    } else {
        None
    }
}

// Escaneo de juegos en las carpetas DVD y CD
#[tauri::command]
fn scan_opl_folder(opl_path: String) -> Result<Vec<Ps2Game>, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    let mut games = Vec::new();

    let serial_cleanup_re = Regex::new(r"(?i)^(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_.](\d{3})[-_.](\d{2})[._\s-]*").unwrap();

    for subfolder in ["DVD", "CD"] {
        let dir_path = base.join(subfolder);
        if let Ok(entries) = fs::read_dir(dir_path) {
            for entry in entries.flatten() {
                let file_path = entry.path();
                if file_path.is_file() {
                    if let Some(ext) = file_path.extension() {
                        if ext.to_string_lossy().to_lowercase() == "iso" {
                            let file_name = entry.file_name().to_string_lossy().to_string();
                            let metadata = entry.metadata().map_err(|e| e.to_string())?;
                            let size_gb = (metadata.len() as f64) / (1024.0 * 1024.0 * 1024.0);

                            let id = extract_game_id(&file_path).unwrap_or_else(|| "DESCONOCIDO".to_string());
                            
                            let raw_stem = file_path.file_stem().unwrap_or_default().to_string_lossy();
                            let clean_title = serial_cleanup_re.replace(&raw_stem, "").trim().to_string();
                            let title = if clean_title.is_empty() {
                                raw_stem.to_string()
                            } else {
                                clean_title
                            };

                            let has_cover = art_dir.join(format!("{}_COV.jpg", id)).exists()
                                || art_dir.join(format!("{}_COV.png", id)).exists();

                            games.push(Ps2Game {
                                id,
                                title,
                                file_name,
                                path: file_path.to_string_lossy().to_string(),
                                size_gb: (size_gb * 100.0).round() / 100.0,
                                media_type: subfolder.to_string(),
                                has_cover,
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(games)
}

// 1. GESTIÓN DE CARÁTULAS Y ARTE
#[tauri::command]
fn download_art(opl_path: String, game_id: String) -> Result<String, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    if !art_dir.exists() {
        fs::create_dir_all(&art_dir).map_err(|e| e.to_string())?;
    }

    let clean_id = game_id.replace('_', "-").replace('.', "");
    println!("[DEBUG] Buscando carátula para ID limpio: {}", clean_id);

    let client = reqwest::blocking::Client::builder()
        .user_agent("SillyPS2Manager/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let target_file_path = art_dir.join(format!("{}_COV.jpg", game_id));
    let mut downloaded = false;

    let urls = [
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/{}.jpg", clean_id),
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/3d/{}.jpg", clean_id),
    ];

    for url in urls {
        println!("[DEBUG] Probando URL: {}", url);
        if let Ok(res) = client.get(&url).send() {
            println!("[DEBUG] Respuesta status: {}", res.status());
            if res.status().is_success() {
                if let Ok(bytes) = res.bytes() {
                    if let Ok(mut file) = File::create(&target_file_path) {
                        if file.write_all(&bytes).is_ok() {
                            downloaded = true;
                            println!("[DEBUG] ¡Carátula descargada con éxito!");
                            break;
                        }
                    }
                }
            }
        }
    }

    if downloaded {
        Ok(format!("Carátula descargada con éxito en /ART/{}_COV.jpg", game_id))
    } else {
        Err(format!("No se encontró carátula para {}", clean_id))
    }
}

// 2. RENOMBRADO Y ORGANIZACIÓN
#[tauri::command]
fn fix_iso_filename(game_path: String, game_id: String) -> Result<String, String> {
    let current_path = PathBuf::from(&game_path);
    let parent_dir = current_path.parent().ok_or("No se encontró el directorio padre")?;

    let file_stem = current_path
        .file_stem()
        .ok_or("Nombre de archivo inválido")?
        .to_string_lossy();

    let serial_pattern = Regex::new(r"(?i)^(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_.](\d{3})[-_.](\d{2})[._\s-]*").unwrap();

    let raw_title = serial_pattern.replace(&file_stem, "").to_string();
    let clean_title = if raw_title.trim().is_empty() {
        "Juego".to_string()
    } else {
        raw_title.trim().to_string()
    };

    let safe_title: String = clean_title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    let target_file_name = format!("{}.{}.iso", game_id, safe_title.trim());
    let new_path = parent_dir.join(&target_file_name);

    if current_path == new_path {
        return Ok("El archivo ya cumple con el formato estándar de OPL.".to_string());
    }

    println!("[DEBUG] Renombrando de {:?} a {:?}", current_path, new_path);
    fs::rename(&current_path, &new_path).map_err(|e| e.to_string())?;

    Ok(new_path.to_string_lossy().to_string())
}

// 3. ARCHIVOS DE CONFIGURACIÓN (.CFG)
#[tauri::command]
fn save_game_cfg(
    opl_path: String,
    game_id: String,
    title: String,
    dma_mode: String,
    compatibility_modes: Vec<u8>,
) -> Result<String, String> {
    let base = PathBuf::from(&opl_path);
    let cfg_dir = base.join("CFG");
    if !cfg_dir.exists() {
        fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;
    }

    let cfg_path = cfg_dir.join(format!("{}.cfg", game_id));
    let mut file = File::create(cfg_path).map_err(|e| e.to_string())?;

    let mut content = format!("CfgVersion=1\nTitle={}\n", title);
    if !dma_mode.is_empty() {
        content.push_str(&format!("$DMA={}\n", dma_mode));
    }
    for mode in compatibility_modes {
        content.push_str(&format!("$Compatibility{}={}\n", mode, 1));
    }

    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok("Archivo .cfg guardado correctamente".into())
}

// 4. LECTOR DE CARÁTULAS
#[tauri::command]
fn get_cover_image(opl_path: String, game_id: String) -> Result<Vec<u8>, String> {
    let art_dir = PathBuf::from(opl_path).join("ART");
    let jpg_path = art_dir.join(format!("{}_COV.jpg", game_id));
    let png_path = art_dir.join(format!("{}_COV.png", game_id));

    if jpg_path.exists() {
        fs::read(jpg_path).map_err(|e| e.to_string())
    } else if png_path.exists() {
        fs::read(png_path).map_err(|e| e.to_string())
    } else {
        Err("No existe imagen de carátula".into())
    }
}

// 5. PROCESAMIENTO EN LOTE (BATCH ACTIONS) - Ejecutado en hilo spawn_blocking
#[tauri::command]
async fn batch_process_games(app: AppHandle, opl_path: String, games: Vec<Ps2Game>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = games.len();
        if total == 0 {
            return Ok("No hay juegos para procesar".into());
        }

        let art_dir = PathBuf::from(&opl_path).join("ART");
        let cfg_dir = PathBuf::from(&opl_path).join("CFG");

        for (index, game) in games.into_iter().enumerate() {
            let current = index + 1;
            println!("\n[BATCH {}/{}] Procesando: {} (ID: {})", current, total, game.title, game.id);

            if game.id == "DESCONOCIDO" {
                println!("[BATCH] Omitiendo porque el ID es DESCONOCIDO");
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current,
                    total,
                    game_title: game.title.clone(),
                    action: "Omitido (ID desconocido)".into(),
                });
                continue;
            }

            // Paso A: Renombrar si no cumple el formato
            let is_formatted = game.file_name.to_lowercase().starts_with(&format!("{}.", game.id.to_lowercase()));
            if !is_formatted {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current,
                    total,
                    game_title: game.title.clone(),
                    action: "Renombrando a formato OPL...".into(),
                });
                let _ = fix_iso_filename(game.path.clone(), game.id.clone());
            }

            // Paso B: Descargar carátula si falta
            let has_art = art_dir.join(format!("{}_COV.jpg", game.id)).exists()
                || art_dir.join(format!("{}_COV.png", game.id)).exists();

            if !has_art {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current,
                    total,
                    game_title: game.title.clone(),
                    action: "Descargando carátula...".into(),
                });
                let _ = download_art(opl_path.clone(), game.id.clone());
            } else {
                println!("[BATCH] Carátula ya presente para {}", game.id);
            }

            // Paso C: Crear .cfg si no existe
            let cfg_file = cfg_dir.join(format!("{}.cfg", game.id));
            if !cfg_file.exists() {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current,
                    total,
                    game_title: game.title.clone(),
                    action: "Generando archivo CFG...".into(),
                });
                let _ = save_game_cfg(opl_path.clone(), game.id.clone(), game.title.clone(), "MDMA_0".into(), vec![]);
            } else {
                println!("[BATCH] Archivo .cfg ya presente para {}", game.id);
            }
        }

        let _ = app.emit("batch_progress", BatchProgressPayload {
            current: total,
            total,
            game_title: "Completado".into(),
            action: "Todos los juegos han sido procesados.".into(),
        });

        Ok("Procesamiento por lote finalizado con éxito".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_opl_folder,
            download_art,
            fix_iso_filename,
            save_game_cfg,
            get_cover_image,
            batch_process_games
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}