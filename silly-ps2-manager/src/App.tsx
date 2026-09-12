import { useState, useMemo } from "react";
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
}

export default function App() {
  const [oplPath, setOplPath] = useState<string | null>(null);
  const [games, setGames] = useState<Ps2Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Ps2Game | null>(null);

  const isOplFormatted = (fileName: string, id: string) => {
    return fileName.toLowerCase().startsWith(`${id.toLowerCase()}.`);
  };

  const refreshGames = async (path: string) => {
    setLoading(true);
    setSelectedGame(null);
    try {
      const result = await invoke<Ps2Game[]>("scan_opl_folder", { oplPath: path });
      setGames(result);
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
      toast.info("Directorio cargado", { description: selected });
      refreshGames(selected);
    }
  };

  const handleDownloadArt = async () => {
    if (!oplPath || !selectedGame) return;
    const toastId = toast.loading(`Descargando arte para ${selectedGame.id}...`);
    try {
      const msg = await invoke<string>("download_art", { oplPath, gameId: selectedGame.id });
      toast.success(msg, { id: toastId });
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
    const dvdGames = games.filter(g => g.media_type === "DVD");
    const cdGames = games.filter(g => g.media_type === "CD");
    const totalSize = games.reduce((acc, g) => acc + g.size_gb, 0);
    return {
      dvdCount: dvdGames.length,
      dvdSize: dvdGames.reduce((acc, g) => acc + g.size_gb, 0).toFixed(2),
      cdCount: cdGames.length,
      cdSize: cdGames.reduce((acc, g) => acc + g.size_gb, 0).toFixed(2),
      totalCount: games.length,
      totalSize: totalSize.toFixed(2)
    };
  }, [games]);

  return (
    // Se añade overflow: hidden al root para evitar scroll general
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", fontFamily: "system-ui, sans-serif", backgroundColor: "#f8fafc", color: "#1e293b" }}>
      <Toaster richColors position="bottom-right" />

      <header style={{ backgroundColor: "#ffffff", borderBottom: "1px solid #e2e8f0", padding: "8px 16px", display: "flex", gap: 16, fontSize: 13, fontWeight: 500, flexShrink: 0 }}>
        <div style={{ cursor: "pointer", color: "#6b21a8" }} onClick={handleSelectFolder}>Open OPL folder</div>
        <div style={{ cursor: "pointer", color: "#475569" }}>Batch Actions</div>
        <div style={{ cursor: "pointer", color: "#475569" }}>Settings</div>
      </header>

      {/* El minHeight: 0 es crucial para que flex: 1 no se expanda más allá de la pantalla */}
      <main style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        
        {/* Columna Izquierda */}
        <div style={{ flex: "0 0 65%", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", backgroundColor: "#ffffff", minHeight: 0 }}>
          {/* Contenedor escrolleable de la tabla */}
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13, userSelect: "none" }}>
              <thead style={{ position: "sticky", top: 0, backgroundColor: "#f1f5f9", zIndex: 1, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
                <tr>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #e2e8f0", color: "#4c1d95", fontWeight: 600 }}>Title</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #e2e8f0", color: "#4c1d95", fontWeight: 600 }}>ID</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #e2e8f0", color: "#4c1d95", fontWeight: 600 }}>Type</th>
                  <th style={{ padding: "6px 12px", borderRight: "1px solid #e2e8f0", color: "#4c1d95", fontWeight: 600 }}>Size</th>
                  <th style={{ padding: "6px 12px", color: "#4c1d95", fontWeight: 600 }}>Format</th>
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
                        borderBottom: "1px solid #edf2f7", 
                        backgroundColor: isSelected ? "#f3e8ff" : "transparent",
                        cursor: "pointer",
                      }}
                    >
                      <td style={{ padding: "4px 12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>
                        {g.title}
                      </td>
                      <td style={{ padding: "4px 12px" }}>{g.id}</td>
                      <td style={{ padding: "4px 12px" }}>PS2</td>
                      <td style={{ padding: "4px 12px" }}>{g.size_gb} GB</td>
                      <td style={{ padding: "4px 12px", color: formatted ? "#16a34a" : "#dc2626" }}>
                        {g.media_type} {formatted && "✓"}
                      </td>
                    </tr>
                  );
                })}
                {loading && <tr><td colSpan={5} style={{ padding: 12, textAlign: "center" }}>Escaneando...</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* Columna Derecha */}
        <div style={{ flex: "0 0 35%", padding: "16px", overflowY: "auto", backgroundColor: "#f8fafc", display: "flex", flexDirection: "column", gap: 16 }}>
          
          <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 6, padding: "12px", backgroundColor: "#ffffff" }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "#6b21a8", padding: "0 4px" }}>Game Details</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ width: 40, fontWeight: 500 }}>Title:</span>
                <input readOnly value={selectedGame?.title || ""} style={{ flex: 1, padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: 4, backgroundColor: "#f8fafc" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ width: 40, fontWeight: 500 }}>Path:</span>
                <input readOnly value={selectedGame?.path || ""} style={{ flex: 1, padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: 4, backgroundColor: "#f8fafc" }} />
              </div>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ width: 40, fontWeight: 500 }}>ID:</span>
                <input readOnly value={selectedGame?.id || ""} style={{ width: 120, padding: "4px 8px", border: "1px solid #e2e8f0", borderRadius: 4, backgroundColor: "#f8fafc", fontFamily: "monospace" }} />
              </div>
            </div>
          </fieldset>

          <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 6, padding: "12px", backgroundColor: "#ffffff" }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "#6b21a8", padding: "0 4px" }}>Operations</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button 
                onClick={handleFixName} 
                disabled={!selectedGame || (selectedGame && isOplFormatted(selectedGame.file_name, selectedGame.id))}
                style={{ padding: 8, border: "1px solid #d8b4fe", borderRadius: 4, backgroundColor: "#f3e8ff", color: "#6b21a8", cursor: selectedGame ? "pointer" : "default", opacity: selectedGame ? 1 : 0.5, fontWeight: 500 }}
              >
                Rename (Format OPL)
              </button>
              <button 
                onClick={handleGenerateCfg} 
                disabled={!selectedGame}
                style={{ padding: 8, border: "1px solid #d8b4fe", borderRadius: 4, backgroundColor: "#f3e8ff", color: "#6b21a8", cursor: selectedGame ? "pointer" : "default", opacity: selectedGame ? 1 : 0.5, fontWeight: 500 }}
              >
                Edit / Create CFG
              </button>
              <button 
                onClick={handleDownloadArt} 
                disabled={!selectedGame}
                style={{ padding: 8, border: "1px solid #d8b4fe", borderRadius: 4, backgroundColor: "#f3e8ff", color: "#6b21a8", cursor: selectedGame ? "pointer" : "default", opacity: selectedGame ? 1 : 0.5, fontWeight: 500 }}
              >
                Manage ARTs (Download)
              </button>
            </div>
          </fieldset>

          <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 6, padding: "12px", backgroundColor: "#ffffff", marginTop: "auto" }}>
            <legend style={{ fontSize: 12, fontWeight: 600, color: "#6b21a8", padding: "0 4px" }}>Global Stats</legend>
            <table style={{ width: "100%", fontSize: 13, textAlign: "right" }}>
              <thead>
                <tr style={{ color: "#64748b" }}>
                  <th style={{ textAlign: "left", fontWeight: 500 }}>Type</th>
                  <th style={{ fontWeight: 500 }}>Count</th>
                  <th style={{ fontWeight: 500 }}>Size</th>
                </tr>
              </thead>
              <tbody>
                <tr><td style={{ textAlign: "left" }}>PS2 (DVD)</td><td>{stats.dvdCount}</td><td>{stats.dvdSize} GB</td></tr>
                <tr><td style={{ textAlign: "left" }}>PS2 (CD)</td><td>{stats.cdCount}</td><td>{stats.cdSize} GB</td></tr>
                <tr style={{ fontWeight: 600, borderTop: "1px solid #e2e8f0" }}>
                  <td style={{ textAlign: "left", paddingTop: 4 }}>Total</td>
                  <td style={{ paddingTop: 4 }}>{stats.totalCount}</td>
                  <td style={{ paddingTop: 4 }}>{stats.totalSize} GB</td>
                </tr>
              </tbody>
            </table>
          </fieldset>
          
        </div>
      </main>
      
      <footer style={{ backgroundColor: "#f1f5f9", borderTop: "1px solid #e2e8f0", padding: "4px 16px", fontSize: 11, color: "#64748b", display: "flex", justifyContent: "space-between", flexShrink: 0 }}>
        <span>{oplPath ? `Ruta activa: ${oplPath}` : "Esperando directorio..."}</span>
        <span>Modo: Local / USB</span>
      </footer>
    </div>
  );
}