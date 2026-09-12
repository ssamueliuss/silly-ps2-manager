import { useState, useMemo, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Toaster, toast } from "sonner";

interface Ps2Game {
  id: string;
  title: string;
  file_name: string;
  path: string;
  size_gb: number;
  media_type: string;
  has_cover: boolean;
}

interface BatchProgressPayload {
  current: number;
  total: number;
  game_title: string;
  action: string;
}

type Language = "es" | "en";

const translations = {
  es: {
    openFolder: "📁 Abrir carpeta OPL",
    reload: "🔄 Recargar",
    batchActions: "⚡ Acciones en lote",
    settings: "⚙ Configuración",
    title: "Título",
    id: "ID",
    type: "Tipo",
    size: "Tamaño",
    format: "Formato",
    cover: "Carátula",
    scanning: "Escaneando...",
    gameDetails: "Detalles del Juego",
    path: "Ruta:",
    operations: "Operaciones (Individual)",
    renameBtn: "Renombrar (Formato OPL)",
    cfgBtn: "Editar / Crear CFG",
    downloadArtBtn: "Descargar Arte",
    globalStats: "Estadísticas Globales",
    total: "Total",
    waitingDir: "Esperando directorio...",
    activePath: "Ruta activa:",
    mode: "Modo: Local / USB",
    batchRunningTitle: "Procesando en Lote...",
    gameLabel: "Juego:",
    actionLabel: "Acción:",
    batchDone: "Procesamiento por lote completado",
    settingsTitle: "Configuración & Información",
    langSection: "Idioma de la interfaz",
    aboutSection: "Acerca de la aplicación",
    devSection: "Desarrollador & Enlaces",
    appDesc: "Suite todo-en-uno para gestión de juegos, carátulas y configuraciones de PlayStation 2 Open PS2 Loader (OPL).",
    closeBtn: "Cerrar",
    dirLoaded: "Directorio cargado",
    dirReloaded: "Directorio recargado",
    standardRenamed: "Archivo renombrado a estándar OPL",
    cfgSaved: "Archivo .cfg guardado correctamente",
  },
  en: {
    openFolder: "📁 Open OPL folder",
    reload: "🔄 Reload",
    batchActions: "⚡ Batch Actions",
    settings: "⚙ Settings",
    title: "Title",
    id: "ID",
    type: "Type",
    size: "Size",
    format: "Format",
    cover: "Cover",
    scanning: "Scanning...",
    gameDetails: "Game Details",
    path: "Path:",
    operations: "Operations (Individual)",
    renameBtn: "Rename (Format OPL)",
    cfgBtn: "Edit / Create CFG",
    downloadArtBtn: "Manage ARTs (Download)",
    globalStats: "Global Stats",
    total: "Total",
    waitingDir: "Waiting for directory...",
    activePath: "Active path:",
    mode: "Mode: Local / USB",
    batchRunningTitle: "Batch Processing...",
    gameLabel: "Game:",
    actionLabel: "Action:",
    batchDone: "Batch process completed",
    settingsTitle: "Settings & Information",
    langSection: "Interface Language",
    aboutSection: "About Application",
    devSection: "Developer & Links",
    appDesc: "All-in-one suite for PlayStation 2 Open PS2 Loader (OPL) game management, cover art acquisition, and configurations.",
    closeBtn: "Close",
    dirLoaded: "Directory loaded",
    dirReloaded: "Directory reloaded",
    standardRenamed: "File renamed to OPL standard",
    cfgSaved: "CFG file saved successfully",
  },
};

export default function App() {
  const [lang, setLang] = useState<Language>("es");
  const t = translations[lang];

  const [oplPath, setOplPath] = useState<string | null>(null);
  const [games, setGames] = useState<Ps2Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Ps2Game | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  // Estados de modales
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressPayload | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const isOplFormatted = (fileName: string, id: string) => {
    return fileName.toLowerCase().startsWith(`${id.toLowerCase()}.`);
  };

  const refreshGames = async (path: string, showToast = false) => {
    setLoading(true);
    try {
      const result = await invoke<Ps2Game[]>("scan_opl_folder", { oplPath: path });
      setGames(result);
      if (selectedGame) {
        const stillExists = result.find((g) => g.id === selectedGame.id);
        if (stillExists) setSelectedGame(stillExists);
      }
      if (showToast) {
        toast.success(t.dirReloaded);
      }
    } catch (err) {
      toast.error("Error al escanear directorio", { description: String(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Selecciona la raíz de tu USB / Carpeta OPL",
    });

    if (typeof selected === "string") {
      setOplPath(selected);
      setSelectedGame(null);
      toast.info(t.dirLoaded, { description: selected });
      refreshGames(selected);
    }
  };

  const handleManualReload = () => {
    if (oplPath) {
      refreshGames(oplPath, true);
    } else {
      toast.info(t.waitingDir);
    }
  };

  const loadCover = async (gameId: string) => {
    if (!oplPath) return;
    try {
      const bytes = await invoke<number[]>("get_cover_image", { oplPath, gameId });
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
      setCoverUrl(URL.createObjectURL(blob));
    } catch {
      setCoverUrl(null);
    }
  };

  useEffect(() => {
    if (selectedGame) {
      loadCover(selectedGame.id);
    } else {
      setCoverUrl(null);
    }
  }, [selectedGame]);

  useEffect(() => {
    const unlistenPromise = listen<BatchProgressPayload>("batch_progress", (event) => {
      setBatchProgress(event.payload);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleBatchProcess = async () => {
    if (!oplPath || games.length === 0) {
      toast.info("No hay juegos cargados para procesar.");
      return;
    }

    setIsBatchRunning(true);
    setBatchProgress({
      current: 0,
      total: games.length,
      game_title: "Iniciando...",
      action: "Preparando operaciones...",
    });

    try {
      await invoke("batch_process_games", { oplPath, games });
      toast.success(t.batchDone);
    } catch (err) {
      toast.error("Error durante el procesamiento por lote", { description: String(err) });
    } finally {
      setIsBatchRunning(false);
      setBatchProgress(null);
      refreshGames(oplPath);
    }
  };

  const handleDownloadArt = async () => {
    if (!oplPath || !selectedGame) return;
    const toastId = toast.loading(`Descargando arte para ${selectedGame.id}...`);
    try {
      const msg = await invoke<string>("download_art", { oplPath, gameId: selectedGame.id });
      toast.success(msg, { id: toastId });
      loadCover(selectedGame.id);
      refreshGames(oplPath);
    } catch (err) {
      toast.error("Error", { id: toastId, description: String(err) });
    }
  };

  const handleFixName = async () => {
    if (!oplPath || !selectedGame || selectedGame.id === "DESCONOCIDO") return;
    try {
      await invoke("fix_iso_filename", { gamePath: selectedGame.path, gameId: selectedGame.id });
      toast.success(t.standardRenamed);
      refreshGames(oplPath);
    } catch (err) {
      toast.error("Error al renombrar", { description: String(err) });
    }
  };

  const handleGenerateCfg = async () => {
    if (!oplPath || !selectedGame || selectedGame.id === "DESCONOCIDO") return;
    try {
      const msg = await invoke<string>("save_game_cfg", {
        oplPath,
        gameId: selectedGame.id,
        title: selectedGame.title,
        dmaMode: "MDMA_0",
        compatibilityModes: [],
      });
      toast.success(msg || t.cfgSaved);
    } catch (err) {
      toast.error("Error al generar CFG", { description: String(err) });
    }
  };

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const stats = useMemo(() => {
    const dvdGames = games.filter((g) => g.media_type === "DVD");
    const cdGames = games.filter((g) => g.media_type === "CD");
    const totalSize = games.reduce((acc, g) => acc + g.size_gb, 0);
    return {
      dvdCount: dvdGames.length,
      dvdSize: dvdGames.reduce((acc, g) => acc + g.size_gb, 0).toFixed(2),
      cdCount: cdGames.length,
      cdSize: cdGames.reduce((acc, g) => acc + g.size_gb, 0).toFixed(2),
      totalCount: games.length,
      totalSize: totalSize.toFixed(2),
    };
  }, [games]);

  const progressPercent =
    batchProgress && batchProgress.total > 0
      ? Math.round((batchProgress.current / batchProgress.total) * 100)
      : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "system-ui, sans-serif",
        backgroundColor: "#F5F1E8",
        color: "#2B262C",
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      <style>{`
        .top-btn {
          background-color: #F5F1E8;
          color: #2B262C;
          border: 1px solid #DCD5C8;
          border-radius: 4px;
          padding: 5px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          box-shadow: 0 1px 2px rgba(43, 38, 44, 0.06);
          transition: background-color 0.15s, border-color 0.15s, transform 0.05s;
        }
        .top-btn:hover:not(:disabled) {
          background-color: #ECE5D8;
          border-color: #2B262C;
        }
        .top-btn:active:not(:disabled) {
          transform: translateY(1px);
          box-shadow: none;
        }
        .top-btn:disabled {
          background-color: #FAF8F5;
          color: #A8A29E;
          border-color: #EAE4D8;
          cursor: default;
          box-shadow: none;
        }
        .top-btn-primary {
          background-color: #2B262C;
          color: #F5F1E8;
          border-color: #2B262C;
        }
        .top-btn-primary:hover:not(:disabled) {
          background-color: #3E373F;
          border-color: #3E373F;
        }
        .link-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background-color: #F5F1E8;
          border: 1px solid #DCD5C8;
          border-radius: 6px;
          color: #2B262C;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          transition: background-color 0.15s, border-color 0.15s;
        }
        .link-pill:hover {
          background-color: #2B262C;
          color: #F5F1E8;
          border-color: #2B262C;
        }
      `}</style>

      <Toaster richColors position="bottom-right" />

      {/* MODAL DE PROGRESO POR LOTE */}
      {isBatchRunning && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(43, 38, 44, 0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            backdropFilter: "blur(2px)",
          }}
        >
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid #DCD5C8",
              borderRadius: 8,
              padding: "24px",
              width: 440,
              boxShadow: "0 8px 24px rgba(43, 38, 44, 0.2)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "#2B262C" }}>
                {t.batchRunningTitle}
              </span>
              <span style={{ fontWeight: 700, fontSize: 13, color: "#2B262C" }}>
                {batchProgress ? `${batchProgress.current} / ${batchProgress.total} (${progressPercent}%)` : "0%"}
              </span>
            </div>

            <div
              style={{
                width: "100%",
                height: 12,
                backgroundColor: "#EAE4D8",
                borderRadius: 6,
                overflow: "hidden",
                border: "1px solid #DCD5C8",
              }}
            >
              <div
                style={{
                  width: `${progressPercent}%`,
                  height: "100%",
                  backgroundColor: "#2B262C",
                  transition: "width 0.2s ease-in-out",
                }}
              />
            </div>

            <div style={{ fontSize: 13, color: "#766F78", display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontWeight: 600, color: "#2B262C", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t.gameLabel} {batchProgress?.game_title || "..."}
              </div>
              <div style={{ fontSize: 12 }}>
                {t.actionLabel} {batchProgress?.action || "..."}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE SETTINGS / ACERCA DE */}
      {isSettingsOpen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(43, 38, 44, 0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
            backdropFilter: "blur(2px)",
          }}
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            style={{
              backgroundColor: "#FFFFFF",
              border: "1px solid #DCD5C8",
              borderRadius: 8,
              padding: "24px",
              width: 480,
              boxShadow: "0 10px 30px rgba(43, 38, 44, 0.25)",
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#2B262C" }}>
                {t.settingsTitle}
              </h3>
              <button
                onClick={() => setIsSettingsOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: 16,
                  fontWeight: 700,
                  cursor: "pointer",
                  color: "#766F78",
                }}
              >
                ✕
              </button>
            </div>

            {/* Selector de Idioma */}
            <fieldset style={{ border: "1px solid #DCD5C8", borderRadius: 6, padding: "12px", margin: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
                {t.langSection}
              </legend>
              <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: lang === "es" ? 700 : 400 }}>
                  <input
                    type="radio"
                    name="language"
                    value="es"
                    checked={lang === "es"}
                    onChange={() => setLang("es")}
                  />
                  Español
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: lang === "en" ? 700 : 400 }}>
                  <input
                    type="radio"
                    name="language"
                    value="en"
                    checked={lang === "en"}
                    onChange={() => setLang("en")}
                  />
                  English
                </label>
              </div>
            </fieldset>

            {/* Info de la App */}
            <fieldset style={{ border: "1px solid #DCD5C8", borderRadius: 6, padding: "12px", margin: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
                {t.aboutSection}
              </legend>
              <div style={{ fontSize: 13, color: "#2B262C", display: "flex", flexDirection: "column", gap: 6 }}>
                <div><strong>Silly PS2 Manager</strong> &bull; v1.0.0</div>
                <div style={{ color: "#766F78", lineHeight: 1.4 }}>
                  {t.appDesc}
                </div>
                <div style={{ fontSize: 11, color: "#A8A29E" }}>
                  Construido con Tauri v2, Rust & React.
                </div>
              </div>
            </fieldset>

            {/* Enlaces y Desarrollador */}
            <fieldset style={{ border: "1px solid #DCD5C8", borderRadius: 6, padding: "12px", margin: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
                {t.devSection}
              </legend>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                <button
                  className="link-pill"
                  onClick={() => handleOpenLink("https://sillydevs.vercel.app")}
                >
                  🌐 Portafolio / Web
                </button>
                <button
                  className="link-pill"
                  onClick={() => handleOpenLink("https://github.com/ssamueliuss")}
                >
                  🐙 GitHub (@ssamueliuss)
                </button>
                <button
                  className="link-pill"
                  onClick={() => handleOpenLink("https://github.com/xlenore/ps2-covers")}
                >
                  🎨 Repositorio de Covers (xlenore)
                </button>
              </div>
            </fieldset>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
              <button
                className="top-btn top-btn-primary"
                onClick={() => setIsSettingsOpen(false)}
                style={{ padding: "6px 16px" }}
              >
                {t.closeBtn}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Menú superior */}
      <header
        style={{
          backgroundColor: "#FFFFFF",
          borderBottom: "1px solid #EAE4D8",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <button
          className="top-btn top-btn-primary"
          onClick={handleSelectFolder}
          title="Seleccionar la carpeta raíz de tu USB o unidad OPL"
        >
          {t.openFolder}
        </button>

        <button
          className="top-btn"
          onClick={handleManualReload}
          disabled={!oplPath || loading}
          title="Vuelve a escanear las carpetas DVD, CD y ART"
        >
          {t.reload}
        </button>

        <button
          className="top-btn"
          onClick={handleBatchProcess}
          disabled={!oplPath || games.length === 0 || loading}
          title="Renombra, descarga carátulas y crea archivos CFG para toda la lista"
        >
          {t.batchActions}
        </button>

        <div style={{ marginLeft: "auto" }}>
          <button
            className="top-btn"
            onClick={() => setIsSettingsOpen(true)}
            style={{ color: "#2B262C" }}
          >
            {t.settings}
          </button>
        </div>
      </header>

      {/* Contenedor principal */}
      <main style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        {/* Columna Izquierda: Tabla */}
        <div
          style={{
            flex: "0 0 65%",
            borderRight: "1px solid #EAE4D8",
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#FFFFFF",
            minHeight: 0,
          }}
        >
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                textAlign: "center",
                fontSize: 13,
                userSelect: "none",
              }}
            >
              <thead
                style={{
                  position: "sticky",
                  top: 0,
                  backgroundColor: "#EAE4D8",
                  zIndex: 1,
                  boxShadow: "0 1px 2px rgba(43, 38, 44, 0.05)",
                }}
              >
                <tr>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>{t.title}</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>{t.id}</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>{t.type}</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>{t.size}</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>{t.format}</th>
                  <th style={{ padding: "6px 12px", color: "#2B262C", fontWeight: 700 }}>{t.cover}</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const isSelected = selectedGame?.id === g.id;
                  const formatted = isOplFormatted(g.file_name, g.id);
                  return (
                    <tr
                      key={g.path}
                      onClick={() => setSelectedGame(g)}
                      style={{
                        borderBottom: "1px solid #F5F1E8",
                        backgroundColor: isSelected ? "#EAE4D8" : "transparent",
                        color: isSelected ? "#2B262C" : "inherit",
                        cursor: "pointer",
                      }}
                    >
                      <td
                        style={{
                          padding: "4px 12px",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 220,
                          fontWeight: isSelected ? 600 : 400,
                          textAlign: "center",
                        }}
                      >
                        {g.title}
                      </td>
                      <td style={{ padding: "4px 12px", fontFamily: "monospace", fontWeight: isSelected ? 700 : 500 }}>
                        {g.id}
                      </td>
                      <td style={{ padding: "4px 12px" }}>PS2</td>
                      <td style={{ padding: "4px 12px" }}>{g.size_gb} GB</td>
                      <td
                        style={{
                          padding: "4px 12px",
                          color: formatted ? "#2B262C" : "#9C3D3D",
                          fontWeight: 600,
                        }}
                      >
                        {g.media_type} {formatted ? "✓" : "✗"}
                      </td>
                      <td
                        style={{
                          padding: "4px 12px",
                          fontWeight: 600,
                          color: g.has_cover ? "#2B262C" : "#8A848D",
                        }}
                      >
                        {g.has_cover ? "Yes" : "No"}
                      </td>
                    </tr>
                  );
                })}
                {loading && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, textAlign: "center", color: "#2B262C" }}>
                      {t.scanning}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Columna Derecha: Panel de Control */}
        <div
          style={{
            flex: "0 0 35%",
            padding: "16px",
            boxSizing: "border-box",
            overflowY: "auto",
            backgroundColor: "#F5F1E8",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minHeight: 0,
          }}
        >
          {/* Detalles del Juego */}
          <fieldset
            style={{
              border: "1px solid #DCD5C8",
              borderRadius: 6,
              padding: "12px",
              backgroundColor: "#FFFFFF",
              margin: 0,
              boxSizing: "border-box",
              width: "100%",
            }}
          >
            <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
              {t.gameDetails}
            </legend>

            <div style={{ display: "flex", gap: 16 }}>
              <div
                style={{
                  width: 85,
                  height: 120,
                  backgroundColor: "#EAE4D8",
                  border: "1px solid #DCD5C8",
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  overflow: "hidden",
                }}
              >
                {coverUrl ? (
                  <img src={coverUrl} alt="Cover" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ color: "#8A848D", fontSize: 28, fontWeight: 700 }}>?</span>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, flex: 1, justifyContent: "center" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>{t.title}:</span>
                  <input
                    readOnly
                    value={selectedGame?.title || ""}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "4px 8px",
                      border: "1px solid #DCD5C8",
                      borderRadius: 4,
                      backgroundColor: "#F5F1E8",
                      color: "#2B262C",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>{t.path}</span>
                  <input
                    readOnly
                    value={selectedGame?.path || ""}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "4px 8px",
                      border: "1px solid #DCD5C8",
                      borderRadius: 4,
                      backgroundColor: "#F5F1E8",
                      color: "#2B262C",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>{t.id}:</span>
                  <input
                    readOnly
                    value={selectedGame?.id || ""}
                    style={{
                      width: 130,
                      padding: "4px 8px",
                      border: "1px solid #DCD5C8",
                      borderRadius: 4,
                      backgroundColor: "#F5F1E8",
                      fontFamily: "monospace",
                      color: "#2B262C",
                      fontWeight: 600,
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              </div>
            </div>
          </fieldset>

          {/* Operaciones Individuales */}
          <fieldset
            style={{
              border: "1px solid #DCD5C8",
              borderRadius: 6,
              padding: "12px",
              backgroundColor: "#FFFFFF",
              margin: 0,
              boxSizing: "border-box",
              width: "100%",
            }}
          >
            <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
              {t.operations}
            </legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                onClick={handleFixName}
                disabled={!selectedGame || (selectedGame && isOplFormatted(selectedGame.file_name, selectedGame.id))}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: 8,
                  border: "1px solid #2B262C",
                  borderRadius: 4,
                  backgroundColor:
                    selectedGame && !isOplFormatted(selectedGame.file_name, selectedGame.id)
                      ? "#2B262C"
                      : "#EAE4D8",
                  color:
                    selectedGame && !isOplFormatted(selectedGame.file_name, selectedGame.id)
                      ? "#F5F1E8"
                      : "#8A848D",
                  cursor:
                    selectedGame && !isOplFormatted(selectedGame.file_name, selectedGame.id)
                      ? "pointer"
                      : "default",
                  fontWeight: 600,
                }}
              >
                {t.renameBtn}
              </button>
              <button
                onClick={handleGenerateCfg}
                disabled={!selectedGame}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: 8,
                  border: "1px solid #2B262C",
                  borderRadius: 4,
                  backgroundColor: selectedGame ? "#F5F1E8" : "#EAE4D8",
                  color: selectedGame ? "#2B262C" : "#8A848D",
                  cursor: selectedGame ? "pointer" : "default",
                  fontWeight: 600,
                }}
              >
                {t.cfgBtn}
              </button>
              <button
                onClick={handleDownloadArt}
                disabled={!selectedGame}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: 8,
                  border: "1px solid #2B262C",
                  borderRadius: 4,
                  backgroundColor: selectedGame ? "#F5F1E8" : "#EAE4D8",
                  color: selectedGame ? "#2B262C" : "#8A848D",
                  cursor: selectedGame ? "pointer" : "default",
                  fontWeight: 600,
                }}
              >
                {t.downloadArtBtn}
              </button>
            </div>
          </fieldset>

          {/* Estadísticas Globales */}
          <fieldset
            style={{
              border: "1px solid #DCD5C8",
              borderRadius: 6,
              padding: "12px",
              backgroundColor: "#FFFFFF",
              margin: 0,
              marginTop: "auto",
              boxSizing: "border-box",
              width: "100%",
            }}
          >
            <legend style={{ fontSize: 12, fontWeight: 700, color: "#2B262C", padding: "0 6px" }}>
              {t.globalStats}
            </legend>
            <table style={{ width: "100%", fontSize: 13, textAlign: "right" }}>
              <thead>
                <tr style={{ color: "#766F78" }}>
                  <th style={{ textAlign: "left", fontWeight: 600 }}>{t.type}</th>
                  <th style={{ fontWeight: 600 }}>Count</th>
                  <th style={{ fontWeight: 600 }}>{t.size}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ textAlign: "left" }}>PS2 (DVD)</td>
                  <td>{stats.dvdCount}</td>
                  <td>{stats.dvdSize} GB</td>
                </tr>
                <tr>
                  <td style={{ textAlign: "left" }}>PS2 (CD)</td>
                  <td>{stats.cdCount}</td>
                  <td>{stats.cdSize} GB</td>
                </tr>
                <tr
                  style={{
                    fontWeight: 700,
                    borderTop: "1px solid #DCD5C8",
                    color: "#2B262C",
                  }}
                >
                  <td style={{ textAlign: "left", paddingTop: 6 }}>{t.total}</td>
                  <td style={{ paddingTop: 6 }}>{stats.totalCount}</td>
                  <td style={{ paddingTop: 6 }}>{stats.totalSize} GB</td>
                </tr>
              </tbody>
            </table>
          </fieldset>
        </div>
      </main>

      {/* Barra de Estado Inferior */}
      <footer
        style={{
          backgroundColor: "#EAE4D8",
          borderTop: "1px solid #DCD5C8",
          padding: "4px 16px",
          fontSize: 11,
          color: "#2B262C",
          display: "flex",
          justifyContent: "space-between",
          flexShrink: 0,
          fontWeight: 500,
        }}
      >
        <span>{oplPath ? `${t.activePath} ${oplPath}` : t.waitingDir}</span>
        <span>{t.mode}</span>
      </footer>
    </div>
  );
}