use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
pub struct Ps2Game {
    pub id: String,
    pub title: String,
    pub file_name: String,
    pub path: String,
    pub size_gb: f64,
    pub media_type: String,
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
    let mut games = Vec::new();

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
                            let title = file_name.replace(".iso", "").replace(".ISO", "");

                            games.push(Ps2Game {
                                id,
                                title,
                                file_name,
                                path: file_path.to_string_lossy().to_string(),
                                size_gb: (size_gb * 100.0).round() / 100.0,
                                media_type: subfolder.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(games)
}

// 1. GESTIÓN DE CARÁTULAS Y ARTE: Descarga desde xlenore/ps2-covers por Game ID
#[tauri::command]
fn download_art(opl_path: String, game_id: String) -> Result<String, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    if !art_dir.exists() {
        fs::create_dir_all(&art_dir).map_err(|e| e.to_string())?;
    }

    // Convertir formato OPL (SLES_533.83) al formato del repositorio (SLES-53383)
    let clean_id = game_id.replace('_', "-").replace('.', "");

    let client = reqwest::blocking::Client::builder()
        .user_agent("SillyPS2Manager/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let target_file_path = art_dir.join(format!("{}_COV.jpg", game_id));
    let mut downloaded = false;

    // URLs directas a los archivos raw de GitHub (probamos 2D y 3D)
    let urls = [
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/{}.jpg", clean_id),
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/3d/{}.jpg", clean_id),
    ];

    for url in urls {
        if let Ok(res) = client.get(&url).send() {
            if res.status().is_success() {
                if let Ok(bytes) = res.bytes() {
                    if let Ok(mut file) = File::create(&target_file_path) {
                        if file.write_all(&bytes).is_ok() {
                            downloaded = true;
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
        Err(format!("No se encontró carátula para el serial {} en el repositorio", clean_id))
    }
}

// 2. RENOMBRADO Y ORGANIZACIÓN: Renombra a formato estándar ID.Título.iso
#[tauri::command]
fn fix_iso_filename(game_path: String, game_id: String) -> Result<String, String> {
    let current_path = PathBuf::from(&game_path);
    let parent_dir = current_path.parent().ok_or("No se encontró el directorio padre")?;

    let file_stem = current_path
        .file_stem()
        .ok_or("Nombre de archivo inválido")?
        .to_string_lossy();

    // Regex para detectar si el serial ya está presente al inicio o con separadores
    let serial_pattern = Regex::new(r"(?i)^(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_.](\d{3})[-_.](\d{2})[._\s-]*").unwrap();

    // Extraemos solo el título limpio removiendo cualquier serial al inicio
    let raw_title = serial_pattern.replace(&file_stem, "").to_string();
    let clean_title = if raw_title.trim().is_empty() {
        "Juego".to_string()
    } else {
        raw_title.trim().to_string()
    };

    // Sanitizar caracteres prohibidos en FAT32/exFAT
    let safe_title: String = clean_title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    let target_file_name = format!("{}.{}.iso", game_id, safe_title.trim());
    let new_path = parent_dir.join(&target_file_name);

    // Si ya tiene exactamente ese nombre, evitamos renombrar
    if current_path == new_path {
        return Ok("El archivo ya cumple con el formato estándar de OPL.".to_string());
    }

    fs::rename(&current_path, &new_path).map_err(|e| e.to_string())?;

    Ok(new_path.to_string_lossy().to_string())
}

// 3. ARCHIVOS DE CONFIGURACIÓN (.CFG): Escribe metadatos en /CFG/ID.cfg
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

    // Formato estándar que lee OPL en CFG
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_opl_folder,
            download_art,
            fix_iso_filename,
            save_game_cfg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}