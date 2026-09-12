import { useState, useMemo, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
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

export default function App() {
  const [oplPath, setOplPath] = useState<string | null>(null);
  const [games, setGames] = useState<Ps2Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Ps2Game | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  const isOplFormatted = (fileName: string, id: string) => {
    return fileName.toLowerCase().startsWith(`${id.toLowerCase()}.`);
  };

  const refreshGames = async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<Ps2Game[]>("scan_opl_folder", { oplPath: path });
      setGames(result);
      // Mantener seleccionado el juego actual si aún existe
      if (selectedGame) {
        const stillExists = result.find((g) => g.id === selectedGame.id);
        if (stillExists) setSelectedGame(stillExists);
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
      toast.info("Directorio cargado", { description: selected });
      refreshGames(selected);
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

  const handleDownloadArt = async () => {
    if (!oplPath || !selectedGame) return;
    const toastId = toast.loading(`Descargando arte para ${selectedGame.id}...`);
    try {
      const msg = await invoke<string>("download_art", { oplPath, gameId: selectedGame.id });
      toast.success(msg, { id: toastId });
      loadCover(selectedGame.id);
      refreshGames(oplPath); // Actualiza la columna Cover en la tabla
    } catch (err) {
      toast.error("Error", { id: toastId, description: String(err) });
    }
  };

  const handleFixName = async () => {
    if (!oplPath || !selectedGame || selectedGame.id === "DESCONOCIDO") return;
    try {
      await invoke("fix_iso_filename", { gamePath: selectedGame.path, gameId: selectedGame.id });
      toast.success("Archivo renombrado a estándar OPL");
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
      toast.success(msg);
    } catch (err) {
      toast.error("Error al generar CFG", { description: String(err) });
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
      }}
    >
      <Toaster richColors position="bottom-right" />

      {/* Menú superior */}
      <header
        style={{
          backgroundColor: "#FFFFFF",
          borderBottom: "1px solid #EAE4D8",
          padding: "8px 16px",
          display: "flex",
          gap: 16,
          fontSize: 13,
          fontWeight: 500,
          flexShrink: 0,
        }}
      >
        <div
          style={{ cursor: "pointer", color: "#2B262C", fontWeight: 700 }}
          onClick={handleSelectFolder}
        >
          Open OPL folder
        </div>
        <div style={{ cursor: "pointer", color: "#766F78" }}>Batch Actions</div>
        <div style={{ cursor: "pointer", color: "#766F78" }}>Settings</div>
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
                textAlign: "left",
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
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>Title</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>ID</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>Type</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>Size</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #DCD5C8", color: "#2B262C", fontWeight: 700 }}>Format</th>
                  <th style={{ padding: "6px 12px", color: "#2B262C", fontWeight: 700 }}>Cover</th>
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
                      Escaneando...
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
          {/* Detalles del Juego con Previsualización */}
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
              Game Details
            </legend>
            
            <div style={{ display: "flex", gap: 16 }}>
              {/* Visor de Carátula */}
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

              {/* Text Inputs */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, flex: 1, justifyContent: "center" }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>Title:</span>
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
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>Path:</span>
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
                  <span style={{ width: 44, fontWeight: 600, color: "#2B262C" }}>ID:</span>
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

          {/* Operaciones */}
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
              Operations
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
                Rename (Format OPL)
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
                Edit / Create CFG
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
                Manage ARTs (Download)
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
              Global Stats
            </legend>
            <table style={{ width: "100%", fontSize: 13, textAlign: "right" }}>
              <thead>
                <tr style={{ color: "#766F78" }}>
                  <th style={{ textAlign: "left", fontWeight: 600 }}>Type</th>
                  <th style={{ fontWeight: 600 }}>Count</th>
                  <th style={{ fontWeight: 600 }}>Size</th>
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
                  <td style={{ textAlign: "left", paddingTop: 6 }}>Total</td>
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
        <span>{oplPath ? `Ruta activa: ${oplPath}` : "Esperando directorio..."}</span>
        <span>Modo: Local / USB</span>
      </footer>
    </div>
  );
}