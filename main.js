// ═══════════════════════════════════════════════════════════════
//  VWB Sunday Edition — Electron Main Process
//  © 2025 Hollins Musical Productions International
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Data folder: ~/Library/Application Support/vwb-sunday-edition/vwb-data/
const DATA_DIR  = path.join(app.getPath('userData'), 'vwb-data');
const STEMS_DIR = path.join(DATA_DIR, 'stems');

function ensureDirs() {
  [DATA_DIR, STEMS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// ── Create the app window ──────────────────────────────────────
function createWindow() {
  ensureDirs();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'VWB Sunday Edition',
    backgroundColor: '#0a0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  // Open external links in the system browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { app.quit(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS  (called from the app via window.vwb.*)
// ═══════════════════════════════════════════════════════════════

// ── Pick an audio file and copy it into the persistent stems folder ──
ipcMain.handle('vwb:pickFile', async (_evt, opts = {}) => {
  const result = await dialog.showOpenDialog({
    title: opts.title || 'Select File',
    filters: [
      { name: 'Audio & MIDI Files', extensions: ['mp3','wav','ogg','flac','aac','m4a','mid','midi'] },
      { name: 'Audio Files', extensions: ['mp3','wav','ogg','flac','aac','m4a'] },
      { name: 'MIDI Files', extensions: ['mid','midi'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: result.filePaths };
});

// ── Read any file and return its bytes as an ArrayBuffer ──
ipcMain.handle('vwb:readFileBuffer', async (_evt, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { success: true, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Copy a file into the app's persistent stems folder ──
ipcMain.handle('vwb:copyToStems', async (_evt, srcPath) => {
  try {
    ensureDirs();
    const dest = path.join(STEMS_DIR, path.basename(srcPath));
    fs.copyFileSync(srcPath, dest);
    return { success: true, storedPath: dest };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Generic JSON file read/write (setlist, settings, service cues, MIDI mappings) ──
function jsonPath(name) { return path.join(DATA_DIR, name + '.json'); }

ipcMain.handle('vwb:saveJson', async (_evt, name, data) => {
  try {
    fs.writeFileSync(jsonPath(name), JSON.stringify(data, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:loadJson', async (_evt, name) => {
  try {
    const raw = fs.readFileSync(jsonPath(name), 'utf8');
    return { success: true, data: JSON.parse(raw) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Named shortcuts used by the app ──
ipcMain.handle('vwb:saveSetlist',  async (_evt, d) => { try { fs.writeFileSync(jsonPath('setlist'),  JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadSetlist',  async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('setlist'),  'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveSettings', async (_evt, d) => { try { fs.writeFileSync(jsonPath('settings'), JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadSettings', async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('settings'), 'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveService',  async (_evt, d) => { try { fs.writeFileSync(jsonPath('service'),  JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadService',  async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('service'),  'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveMrcMap',   async (_evt, d) => { try { fs.writeFileSync(jsonPath('mrcmap'),   JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadMrcMap',   async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('mrcmap'),   'utf8')) }; } catch(e) { return { success:false }; } });
