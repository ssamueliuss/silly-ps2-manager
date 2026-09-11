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

// 1. GESTIÓN DE CARÁTULAS Y ARTE: Descarga COV desde repositorios abiertos de OPL
#[tauri::command]
fn download_art(opl_path: String, game_id: String) -> Result<String, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    if !art_dir.exists() {
        fs::create_dir_all(&art_dir).map_err(|e| e.to_string())?;
    }

    // Repositorio habitual de carátulas OPL por serial
    let cover_url = format!(
        "https://raw.githubusercontent.com/PS2-OPL-Customs/OPL-Artwork/master/Art/{}_COV.jpg",
        game_id
    );

    let client = reqwest::blocking::Client::builder()
        .user_agent("SillyPS2Manager/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&cover_url).send().map_err(|e| e.to_string())?;

    if response.status().is_success() {
        let bytes = response.bytes().map_err(|e| e.to_string())?;
        let output_path = art_dir.join(format!("{}_COV.jpg", game_id));
        let mut file = File::create(output_path).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        Ok("Carátula descargada con éxito".into())
    } else {
        Err(format!("No se encontró carátula para el serial {}", game_id))
    }
}

// 2. RENOMBRADO Y ORGANIZACIÓN: Renombra a formato estándar ID.Título.iso
#[tauri::command]
fn fix_iso_filename(game_path: String, game_id: String, clean_title: String) -> Result<String, String> {
    let current_path = PathBuf::from(&game_path);
    let parent_dir = current_path.parent().ok_or("No se encontró directorio padre")?;

    // Limpiar caracteres no válidos para FAT32 / exFAT
    let safe_title: String = clean_title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    let new_file_name = format!("{}.{}.iso", game_id, safe_title.trim());
    let new_path = parent_dir.join(&new_file_name);

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