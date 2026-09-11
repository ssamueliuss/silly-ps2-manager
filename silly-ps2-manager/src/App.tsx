import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

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
  const [statusMsg, setStatusMsg] = useState("");

  const refreshGames = async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<Ps2Game[]>("scan_opl_folder", { oplPath: path });
      setGames(result);
    } catch (err) {
      console.error(err);
      setStatusMsg("Error al escanear directorio.");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Selecciona el USB o carpeta raíz de OPL",
    });

    if (typeof selected === "string") {
      setOplPath(selected);
      refreshGames(selected);
    }
  };

  // Descarga carátula
  const handleDownloadArt = async (gameId: string) => {
    if (!oplPath) return;
    setStatusMsg(`Descargando carátula para ${gameId}...`);
    try {
      const msg = await invoke<string>("download_art", { oplPath, gameId });
      setStatusMsg(msg);
    } catch (err) {
      setStatusMsg(String(err));
    }
  };

  // Renombrado al estándar OPL (ID.Titulo.iso)
  const handleFixName = async (game: Ps2Game) => {
    if (!oplPath || game.id === "DESCONOCIDO") return;
    setStatusMsg(`Renombrando ${game.file_name}...`);
    try {
      await invoke("fix_iso_filename", {
        gamePath: game.path,
        gameId: game.id,
        cleanTitle: game.title,
      });
      setStatusMsg(`Juego renombrado a estándar OPL.`);
      refreshGames(oplPath);
    } catch (err) {
      setStatusMsg(String(err));
    }
  };

  // Generación de archivo .cfg
  const handleGenerateCfg = async (game: Ps2Game) => {
    if (!oplPath || game.id === "DESCONOCIDO") return;
    setStatusMsg(`Generando CFG para ${game.id}...`);
    try {
      const msg = await invoke<string>("save_game_cfg", {
        oplPath,
        gameId: game.id,
        title: game.title,
        dmaMode: "MDMA_0",
        compatibilityModes: [],
      });
      setStatusMsg(msg);
    } catch (err) {
      setStatusMsg(String(err));
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2>Silly PS2 OPL Manager</h2>
        <button onClick={handleSelectFolder} style={{ padding: "8px 16px", cursor: "pointer" }}>
          {oplPath ? "Cambiar Directorio" : "Seleccionar Unidad OPL"}
        </button>
      </header>

      {oplPath && <p style={{ color: "#666", fontSize: 13 }}>Ruta activa: {oplPath}</p>}
      {statusMsg && <p style={{ color: "#553c9a", fontWeight: "bold" }}>{statusMsg}</p>}

      <main style={{ marginTop: 20 }}>
        {loading ? (
          <p>Cargando lista...</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #ddd" }}>
                <th style={{ padding: 8 }}>Serial</th>
                <th style={{ padding: 8 }}>Archivo</th>
                <th style={{ padding: 8 }}>Tamaño</th>
                <th style={{ padding: 8 }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.path} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>{g.id}</td>
                  <td style={{ padding: 8 }}>{g.file_name}</td>
                  <td style={{ padding: 8 }}>{g.size_gb} GB</td>
                  <td style={{ padding: 8, display: "flex", gap: 8 }}>
                    <button onClick={() => handleDownloadArt(g.id)} title="Descargar Cover a /ART/">
                      Arte
                    </button>
                    <button onClick={() => handleFixName(g)} title="Corregir a ID.Nombre.iso">
                      Formato OPL
                    </button>
                    <button onClick={() => handleGenerateCfg(g)} title="Crear .cfg base">
                      Crear CFG
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}