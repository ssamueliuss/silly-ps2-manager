use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use sysinfo::Disks; 
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

#[derive(Serialize, Clone)]
pub struct SyncProgressPayload {
    pub current_file_idx: usize,
    pub total_files: usize,
    pub current_file_name: String,
    pub percent: u8,
    pub status_text: String,
}

#[derive(Serialize, Clone)]
pub struct UsbDrive {
    pub name: String,
    pub mount_point: String,
    pub device_path: String,
    pub total_space_gb: f64,
    pub file_system: String,
}

// Generador de CRC32 manual para nombrar las partes USBUtil sin dependencias extra
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFFFFFF;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
    }
    crc ^ 0xFFFFFFFF
}

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

#[tauri::command]
fn scan_opl_folder(opl_path: String) -> Result<Vec<Ps2Game>, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    let mut games = Vec::new();

    let serial_cleanup_re = Regex::new(r"(?i)^(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_.](\d{3})[-_.](\d{2})[._\s-]*").unwrap();

    // 1. Escaneo de ISOs estándar en DVD y CD
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

                            let has_cover = art_dir.join(format!("{}_COV.png", id)).exists()
                                || art_dir.join(format!("{}_COV.jpg", id)).exists();

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

    // 2. Escaneo de juegos divididos (USBUtil) mediante el archivo maestro ul.cfg
    let ul_cfg_path = base.join("ul.cfg");
    if let Ok(mut f) = File::open(ul_cfg_path) {
        let mut buf = [0u8; 64];
        while f.read_exact(&mut buf).is_ok() {
            let title = String::from_utf8_lossy(&buf[0..32]).trim_matches('\0').trim().to_string();
            // Leemos el prefijo base de 14 bytes (ej. "ul.932A1EC4")
            let startup = String::from_utf8_lossy(&buf[32..46]).trim_matches('\0').trim().to_string();
            let parts = buf[47];
            let media = buf[48]; // 0x12 DVD, 0x14 CD

            if startup.is_empty() { continue; }

            let mut id = startup.clone();
            
            // CORRECCIÓN: Buscamos en el directorio el archivo ".00" real para extraer el Game ID completo que inyectó USBUtil
            if let Ok(entries) = fs::read_dir(&base) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with(&startup) && name.ends_with(".00") {
                        if let Some(stripped) = name.strip_prefix(&format!("{}.", startup)) {
                            if let Some(real_id) = stripped.strip_suffix(".00") {
                                id = real_id.to_string(); // Extraemos "SCES_517.19"
                                break;
                            }
                        }
                    }
                }
            }

            let has_cover = art_dir.join(format!("{}_COV.png", id)).exists()
                || art_dir.join(format!("{}_COV.jpg", id)).exists();

            games.push(Ps2Game {
                id,
                title,
                file_name: format!("ul.cfg ({} parts)", parts),
                path: base.to_string_lossy().to_string(),
                size_gb: ((parts as f64) * 1024.0 * 1024.0 * 1024.0) / (1024.0 * 1024.0 * 1024.0), 
                media_type: if media == 0x12 { "DVD (Split)".to_string() } else { "CD (Split)".to_string() },
                has_cover,
            });
        }
    }

    Ok(games)
}

#[tauri::command]
fn download_art(opl_path: String, game_id: String) -> Result<String, String> {
    let base = PathBuf::from(&opl_path);
    let art_dir = base.join("ART");
    if !art_dir.exists() {
        fs::create_dir_all(&art_dir).map_err(|e| e.to_string())?;
    }

    let clean_id = game_id.replace('_', "-").replace('.', "");
    let client = reqwest::blocking::Client::builder()
        .user_agent("SillyPS2Manager/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let urls = [
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/{}.jpg", clean_id),
        format!("https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/3d/{}.png", clean_id),
    ];

    let mut raw_bytes: Option<Vec<u8>> = None;

    for url in urls {
        if let Ok(res) = client.get(&url).send() {
            if res.status().is_success() {
                if let Ok(bytes) = res.bytes() {
                    raw_bytes = Some(bytes.to_vec());
                    break;
                }
            }
        }
    }

    let bytes = raw_bytes.ok_or_else(|| format!("No se encontró carátula para {}", clean_id))?;

    let img = image::load(Cursor::new(&bytes), image::ImageFormat::from_path(Path::new("dummy.jpg")).unwrap_or(image::ImageFormat::Jpeg))
        .or_else(|_| image::load_from_memory(&bytes))
        .map_err(|e| format!("Error decodificando imagen: {}", e))?;

    let resized = img.resize_exact(140, 200, image::imageops::FilterType::Lanczos3);

    let target_png = art_dir.join(format!("{}_COV.png", game_id));
    let target_jpg = art_dir.join(format!("{}_COV.jpg", game_id));

    let _ = resized.save_with_format(&target_png, image::ImageFormat::Png);
    let _ = resized.save_with_format(&target_jpg, image::ImageFormat::Jpeg);

    Ok(format!("Carátula descargada y optimizada para OPL (140x200)"))
}

#[tauri::command]
fn fix_iso_filename(game_path: String, game_id: String) -> Result<String, String> {
    let current_path = PathBuf::from(&game_path);
    
    if !current_path.is_file() {
        return Ok("No aplica para juegos divididos.".to_string());
    }

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

    fs::rename(&current_path, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

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

#[tauri::command]
fn get_cover_image(opl_path: String, game_id: String) -> Result<Vec<u8>, String> {
    let art_dir = PathBuf::from(opl_path).join("ART");
    let png_path = art_dir.join(format!("{}_COV.png", game_id));
    let jpg_path = art_dir.join(format!("{}_COV.jpg", game_id));

    if png_path.exists() {
        fs::read(png_path).map_err(|e| e.to_string())
    } else if jpg_path.exists() {
        fs::read(jpg_path).map_err(|e| e.to_string())
    } else {
        Err("No existe imagen de carátula".into())
    }
}

#[tauri::command]
async fn batch_process_games(app: AppHandle, opl_path: String, games: Vec<Ps2Game>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let total = games.len();
        if total == 0 { return Ok("No hay juegos".into()); }

        let art_dir = PathBuf::from(&opl_path).join("ART");
        let cfg_dir = PathBuf::from(&opl_path).join("CFG");

        for (index, game) in games.into_iter().enumerate() {
            let current = index + 1;
            
            if game.id == "DESCONOCIDO" {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current, total, game_title: game.title.clone(), action: "Omitido (ID desconocido)".into(),
                });
                continue;
            }

            let is_split = game.media_type.contains("Split");
            let is_formatted = is_split || game.file_name.to_lowercase().starts_with(&format!("{}.", game.id.to_lowercase()));
            
            if !is_formatted {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current, total, game_title: game.title.clone(), action: "Renombrando a formato OPL...".into(),
                });
                let _ = fix_iso_filename(game.path.clone(), game.id.clone());
            }

            let has_art = art_dir.join(format!("{}_COV.png", game.id)).exists()
                || art_dir.join(format!("{}_COV.jpg", game.id)).exists();
            if !has_art {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current, total, game_title: game.title.clone(), action: "Descargando carátula...".into(),
                });
                let _ = download_art(opl_path.clone(), game.id.clone());
            }

            let cfg_file = cfg_dir.join(format!("{}.cfg", game.id));
            if !cfg_file.exists() {
                let _ = app.emit("batch_progress", BatchProgressPayload {
                    current, total, game_title: game.title.clone(), action: "Generando archivo CFG...".into(),
                });
                let _ = save_game_cfg(opl_path.clone(), game.id.clone(), game.title.clone(), "MDMA_0".into(), vec![]);
            }
        }

        let _ = app.emit("batch_progress", BatchProgressPayload {
            current: total, total, game_title: "Completado".into(), action: "Todos los juegos han sido procesados.".into(),
        });
        Ok("Procesamiento por lote finalizado con éxito".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_removable_drives() -> Vec<UsbDrive> {
    let mut drives = Vec::new();
    let disks = Disks::new_with_refreshed_list();
    
    for disk in disks.list() {
        if disk.is_removable() {
            let size_gb = (disk.total_space() as f64) / (1024.0 * 1024.0 * 1024.0);
            let dev_path = disk.name().to_string_lossy().to_string();
            let mount = disk.mount_point().to_string_lossy().to_string();

            drives.push(UsbDrive {
                name: if dev_path.is_empty() { "USB Drive".to_string() } else { dev_path.clone() },
                mount_point: mount,
                device_path: dev_path,
                total_space_gb: (size_gb * 100.0).round() / 100.0,
                file_system: disk.file_system().to_string_lossy().to_string(),
            });
        }
    }
    drives
}

#[tauri::command]
fn create_opl_structure(mount_point: String) -> Result<String, String> {
    let base = PathBuf::from(&mount_point);
    let folders = ["DVD", "CD", "ART", "CFG", "CHT", "VMC", "THM"];
    
    for folder in folders {
        let dir = base.join(folder);
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("Error creando {}: {}", folder, e))?;
        }
    }
    Ok("Estructura de carpetas OPL creada correctamente.".into())
}

#[tauri::command]
async fn format_usb_drive(
    device_path: String,
    mount_point: String,
    fs_type: String, 
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let is_fat32 = fs_type.to_lowercase() == "fat32";

        #[cfg(target_os = "linux")]
        {
            let _ = Command::new("udisksctl")
                .args(["unmount", "-b", device_path.as_str(), "--force"])
                .output();

            let fs_arg = if is_fat32 { "vfat" } else { "exfat" };
            let format_output = Command::new("udisksctl")
                .args(["format", "-b", device_path.as_str(), "-t", fs_arg, "--label", "PS2USB"])
                .output();

            let format_success = match format_output {
                Ok(out) => out.status.success(),
                Err(_) => false,
            };

            if !format_success {
                let (cmd, args) = if is_fat32 {
                    ("mkfs.vfat", vec!["-F", "32", "-s", "64", "-I", "-n", "PS2USB", device_path.as_str()])
                } else {
                    ("mkfs.exfat", vec!["-n", "PS2USB", device_path.as_str()])
                };

                let pkexec_out = Command::new("pkexec")
                    .arg(cmd)
                    .args(&args)
                    .output()
                    .map_err(|e| format!("Error ejecutando formateo: {}", e))?;

                if !pkexec_out.status.success() {
                    let err = String::from_utf8_lossy(&pkexec_out.stderr);
                    return Err(format!("Error en mkfs: {}", err));
                }
            }

            let mount_cmd = Command::new("udisksctl")
                .args(["mount", "-b", device_path.as_str()])
                .output()
                .map_err(|e| format!("Error al montar unidad formateada: {}", e))?;

            let mount_stdout = String::from_utf8_lossy(&mount_cmd.stdout);
            let final_mount = if let Some(pos) = mount_stdout.find(" at ") {
                let raw_path = &mount_stdout[pos + 4..];
                raw_path.trim().trim_end_matches('.').trim_end_matches('\n').to_string()
            } else {
                mount_point
            };

            std::thread::sleep(std::time::Duration::from_millis(2000));
            Ok(final_mount)
        }

        #[cfg(target_os = "windows")]
        {
            let drive_letter = if !mount_point.is_empty() {
                mount_point.trim_end_matches('\\').to_string()
            } else {
                device_path.trim_end_matches('\\').to_string()
            };

            let clean_letter = drive_letter.replace(':', "");
            let ps_script = if is_fat32 {
                format!("Format-Volume -DriveLetter {} -FileSystem FAT32 -AllocationUnitSize 32768 -NewFileSystemLabel 'PS2USB' -Force", clean_letter)
            } else {
                format!("Format-Volume -DriveLetter {} -FileSystem exFAT -NewFileSystemLabel 'PS2USB' -Force", clean_letter)
            };

            let output = Command::new("powershell")
                .args(["-Command", &format!("Start-Process powershell -ArgumentList '-NoProfile -Command \"{}\"' -Verb RunAs -Wait", ps_script)])
                .output()
                .map_err(|e| format!("Error en PowerShell: {}", e))?;

            if !output.status.success() {
                let err_str = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Error en PowerShell: {}", err_str));
            }

            std::thread::sleep(std::time::Duration::from_millis(1500));
            Ok(format!("{}:\\", clean_letter))
        }

        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        {
            Err("Formateo no soportado en este sistema operativo.".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sync_opl_folder(app: AppHandle, source_path: String, target_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut target_is_fat32 = false;
        let disks = Disks::new_with_refreshed_list();
        for disk in disks.list() {
            let mount = disk.mount_point().to_string_lossy().to_string();
            if target_path.starts_with(&mount) {
                let fs = disk.file_system().to_string_lossy().to_lowercase();
                if fs.contains("fat") || fs.contains("vfat") {
                    target_is_fat32 = true;
                    break;
                }
            }
        }

        let mut existing_split_ids = std::collections::HashSet::new();
        let ul_cfg_path = PathBuf::from(&target_path).join("ul.cfg");
        if let Ok(mut f) = File::open(&ul_cfg_path) {
            let mut buf = [0u8; 64];
            while f.read_exact(&mut buf).is_ok() {
                let startup = String::from_utf8_lossy(&buf[32..46]).trim_matches('\0').trim().to_string();
                
                let mut real_id = startup.clone();
                if let Ok(entries) = fs::read_dir(&target_path) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with(&startup) && name.ends_with(".00") {
                            if let Some(stripped) = name.strip_prefix(&format!("{}.", startup)) {
                                if let Some(rid) = stripped.strip_suffix(".00") {
                                    real_id = rid.to_string();
                                    break;
                                }
                            }
                        }
                    }
                }
                existing_split_ids.insert(real_id);
            }
        }

        let folders = ["DVD", "CD", "ART", "CFG", "CHT", "VMC", "THM"];
        let mut files_to_copy = Vec::new();

        for folder in &folders {
            let src_dir = PathBuf::from(&source_path).join(folder);
            let dst_dir = PathBuf::from(&target_path).join(folder);
            
            if src_dir.exists() {
                if !dst_dir.exists() {
                    let _ = fs::create_dir_all(&dst_dir);
                }
                if let Ok(entries) = fs::read_dir(&src_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            let dst_path = dst_dir.join(entry.file_name());
                            let mut should_copy = true;
                            
                            if let Some(ext) = path.extension() {
                                if ext.to_string_lossy().to_lowercase() == "iso" {
                                    if let Some(id) = extract_game_id(&path) {
                                        if existing_split_ids.contains(&id) {
                                            should_copy = false;
                                        }
                                    }
                                }
                            }

                            if dst_path.exists() && should_copy {
                                if let (Ok(src_meta), Ok(dst_meta)) = (entry.metadata(), dst_path.metadata()) {
                                    if src_meta.len() == dst_meta.len() {
                                        should_copy = false;
                                    }
                                }
                            }
                            
                            if should_copy {
                                files_to_copy.push((path, dst_path, entry.file_name().to_string_lossy().to_string()));
                            }
                        }
                    }
                }
            }
        }

        let total_files = files_to_copy.len();
        if total_files == 0 {
            return Ok("Todo está sincronizado. No hay archivos nuevos para copiar.".into());
        }

        let mut buffer = vec![0u8; 4 * 1024 * 1024];

        for (idx, (src, dst, name)) in files_to_copy.into_iter().enumerate() {
            let current_idx = idx + 1;
            let mut src_file = File::open(&src).map_err(|e| format!("Error leyendo {}: {}", name, e))?;
            let total_size = src_file.metadata().map(|m| m.len()).unwrap_or(0);
            
            let is_iso = src.extension().map(|s| s.to_string_lossy().to_lowercase() == "iso").unwrap_or(false);
            let do_split = is_iso && target_is_fat32 && total_size >= 4_290_000_000; 

            let _ = app.emit("sync_progress", SyncProgressPayload {
                current_file_idx: current_idx,
                total_files,
                current_file_name: name.clone(),
                percent: 0,
                status_text: if do_split { "Cortando (FAT32)...".into() } else { "Copiando...".into() },
            });

            let mut copied = 0u64;
            let mut since_last_sync = 0u64;
            let mut last_percent = 200;

            if do_split {
                let game_id = extract_game_id(&src).unwrap_or_else(|| "SLUS_000.00".to_string());
                let stem = Path::new(&name).file_stem().unwrap_or_default().to_string_lossy().to_string();
                let serial_cleanup_re = Regex::new(r"(?i)^(SLES|SLUS|SCES|SCUS|SLPM|SCPS|SLKA)[-_.](\d{3})[-_.](\d{2})[._\s-]*").unwrap();
                let clean_title = serial_cleanup_re.replace(&stem, "").trim().to_string();
                let title = if clean_title.is_empty() { stem } else { clean_title };

                let mut entry = [0u8; 64];
                let title_bytes = title.as_bytes();
                let len = title_bytes.len().min(32);
                entry[0..len].copy_from_slice(&title_bytes[..len]);
                let crc = crc32(&entry[0..32]);

                // CORRECCIÓN VITAL: El campo startup es STRICTAMENTE ul.CRC32 de 11 bytes.
                let ul_prefix_short = format!("ul.{:08X}", crc);
                let prefix_bytes = ul_prefix_short.as_bytes();
                let p_len = prefix_bytes.len().min(14);
                entry[32..32+p_len].copy_from_slice(&prefix_bytes[..p_len]);
                entry[48] = 0x12; 

                // Los archivos se nombran con el ID extra para que OPL lo pueda extraer
                let ul_prefix = format!("ul.{:08X}.{}", crc, game_id);
                
                let mut part_idx = 0;
                let mut bytes_in_part = 0u64;
                let part_size_limit = 1024 * 1024 * 1024; 
                
                let mut dst_file = File::create(PathBuf::from(&target_path).join(format!("{}.{:02}", ul_prefix, part_idx)))
                    .map_err(|e| format!("Error creando parte {}: {}", part_idx, e))?;

                loop {
                    let bytes_read = src_file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if bytes_read == 0 { break; }

                    let mut offset = 0;
                    while offset < bytes_read {
                        let space_left = part_size_limit - bytes_in_part;
                        let chunk = usize::min(bytes_read - offset, space_left as usize);

                        dst_file.write_all(&buffer[offset..offset+chunk]).map_err(|e| e.to_string())?;
                        offset += chunk;
                        bytes_in_part += chunk as u64;
                        copied += chunk as u64;
                        since_last_sync += chunk as u64;

                        if bytes_in_part >= part_size_limit {
                            let _ = dst_file.sync_all();
                            part_idx += 1;
                            bytes_in_part = 0;
                            dst_file = File::create(PathBuf::from(&target_path).join(format!("{}.{:02}", ul_prefix, part_idx)))
                                .map_err(|e| format!("Error creando parte {}: {}", part_idx, e))?;
                        }
                    }

                    if since_last_sync >= 32 * 1024 * 1024 {
                        let _ = dst_file.sync_data();
                        since_last_sync = 0;
                    }

                    if total_size > 0 {
                        let percent = ((copied as f64 / total_size as f64) * 98.0) as u8; 
                        if percent != last_percent && percent % 2 == 0 {
                            let _ = app.emit("sync_progress", SyncProgressPayload {
                                current_file_idx: current_idx, total_files, current_file_name: name.clone(), percent, status_text: format!("{}%", percent),
                            });
                            last_percent = percent;
                        }
                    }
                }

                let _ = dst_file.sync_all();

                entry[47] = (part_idx + 1) as u8;
                let mut cfg_file = fs::OpenOptions::new().create(true).append(true).open(&ul_cfg_path)
                    .or_else(|_| File::create(&ul_cfg_path))
                    .map_err(|e| format!("Error abriendo/creando ul.cfg: {}", e))?;
                cfg_file.write_all(&entry).map_err(|e| e.to_string())?;
                let _ = cfg_file.sync_all();

            } else {
                let mut dst_file = File::create(&dst).map_err(|e| format!("Error creando destino {}: {}", name, e))?;
                
                loop {
                    let bytes_read = src_file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if bytes_read == 0 { break; }
                    
                    dst_file.write_all(&buffer[..bytes_read]).map_err(|e| e.to_string())?;
                    copied += bytes_read as u64;
                    since_last_sync += bytes_read as u64;

                    if since_last_sync >= 32 * 1024 * 1024 {
                        let _ = dst_file.sync_data();
                        since_last_sync = 0;
                    }

                    if total_size > 0 {
                        let percent = ((copied as f64 / total_size as f64) * 98.0) as u8; 
                        if percent != last_percent && percent % 2 == 0 {
                            let _ = app.emit("sync_progress", SyncProgressPayload {
                                current_file_idx: current_idx, total_files, current_file_name: name.clone(), percent, status_text: format!("{}%", percent),
                            });
                            last_percent = percent;
                        }
                    }
                }
                
                let _ = dst_file.sync_all();
            }

            let _ = app.emit("sync_progress", SyncProgressPayload {
                current_file_idx: current_idx, total_files, current_file_name: name.clone(), percent: 100, status_text: "100%".into(),
            });
        }

        Ok(format!("{} archivos procesados correctamente.", total_files))
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
            batch_process_games,
            get_removable_drives,
            create_opl_structure,
            format_usb_drive,
            sync_opl_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}