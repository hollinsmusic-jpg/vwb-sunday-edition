// ═══════════════════════════════════════════════════════════════
//  Virtual Worship Band — Electron Main Process
//  © 2025 Hollins Musical Productions International
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const os   = require('os');
const net  = require('net');

// House Band content delivery — phrase packs, rubato packs, organ packs, service packs
const hbIpc = require('./js/hb-ipc-handlers');

// ── Build native Mac menu bar ──────────────────────────────────
function buildMenu(win) {
  const template = [
    {
      label: 'VWB',
      submenu: [
        { label: 'About VWB', role: 'about' },
        { type: 'separator' },
        { label: 'Hide VWB', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit VWB', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'Cmd+N',
          click: () => win.webContents.executeJavaScript('sessionNew()')
        },
        { type: 'separator' },
        {
          label: 'Open Session…',
          accelerator: 'Cmd+O',
          click: () => win.webContents.executeJavaScript('sessionOpen()')
        },
        {
          label: 'Save Session',
          accelerator: 'Cmd+S',
          click: () => win.webContents.executeJavaScript('sessionSave()')
        },
        {
          label: 'Save As…',
          accelerator: 'Cmd+Shift+S',
          click: () => win.webContents.executeJavaScript('sessionSaveAs()')
        },
        { type: 'separator' },
        {
          label: 'Quit VWB',
          accelerator: 'Cmd+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' },
        { label: 'Redo', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', role: 'minimize' },
        { label: 'Zoom', role: 'zoom' },
        { label: 'Close', role: 'close' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── Data folder: ~/Library/Application Support/vwb/vwb-data/
const DATA_DIR   = path.join(app.getPath('userData'), 'vwb-data');
const STEMS_DIR  = path.join(DATA_DIR, 'stems');
const RUBATO_DIR = path.join(DATA_DIR, 'rubato-packs');
const ORGAN_DIR  = path.join(DATA_DIR, 'organ-packs');

function ensureDirs() {
  [DATA_DIR, STEMS_DIR, RUBATO_DIR, ORGAN_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

// ── Local VWB file server (port 7880) ─────────────────────────
// Serves VWB on http://localhost so Web Speech API works.
// Google's speech servers require an http/https origin — file:// is rejected.
let vwbServer = null;
const vwbPort = 7880;

function startVwbServer() {
  return new Promise(resolve => {
    if (vwbServer && vwbServer.listening) { resolve(); return; }

    vwbServer = http.createServer((req, res) => {
      let urlPath = req.url.split('?')[0];
      try { urlPath = decodeURIComponent(urlPath); } catch(e) {}
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

      // Resolve to filesystem path — serves everything including node_modules
      const filePath = path.join(__dirname, urlPath);
      const ext = path.extname(filePath).toLowerCase();

      const mimeTypes = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg', '.mid': 'audio/midi', '.woff2': 'font/woff2',
        '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
        '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
      };

      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const data = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          });
          res.end(data);
        } else {
          res.writeHead(404); res.end('Not found: ' + urlPath);
        }
      } catch(e) {
        res.writeHead(404); res.end('Not found: ' + urlPath);
      }
    });

    vwbServer.listen(vwbPort, '127.0.0.1', () => {
      console.log('[VWB] App server ready → http://localhost:' + vwbPort);
      resolve();
    });

    vwbServer.on('error', (e) => {
      console.error('[VWB] Server failed:', e.message, '— falling back to file://');
      vwbServer = null;
      resolve();
    });
  });
}

// ── Create the app window ──────────────────────────────────────
function createWindow() {
  ensureDirs();

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'VWB – Virtual Worship Band',
    backgroundColor: '#0a0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowRunningInsecureContent: true,
      webSecurity: false,
    },
  });

  // ── Electron 29 permission handling ───────────────────────────
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'midiSysex', 'midi'];
    callback(allowed.includes(permission));
  });
  ses.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'midiSysex', 'midi'];
    return allowed.includes(permission);
  });

  // Load via local HTTP server — required for Web Speech API to work
  // http://localhost is accepted by Google's speech servers; file:// is not
  if (vwbServer && vwbServer.listening) {
    console.log('[VWB] Loading via http://localhost:' + vwbPort);
    win.loadURL('http://localhost:' + vwbPort + '/index.html');
  } else {
    console.warn('[VWB] Server not ready — falling back to file://');
    win.loadFile('index.html');
  }

  win.webContents.openDevTools();
  buildMenu(win);
  startRemoteServer(win);

  // ── Save before close prompt ──────────────────────────────────
  let forceQuit = false;
  win.on('close', async (e) => {
    if (forceQuit) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Save Before Closing?',
      message: 'Would you like to save your session before closing VWB?',
      detail: "Your stems, sections, setlist, and service order will all be saved and ready when you return."
    });
    if (response === 0) {
      await win.webContents.executeJavaScript('sessionSave()').catch(() => {});
      setTimeout(() => { forceQuit = true; win.close(); }, 800);
    } else if (response === 1) {
      forceQuit = true;
      win.close();
    }
    // response === 2 = Cancel, window stays open
  });

  // Open external links in the system browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}


// ═══════════════════════════════════════════════════════════════
//  VWB REMOTE — Local WebSocket server for phone companion app
// ═══════════════════════════════════════════════════════════════

let remoteServer = null;
let remoteClients = new Set();
let remotePort = 7878;
let remoteState = {};  // last known state from renderer

// ── Get local IP address ──
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Simple WebSocket frame parser/builder (no external deps) ──
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = require('crypto')
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const fin  = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (masked ? 4 : 0) + len) return null;
  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + len);
  }
  return { opcode, payload: payload.toString('utf8') };
}

function wsBuildFrame(msg) {
  const data = Buffer.from(msg, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsBroadcast(msg) {
  const frame = wsBuildFrame(JSON.stringify(msg));
  remoteClients.forEach(sock => {
    try { sock.write(frame); } catch(e) {}
  });
}

function wsSend(sock, msg) {
  try { sock.write(wsBuildFrame(JSON.stringify(msg))); } catch(e) {}
}

// ── Start the remote server ──
function startRemoteServer(win) {
  if (remoteServer) return;

  const remoteHtmlPath = path.join(__dirname, 'remote.html');

  remoteServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      try {
        const html = fs.readFileSync(remoteHtmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch(e) {
        res.writeHead(500); res.end('Remote UI not found');
      }
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });

  // Handle WebSocket upgrade
  remoteServer.on('upgrade', (req, socket) => {
    if (req.headers.upgrade !== 'websocket') { socket.destroy(); return; }
    wsHandshake(req, socket);
    remoteClients.add(socket);

    // Send current state immediately
    if (Object.keys(remoteState).length > 0) {
      wsSend(socket, { type: 'state', data: remoteState });
    }

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = wsParseFrame(buffer);
      if (!frame) return;
      buffer = Buffer.alloc(0);
      if (frame.opcode === 8) { remoteClients.delete(socket); socket.destroy(); return; }
      if (frame.opcode === 9) { socket.write(wsBuildFrame('')); return; } // pong
      try {
        const msg = JSON.parse(frame.payload);
        handleRemoteMessage(msg, win, socket);
      } catch(e) {}
    });

    socket.on('close', () => remoteClients.delete(socket));
    socket.on('error', () => remoteClients.delete(socket));
  });

  remoteServer.listen(remotePort, '0.0.0.0', () => {
    console.log(`VWB Remote server running on port ${remotePort}`);
  });
}

// ── Handle messages from phone ──
function handleRemoteMessage(msg, win, socket) {
  if (msg.type === 'ping') return;
  if (msg.type === 'getState') {
    wsSend(socket, { type: 'state', data: remoteState });
    return;
  }
  if (msg.type === 'action') {
    // Forward action to renderer
    win.webContents.executeJavaScript(`remoteAction(${JSON.stringify(msg)})`).catch(() => {});
  }
}

// ── IPC: renderer sends state updates ──
ipcMain.on('remote:stateUpdate', (_evt, state) => {
  remoteState = state;
  wsBroadcast({ type: 'state', data: state });
});

ipcMain.on('remote:toast', (_evt, text) => {
  wsBroadcast({ type: 'toast', text });
});

// ── IPC: open URL in system browser (used by News Panel) ──
ipcMain.handle('vwb:openExternal', (_evt, url) => {
  shell.openExternal(url);
});

// ── IPC: get server info ──
ipcMain.handle('remote:getInfo', () => {
  return {
    ip: getLocalIP(),
    port: remotePort,
    url: `http://${getLocalIP()}:${remotePort}`
  };
});

// ── IPC: start/stop server ──
ipcMain.handle('remote:start', (_evt) => {
  // server starts with app — just return info
  return { ip: getLocalIP(), port: remotePort, url: `http://${getLocalIP()}:${remotePort}` };
});


// ── Electron 29 — Enable WebMIDI + Web Speech API ─────────────
// Register http://localhost:7880 as secure so Web Speech API works
app.commandLine.appendSwitch('enable-blink-features', 'WebMIDI,WebMIDIGetStatusRequest');
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://localhost:7880');

app.whenReady().then(async () => {
  await startVwbServer();
  createWindow();
  // Register House Band content delivery IPC handlers
  hbIpc.register(ipcMain, app);
});

app.on('window-all-closed', () => { app.quit(); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { startVwbServer().then(() => createWindow()); }
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS  (called from the app via window.vwb.*)
// ═══════════════════════════════════════════════════════════════

// ── Pick any file type — no extension filter (Rubato Mode lyrics) ──
ipcMain.handle('vwb:pickAnyFile', async (_evt, opts = {}) => {
  const result = await dialog.showOpenDialog({
    title: opts.title || 'Select File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, filePaths: [] };
  return { canceled: false, filePaths: result.filePaths };
});

// ── Pick a folder and return all MIDI files inside it (Rubato Mode chunks) ──
ipcMain.handle('vwb:pickMidiFolder', async (_evt) => {
  const result = await dialog.showOpenDialog({
    title: 'Select Folder Containing MIDI Chunks',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, files: [] };
  const folderPath = result.filePaths[0];
  try {
    const entries = fs.readdirSync(folderPath);
    const midiFiles = entries
      .filter(f => f.toLowerCase().endsWith('.mid') || f.toLowerCase().endsWith('.midi'))
      .map(f => ({ name: f, path: path.join(folderPath, f) }));
    return { canceled: false, folder: folderPath, files: midiFiles };
  } catch(e) {
    return { canceled: true, files: [], error: e.message };
  }
});

// ── Pick one or more audio files ──
ipcMain.handle('vwb:pickAudioFiles', async (_evt, multi = false) => {
  const result = await dialog.showOpenDialog({
    title: 'Select Audio File(s)',
    filters: [
      { name: 'Audio Files', extensions: ['mp3','wav','ogg','flac','aac','m4a'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true, files: [] };
  return {
    canceled: false,
    files: result.filePaths.map(p => ({ path: p, name: path.basename(p) }))
  };
});

// ── Pick a single loop/pad file ──
ipcMain.handle('vwb:pickLoopFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select Background Loop',
    filters: [
      { name: 'Audio Files', extensions: ['mp3','wav','ogg','flac','aac','m4a'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
});

// ── Pick a single MIDI file ──
ipcMain.handle('vwb:pickMidiFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select MIDI File',
    filters: [
      { name: 'MIDI Files', extensions: ['mid','midi'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
});

// ── Pick a Flex File — MIDI, VWB Song Chart, or VWB Arrangement ──
// (.mid / .vwbs / .vwba)
ipcMain.handle('vwb:pickFlexFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Add Flex File, Song Chart, or Arrangement',
    buttonLabel: 'Open',
    filters: [
      { name: 'VWB Files',        extensions: ['mid','midi','vwbs','vwba'] },
      { name: 'MIDI Files',       extensions: ['mid','midi'] },
      { name: 'Song Charts',      extensions: ['vwbs'] },
      { name: 'VWB Arrangements', extensions: ['vwba'] },
      { name: 'All Files',        extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const fileName = path.basename(filePath);
  const ext      = path.extname(filePath).toLowerCase().replace('.', '');
  // For .vwbs and .vwba, read the text immediately (both are JSON) so
  // the renderer doesn't need a second IPC round trip.
  if (ext === 'vwbs' || ext === 'vwba') {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return { canceled: false, filePath, fileName, ext, text };
    } catch(e) {
      return { canceled: false, filePath, fileName, ext, error: e.message };
    }
  }
  return { canceled: false, filePath, fileName, ext };
});

// ── Store a stem file permanently in app data ──
ipcMain.handle('vwb:storeStem', async (_evt, opts = {}) => {
  try {
    ensureDirs();
    const { songTitle = 'untitled', stemKey = 'stem', sourcePath, fileName } = opts;
    // Create a song-specific subfolder to isolate stems by song
    const safeSongTitle = songTitle.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || 'untitled';
    const songDir = path.join(STEMS_DIR, safeSongTitle);
    if (!fs.existsSync(songDir)) fs.mkdirSync(songDir, { recursive: true });
    // Use stemKey + original extension for the stored filename
    const ext = path.extname(fileName || sourcePath);
    const destName = stemKey + ext;
    const destPath = path.join(songDir, destName);
    fs.copyFileSync(sourcePath, destPath);
    return { success: true, storedPath: destPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Check if a stem file exists ──
ipcMain.handle('vwb:stemExists', async (_evt, filePath) => {
  try { return fs.existsSync(filePath); } catch(e) { return false; }
});

// ── Pick a legacy single file (kept for compatibility) ──
ipcMain.handle('vwb:pickFile', async (_evt, opts = {}) => {
  const result = await dialog.showOpenDialog({
    title: opts.title || 'Select File',
    filters: [
      { name: 'Audio & MIDI Files', extensions: ['mp3','wav','ogg','flac','aac','m4a','mid','midi'] },
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

// ── Piano Talk Music file server ───────────────────────────────
//  Serves piano talk MP3 files from the piano-talk/ folder
//  inside the app root directory by pianist ID and key name.
//  File naming: "{Key} major piano talk music.mp3"
//  Folder: piano-talk/{pianistId}/
//
//  To add a new pianist: create piano-talk/{their-id}/ and
//  add 12 MP3 files following the same naming convention.
ipcMain.handle('vwb:pianoTalkFile', async (_evt, opts = {}) => {
  try {
    const { pianistId = 'kenneth-hollins', key = 'C', fileName } = opts;
    // fileName is passed directly from PT_REGISTRY files mapping
    const pianoTalkDir = path.join(__dirname, 'piano-talk', pianistId);
    const filePath     = path.join(pianoTalkDir, fileName);
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }
    const buf = fs.readFileSync(filePath);
    return {
      success:  true,
      buffer:   buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      mimeType: 'audio/mpeg'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Copy a file into the app's persistent stems folder (legacy) ──
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

// ── Generic JSON file read/write ──
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

// ── Rubato song packs (.vwb files) — save/list/read by id ────────
ipcMain.handle('vwb:saveRubatoPack', async (_evt, data = {}) => {
  try {
    ensureDirs();
    const id = data.id || ('rubato-' + Date.now());
    fs.writeFileSync(path.join(RUBATO_DIR, id + '.json'), JSON.stringify({ ...data, id }, null, 2), 'utf8');
    return { success: true, id };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:listRubatoPacks', async () => {
  try {
    ensureDirs();
    const files = fs.readdirSync(RUBATO_DIR).filter(f => f.endsWith('.json'));
    const packs = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RUBATO_DIR, f), 'utf8')); }
      catch (e) { return null; }
    }).filter(Boolean);
    return { success: true, packs };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:readRubatoPack', async (_evt, packId) => {
  try {
    const raw = fs.readFileSync(path.join(RUBATO_DIR, packId + '.json'), 'utf8');
    return { success: true, data: JSON.parse(raw) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Organ sample packs — save by id ───────────────────────────────
ipcMain.handle('vwb:saveOrganPack', async (_evt, data = {}) => {
  try {
    ensureDirs();
    const id = data.id || ('organ-' + Date.now());
    fs.writeFileSync(path.join(ORGAN_DIR, id + '.json'), JSON.stringify({ ...data, id }, null, 2), 'utf8');
    return { success: true, id };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:saveOrganSamples', async (_evt, data = {}) => {
  try {
    ensureDirs();
    const id = data.id || ('organ-samples-' + Date.now());
    fs.writeFileSync(path.join(ORGAN_DIR, id + '.json'), JSON.stringify({ ...data, id }, null, 2), 'utf8');
    return { success: true, id };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Open a .vwbs session file ──
ipcMain.handle('vwb:openSessionFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open VWB Session',
    filters: [{ name: 'VWB Session', extensions: ['vwbs'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf8');
    return { canceled: false, path: result.filePaths[0], content };
  } catch(e) {
    return { canceled: false, error: e.message };
  }
});


// ── Read a session file directly by path (for Open Recent) ──
ipcMain.handle('vwb:readSessionFile', async (_evt, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { success: true, content };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── Save a .vwbs session file to a specific path ──
ipcMain.handle('vwb:saveSessionFile', async (_evt, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── Save As — show dialog to pick location ──
ipcMain.handle('vwb:saveSessionFileAs', async (_evt, suggestedName, content) => {
  const result = await dialog.showSaveDialog({
    title: 'Save VWB Session',
    defaultPath: (suggestedName || 'My VWB Session') + '.vwbs',
    filters: [{ name: 'VWB Session', extensions: ['vwbs'] }, { name: 'All Files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── Quit the app ──
ipcMain.handle('vwb:quitApp', () => { app.quit(); });

// ═══════════════════════════════════════════════════════════════
//  ARMOR BEARER — IPC Handlers
// ═══════════════════════════════════════════════════════════════

// Pick a folder (used for Hammond samples root)
ipcMain.handle('vwb:pickFolder', async (_evt, opts) => {
  const result = await dialog.showOpenDialog({
    title: (opts && opts.title) || 'Select Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// Scan the Hammond samples folder structure
// Kenneth's structure:
//   root/Organ Talking Music/Organ_Talk_Music_Key_C.mp3  (flat, one file per key)
//   root/Preaching Chords/Organ Preaching Level 1/Key C/file.mp3
//   root/Preaching Chords/Organ Preaching Level 2/Key C/file.mp3
//   root/Preaching Chords/Organ Preaching Level 3/Key C/file.mp3
// ── Bundled Organ Samples — auto-load from app directory ───────
//  Returns the path to the bundled organ-samples/ folder and
//  auto-scans it so the Armor Bearer system loads on startup.
//  Folder must be at: {app-root}/organ-samples/
ipcMain.handle('vwb:getOrganSamplesPath', async () => {
  try {
    const organPath = path.join(__dirname, 'organ-samples');
    if (!fs.existsSync(organPath)) {
      return { success: false, error: 'organ-samples folder not found at: ' + organPath };
    }
    return { success: true, path: organPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:scanArmorBearerFolder', async (_evt, rootPath) => {
  try {
    const AB_KEYS = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
    const samples = {};

    // ── Talking Music — flat files named *Key_C.mp3 etc ──
    const talkDir = path.join(rootPath, 'Organ Talking Music');
    if (fs.existsSync(talkDir)) {
      for (const key of AB_KEYS) {
        const files = fs.readdirSync(talkDir)
          .filter(f => {
            const upper = f.toUpperCase();
            const keyUpper = key.toUpperCase();
            return upper.includes('KEY_' + keyUpper + '.') &&
                   /\.(mp3|wav|ogg|flac|aif|aiff)$/i.test(f);
          })
          .map(f => path.join(talkDir, f));
        if (files.length > 0) {
          if (!samples[key]) samples[key] = { Level1: [], Level2: [], Level3: [], TalkingMusic: [] };
          samples[key].TalkingMusic = files;
        }
      }
    }

    // ── Preaching Chords — Level subfolders → Key subfolders ──
    const preachDir = path.join(rootPath, 'Preaching Chords');
    if (fs.existsSync(preachDir)) {
      const levelMap = {
        'Organ Preaching Level 1': 'Level1',
        'Organ Preaching Level 2': 'Level2',
        'Organ Preaching Level 3': 'Level3',
      };
      for (const [levelFolder, levelId] of Object.entries(levelMap)) {
        const levelDir = path.join(preachDir, levelFolder);
        if (!fs.existsSync(levelDir)) continue;
        for (const key of AB_KEYS) {
          const keyDir = path.join(levelDir, 'Key ' + key);
          if (!fs.existsSync(keyDir)) continue;
          const files = fs.readdirSync(keyDir)
            .filter(f => /\.(mp3|wav|ogg|flac|aif|aiff)$/i.test(f))
            .sort()
            .map(f => path.join(keyDir, f));
          if (files.length > 0) {
            if (!samples[key]) samples[key] = { Level1: [], Level2: [], Level3: [], TalkingMusic: [] };
            samples[key][levelId] = files;
          }
        }
      }
    }

    // ── Organist profile — optional photo and name ──
    // Looks for organist_photo.jpg first, then any .jpg/.png in root folder.
    // Looks for organist_name.txt first, then any .txt/.rtf in root folder.
    let organistName  = '';
    let organistPhoto = '';

    // Get all files directly in root folder (not subfolders)
    const rootFiles = fs.readdirSync(rootPath)
      .filter(f => {
        const full = path.join(rootPath, f);
        return fs.statSync(full).isFile();
      });

    // Find name file — prefer organist_name.txt, fall back to any .txt or .rtf
    const nameFile =
      rootFiles.find(f => f.toLowerCase() === 'organist_name.txt') ||
      rootFiles.find(f => /\.(txt|rtf)$/i.test(f));
    if (nameFile) {
      try {
        const raw = fs.readFileSync(path.join(rootPath, nameFile), 'utf8');
         if (raw.trimStart().startsWith('{\\\\rtf')) {
          // RTF file — the simplest reliable approach:
          // Strip ALL backslash-sequences and braces, keep only plain text words.
          // Real name text always survives; RTF keywords never have spaces inside them.
          const noCtrl = raw
            .replace(/\\[a-z]+\-?\d*[ \t]?/gi, ' ')  // remove all control words like \rtf1 \ansi etc
            .replace(/[{}\\]/g, ' ')                    // remove all braces and backslashes
            .replace(/[^\x20-\x7E]/g, ' ')              // remove non-ASCII bytes
            .replace(/\s+/g, ' ')
            .trim();
          // From the cleaned text, take only tokens that look like real name words:
          // capitalized, letters/apostrophes/hyphens only, 2-30 chars, no digits
          const words = noCtrl.split(' ').filter(w => /^[A-Z][a-zA-Z'\-]{1,29}$/.test(w));
          // The actual name words will be at the END (RTF preamble comes first).
          // Take the last 4 qualifying words — that's where "Kenneth Hollins" lives.
          organistName = words.slice(-4).join(' ').trim();
        } else {
          // Plain text file — just use it directly
          organistName = raw.replace(/[^\x20-\x7E]/g, '').trim();
        }
        // Final fallback — use filename without extension
        if (!organistName || organistName.length < 2) {
          organistName = path.basename(nameFile, path.extname(nameFile)).trim();
        }
      } catch(e) {
        organistName = path.basename(nameFile, path.extname(nameFile)).trim();
      }
    }

    // Find photo file — prefer organist_photo.*, fall back to any .jpg/.jpeg/.png/.webp
    const photoFile =
      rootFiles.find(f => /^organist_photo\.(jpg|jpeg|png|webp)$/i.test(f)) ||
      rootFiles.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (photoFile) {
      try {
        const imgBuf = fs.readFileSync(path.join(rootPath, photoFile));
        const ext    = path.extname(photoFile).toLowerCase().replace('.', '');
        const mime   = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        organistPhoto = 'data:' + mime + ';base64,' + imgBuf.toString('base64');
      } catch(e) {}
    }

    return { success: true, samples, organistName, organistPhoto };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════════
//  SERVICE PACK — IPC Handlers
// ═══════════════════════════════════════════════════════════════

const SP_CATEGORIES = [
  '01_Prelude', '02_Invocation', '03_PraiseWorship', '04_Fellowship',
  '05_Announcements', '06_HighPraise', '07_DanceShout', '08_SpecialMusic',
  '09_PreachingChords', '10_PrayerTalkingMusic', '11_DiscipleshipInvitation', '12_Dismissal'
];

const SP_CATEGORY_LABELS = {
  '01_Prelude': 'Prelude',
  '02_Invocation': 'Invocation',
  '03_PraiseWorship': 'Praise & Worship',
  '04_Fellowship': 'Fellowship',
  '05_Announcements': 'Announcements',
  '06_HighPraise': 'High Praise',
  '07_DanceShout': 'Dance / Shout',
  '08_SpecialMusic': 'Special Music',
  '09_PreachingChords': 'Preaching Chords',
  '10_PrayerTalkingMusic': 'Prayer / Talking',
  '11_DiscipleshipInvitation': 'Discipleship / Invitation',
  '12_Dismissal': 'Dismissal'
};

// ── Browse for and open a Service Pack folder ──
ipcMain.handle('vwb:openServicePack', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open VWB Service Pack',
    buttonLabel: 'Load Service Pack',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const packDir = result.filePaths[0];
  try {
    // Read pack-info.json if present
    let packInfo = {};
    const infoPath = path.join(packDir, 'pack-info.json');
    if (fs.existsSync(infoPath)) {
      packInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } else {
      // Infer pack name from folder name
      packInfo.name = path.basename(packDir);
      packInfo.artist = 'Unknown Artist';
    }

    // Scan each category folder
    const categories = {};
    for (const cat of SP_CATEGORIES) {
      const catDir = path.join(packDir, cat);
      const label = SP_CATEGORY_LABELS[cat] || cat;
      if (!fs.existsSync(catDir)) {
        categories[cat] = { label, files: [] };
        continue;
      }
      const files = fs.readdirSync(catDir)
        .filter(f => /\.(mid|midi|wav|mp3|ogg|flac|vwbm)$/i.test(f))
        .map(f => {
          const fullPath = path.join(catDir, f);
          const ext = path.extname(f).toLowerCase();
          const isMidi = ext === '.mid' || ext === '.midi';
          const isVwbm = ext === '.vwbm';
          // Parse metadata from filename: ArtistName_Category_Instrument_Key.ext
          const parts = path.basename(f, ext).split('_');
          const instrument = parts[2] || '';
          const key        = parts[3] || '';
          return { name: f, path: fullPath, isMidi, isVwbm, instrument, key, ext };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      categories[cat] = { label, files };
    }

    return { canceled: false, packDir, packInfo, categories };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

// ── Read a Service Pack file for playback ──
ipcMain.handle('vwb:readServicePackFile', async (_evt, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isMidi = ext === '.mid' || ext === '.midi';
    return {
      success: true,
      buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      isMidi,
      fileName: path.basename(filePath),
      filePath
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Save Service Pack selection state ──
ipcMain.handle('vwb:saveServicePackState', async (_evt, state) => {
  try {
    fs.writeFileSync(jsonPath('servicePack'), JSON.stringify(state, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Load saved Service Pack state ──
ipcMain.handle('vwb:loadServicePackState', async () => {
  try {
    const raw = fs.readFileSync(jsonPath('servicePack'), 'utf8');
    return { success: true, data: JSON.parse(raw) };
  } catch (e) {
    return { success: false };
  }
});

// ── Export Bundle — collect all audio + session into one folder ──
ipcMain.handle('vwb:exportBundle', async (_evt, opts = {}) => {
  const { sessionName = 'My VWB Bundle', sessionData, filePaths } = opts;
  // Ask user where to save the bundle folder
  const result = await dialog.showSaveDialog({
    title: 'Export VWB Bundle',
    defaultPath: sessionName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'VWB Bundle',
    buttonLabel: 'Export Bundle',
    properties: ['createDirectory']
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const bundleDir = result.filePath;
    if (!fs.existsSync(bundleDir)) fs.mkdirSync(bundleDir, { recursive: true });
    const audioDir = path.join(bundleDir, 'audio');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

    // Copy all audio files into bundle/audio/ and build a path remapping
    const pathMap = {}; // oldPath -> new relative path
    const copied = [];
    for (const fp of (filePaths || [])) {
      if (!fp || !fs.existsSync(fp)) continue;
      const baseName = path.basename(fp);
      // Avoid name collisions
      let destName = baseName;
      let counter = 1;
      while (fs.existsSync(path.join(audioDir, destName))) {
        const ext = path.extname(baseName);
        destName = path.basename(baseName, ext) + '_' + counter + ext;
        counter++;
      }
      const destPath = path.join(audioDir, destName);
      fs.copyFileSync(fp, destPath);
      pathMap[fp] = path.join('audio', destName); // relative path
      copied.push(destName);
    }

    // Rewrite session data with relative paths
    let sessionStr = sessionData;
    for (const [oldPath, relPath] of Object.entries(pathMap)) {
      // Replace all occurrences of the absolute path with the relative path
      sessionStr = sessionStr.split(JSON.stringify(oldPath)).join(JSON.stringify(relPath));
      sessionStr = sessionStr.split(oldPath).join(relPath);
    }

    // Write the session file into the bundle
    const sessionFile = path.join(bundleDir, (sessionName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'session') + '.vwbs');
    fs.writeFileSync(sessionFile, sessionStr, 'utf8');

    // Write a README
    const readme = `VWB Bundle — ${sessionName}\nCreated by VWB v1.1 © 2026 Hollins Musical Productions International\n\nTo use this bundle:\n1. Open VWB\n2. Go to File → Open Bundle\n3. Select the .vwbs file in this folder\n4. VWB will automatically load all audio files\n\nFiles included: ${copied.length} audio file(s)\n`;
    fs.writeFileSync(path.join(bundleDir, 'README.txt'), readme, 'utf8');

    return { success: true, bundlePath: bundleDir, sessionFile, fileCount: copied.length };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ── Open Bundle — open a .vwbs file and resolve relative paths ──
ipcMain.handle('vwb:openBundle', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open VWB Bundle',
    filters: [{ name: 'VWB Session', extensions: ['vwbs'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  try {
    const sessionPath = result.filePaths[0];
    const bundleDir = path.dirname(sessionPath);
    const content = fs.readFileSync(sessionPath, 'utf8');
    return { canceled: false, path: sessionPath, bundleDir, content };
  } catch(e) {
    return { canceled: false, error: e.message };
  }
});
ipcMain.handle('vwb:saveSetlist',  async (_evt, d) => { try { fs.writeFileSync(jsonPath('setlist'),  JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadSetlist',  async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('setlist'),  'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveSettings', async (_evt, d) => { try { fs.writeFileSync(jsonPath('settings'), JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadSettings', async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('settings'), 'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveService',  async (_evt, d) => { try { fs.writeFileSync(jsonPath('service'),  JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadService',  async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('service'),  'utf8')) }; } catch(e) { return { success:false }; } });
ipcMain.handle('vwb:saveMrcMap',   async (_evt, d) => { try { fs.writeFileSync(jsonPath('mrcmap'),   JSON.stringify(d, null, 2), 'utf8'); return { success:true }; } catch(e) { return { success:false, error:e.message }; } });
ipcMain.handle('vwb:loadMrcMap',   async ()        => { try { return { success:true, data: JSON.parse(fs.readFileSync(jsonPath('mrcmap'),   'utf8')) }; } catch(e) { return { success:false }; } });

// ── House Band Chunk Library ───────────────────────────────────
// Reads all .json chunk files from the house_band_library folder
// and returns them as a flat array to the renderer process.
// The renderer's house-band-engine.js indexes them for fast lookup.
ipcMain.handle('vwb:loadHouseBandLibrary', async () => {
  const libraryDir = path.join(__dirname, 'house_band_library_full');
  const chunks = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(entry => {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.json')) {
        try { chunks.push(JSON.parse(fs.readFileSync(full, 'utf8'))); }
        catch (e) { console.warn('[HouseBand] Could not parse chunk:', full, e.message); }
      }
    });
  }
  walk(libraryDir);
  console.log('[HouseBand] Loaded', chunks.length, 'chunks from library');
  return chunks;
});

// ── House Band Content Downloader ──────────────────────────────
// Downloads a content package zip from Netlify and extracts the
// chunk JSON files into the house_band_library_full folder.
ipcMain.handle('vwb:downloadHouseBandPackage', async (event, { packageId, downloadUrl, name }) => {
  const https = require('https');
  const AdmZip = require('adm-zip');
  const libraryDir = path.join(__dirname, 'house_band_library_full');

  if (!fs.existsSync(libraryDir)) fs.mkdirSync(libraryDir, { recursive: true });

  return new Promise((resolve) => {
    console.log('[HouseBand] Downloading package:', name, 'from', downloadUrl);
    const tmpPath = path.join(libraryDir, packageId + '_tmp.zip');
    const file = fs.createWriteStream(tmpPath);

    https.get(downloadUrl, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(tmpPath, () => {});
        resolve({ success: false, error: 'HTTP ' + response.statusCode });
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            const zip = new AdmZip(tmpPath);
            zip.extractAllTo(libraryDir, true);
            fs.unlink(tmpPath, () => {});
            console.log('[HouseBand] Package installed:', name);
            resolve({ success: true });
          } catch (e) {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, error: e.message });
          }
        });
      });
    }).on('error', (e) => {
      fs.unlink(tmpPath, () => {});
      resolve({ success: false, error: e.message });
    });
  });
});

// ── Whisper Offline Speech Recognition ────────────────────────
// Runs locally — no internet required after first model download.
// Uses nodejs-whisper (whisper.cpp) + node-record-lpcm16 for mic capture.
// node-record-lpcm16 uses Mac's built-in afrecord — no sox needed.
let whisperActive    = false;
let whisperRecorder  = null;
let whisperInterval  = null;
let whisperWindow    = null;

const { execFile, spawn } = require('child_process');
const tmpdir               = require('os').tmpdir();

// Try to load nodejs-whisper
let nodeWhisper = null;
try { nodeWhisper = require('nodejs-whisper'); } catch(e) {
  console.warn('[Whisper] nodejs-whisper not installed:', e.message);
}

// Try to load node-record-lpcm16
let nodeRecord = null;
try { nodeRecord = require('node-record-lpcm16'); } catch(e) {
  console.warn('[Whisper] node-record-lpcm16 not installed:', e.message);
}

// Record audio using macOS built-in afrecord (no sox needed)
function recordChunkMac(filePath, durationSec) {
  return new Promise((resolve) => {
    // afrecord is built into every Mac — no install needed
    const proc = spawn('afrecord', [
      '-f', 'WAVE',
      '-d', 'LEI16@16000',
      '-c', '1',
      '-t', String(durationSec),
      filePath
    ]);
    proc.on('close', () => resolve());
    proc.on('error', () => {
      // fallback: try rec (sox) just in case it got installed later
      const rec = spawn('rec', ['-r', '16000', '-c', '1', '-e', 'signed-integer', '-b', '16', filePath, 'trim', '0', String(durationSec)]);
      rec.on('close', () => resolve());
      rec.on('error', () => resolve()); // give up gracefully
    });
    setTimeout(() => { try { proc.kill(); } catch(e) {} resolve(); }, (durationSec + 1) * 1000);
  });
}

ipcMain.handle('vwb:whisperStart', async (event) => {
  if (!nodeWhisper) {
    return { success: false, error: 'nodejs-whisper not installed. Run: npm install nodejs-whisper' };
  }
  if (whisperActive) return { success: true };

  whisperActive = true;
  whisperWindow = BrowserWindow.fromWebContents(event.sender);

  // Poll every 3.5 seconds: record a chunk then transcribe it
  whisperInterval = setInterval(async () => {
    if (!whisperActive) return;
    try {
      const audioFile = path.join(tmpdir, 'vwb_rubato_chunk.wav');

      // Record 3 seconds via built-in Mac afrecord
      await recordChunkMac(audioFile, 3);

      if (!whisperActive || !fs.existsSync(audioFile)) return;

      // Check file has content
      const stat = fs.statSync(audioFile);
      if (stat.size < 1000) return; // empty or too small — skip

      // Transcribe with Whisper tiny model (75MB, downloads once automatically)
      const result = await nodeWhisper.nodewhisper(audioFile, {
        modelName: 'tiny.en',
        autoDownloadModelName: 'tiny.en',
        whisperOptions: { outputInText: true, language: 'en' }
      });

      if (result && whisperActive && whisperWindow) {
        const transcript = (typeof result === 'string' ? result : JSON.stringify(result))
          .replace(/\[.*?\]/g, '') // strip [00:00] timestamps
          .replace(/\(.*?\)/g, '') // strip (Music) tags
          .trim();
        if (transcript.length > 1) {
          console.log('[Whisper] Heard:', transcript);
          whisperWindow.webContents.executeJavaScript(
            `if(typeof rbOnWhisperTranscript==='function') rbOnWhisperTranscript(${JSON.stringify(transcript)})`
          );
        }
      }
    } catch(e) {
      if (whisperActive) console.warn('[Whisper] Chunk error:', e.message);
    }
  }, 3500);

  return { success: true };
});

ipcMain.handle('vwb:whisperStop', async () => {
  whisperActive = false;
  if (whisperInterval) { clearInterval(whisperInterval); whisperInterval = null; }
  whisperWindow = null;
  return { success: true };
});

// ── Built-in synth sample reader ──────────────────────────────
// Reads sample files via Node.js and returns raw bytes to
// the renderer as a Uint8Array. This bypasses Electron's fetch()
// security restrictions on local file:// URLs entirely.
// Supports both .mp3 (standard soundfonts) and .wav (HMPI custom samples).
ipcMain.handle('vwb:readSampleFile', async (event, sfName, note) => {
  try {
    // HMPI custom sample folders use WAV; everything else uses MP3
    const ext      = sfName.startsWith('hmpi_') ? '.wav' : '.mp3';
    const filePath = path.join(__dirname, 'app', sfName, note + ext);
    const buffer   = fs.readFileSync(filePath);
    return new Uint8Array(buffer);
  } catch (e) {
    return null;
  }
});

// ═══════════════════════════════════════════════════════════════
//  VWB Service Pack Bundle System (.vwbp files)
//  A .vwbp file is a zip archive containing any combination of:
//    pack-info.json       — bundle metadata
//    settings.json        — mixer, tempo, reverb presets
//    service/             — 12 category folders (MIDI + audio)
//    house-band/          — House Band chord charts per song
//    organ/               — organ sample sets
//    rubato/              — Rubato Mode MIDI trigger files
//    loops/               — background loops and pads
//  All sections optional. VWB loads whatever is present.
//  Extension .vwbp chosen to avoid conflict with:
//    .vwb  (Rubato song packs — JSON text)
//    .vwbs (VWB Session files — JSON text)
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('vwb:openVwbBundle', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open VWB Service Pack Bundle',
    buttonLabel: 'Open Bundle',
    filters: [
      { name: 'VWB Service Pack', extensions: ['vwbp'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const bundlePath = result.filePaths[0];

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(bundlePath);
    const entries = zip.getEntries();

    // ── Read pack-info.json ──
    let packInfo = { name: path.basename(bundlePath, '.vwbp'), version: '1.0', creator: 'HMPI' };
    const infoEntry = entries.find(e => e.entryName === 'pack-info.json');
    if (infoEntry) {
      try { packInfo = JSON.parse(zip.readAsText(infoEntry)); } catch(e) {}
    }

    // ── Read settings.json ──
    let settings = null;
    const settingsEntry = entries.find(e => e.entryName === 'settings.json');
    if (settingsEntry) {
      try { settings = JSON.parse(zip.readAsText(settingsEntry)); } catch(e) {}
    }

    // ── Scan service/ categories ──
    const SP_CATS = [
      '01_Prelude','02_Invocation','03_PraiseWorship','04_Fellowship',
      '05_Announcements','06_HighPraise','07_DanceShout','08_SpecialMusic',
      '09_PreachingChords','10_PrayerTalkingMusic','11_DiscipleshipInvitation','12_Dismissal'
    ];
    const categories = {};
    for (const cat of SP_CATS) {
      const prefix = 'service/' + cat + '/';
      const files = entries
        .filter(e => e.entryName.startsWith(prefix) && !e.isDirectory)
        .filter(e => /\.(mid|midi|wav|mp3|ogg|flac)$/i.test(e.entryName))
        .map(e => {
          const fname = path.basename(e.entryName);
          const ext = path.extname(fname).toLowerCase();
          const isMidi = ext === '.mid' || ext === '.midi';
          const parts = path.basename(fname, ext).split('_');
          return { name: fname, entryName: e.entryName, isMidi, instrument: parts[2] || '', key: parts[3] || '', ext };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      categories[cat] = { label: cat.replace(/^\d+_/, '').replace(/([A-Z])/g, ' $1').trim(), files };
    }

    // ── Read songs.json — Song Library manifest ──
    // Describes songs for the VWB Song Library regardless of engine type.
    // Any .vwbp bundle can include this file to register songs into the
    // user's library automatically when the bundle is opened.
    let bundleSongs = [];
    const songsEntry = entries.find(e => e.entryName === 'songs.json');
    if (songsEntry) {
      try {
        const parsed = JSON.parse(zip.readAsText(songsEntry));
        // Accept either { songs: [...] } or a bare array
        bundleSongs = Array.isArray(parsed) ? parsed : (parsed.songs || []);
      } catch(e) {
        console.warn('[Bundle] Could not parse songs.json:', e.message);
      }
    }

        // ── Scan house-band/ chord charts ──
    const houseBandCharts = entries
      .filter(e => e.entryName.startsWith('house-band/') && e.entryName.endsWith('.json') && !e.isDirectory)
      .map(e => {
        try { return { entryName: e.entryName, name: path.basename(e.entryName, '.json'), chart: JSON.parse(zip.readAsText(e)) }; }
        catch(err) { return null; }
      }).filter(Boolean);

    // ── Scan rubato/, loops/, organ/, percussion/ ──
    const rubatoFiles = entries.filter(e => e.entryName.startsWith('rubato/') && /\.(mid|midi)$/i.test(e.entryName) && !e.isDirectory)
      .map(e => ({ entryName: e.entryName, name: path.basename(e.entryName) }));
    const loopFiles = entries.filter(e => e.entryName.startsWith('loops/') && /\.(wav|mp3|ogg|flac)$/i.test(e.entryName) && !e.isDirectory)
      .map(e => ({ entryName: e.entryName, name: path.basename(e.entryName) }));
    const organFiles = entries.filter(e => e.entryName.startsWith('organ/') && /\.(wav|mp3)$/i.test(e.entryName) && !e.isDirectory)
      .map(e => ({ entryName: e.entryName, name: path.basename(e.entryName) }));
    const percussionLoops = entries.filter(e => e.entryName.startsWith('percussion/') && /\.(mid|midi)$/i.test(e.entryName) && !e.isDirectory)
      .map(e => ({ entryName: e.entryName, name: path.basename(e.entryName) }));

    // ── Extract to temp dir ──
    const tmpDir = path.join(os.tmpdir(), 'vwbp-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    zip.extractAllTo(tmpDir, true);

    const resolve = (entryName) => path.join(tmpDir, entryName);

    const categoriesWithPaths = {};
    for (const [cat, data] of Object.entries(categories)) {
      categoriesWithPaths[cat] = { ...data, files: data.files.map(f => ({ ...f, path: resolve(f.entryName) })) };
    }

    // ── Scan stems/ per-song audio files ──
    // Structure: stems/{songTitle}/{stemKey}.{ext}
    // stemKey matches VWB's SK array: piano, bass, guitar, rhythm
    // Plus aux tracks: any files in stems/{songTitle}/aux/
    const stemSongs = {};
    const stemEntries = entries.filter(e =>
      e.entryName.startsWith('stems/') && !e.isDirectory &&
      /\.(wav|mp3|ogg|flac)$/i.test(e.entryName)
    );
    stemEntries.forEach(e => {
      const parts = e.entryName.split('/'); // ['stems', songTitle, filename]
      if (parts.length < 3) return;
      const songTitle = parts[1];
      const fileName = parts[parts.length - 1];
      const ext = path.extname(fileName).toLowerCase();
      const stemKey = path.basename(fileName, ext); // e.g. 'piano', 'bass', 'guitar', 'rhythm'
      const isAux = parts[2] === 'aux';
      if (!stemSongs[songTitle]) stemSongs[songTitle] = { stems: {}, aux: [] };
      if (isAux) {
        stemSongs[songTitle].aux.push({ name: fileName, entryName: e.entryName });
      } else {
        stemSongs[songTitle].stems[stemKey] = { name: fileName, entryName: e.entryName };
      }
    });

    // Resolve paths for extracted stems
    const stemSongsWithPaths = {};
    for (const [songTitle, data] of Object.entries(stemSongs)) {
      stemSongsWithPaths[songTitle] = {
        stems: Object.fromEntries(
          Object.entries(data.stems).map(([k, f]) => [k, { ...f, path: resolve(f.entryName) }])
        ),
        aux: data.aux.map(f => ({ ...f, path: resolve(f.entryName) }))
      };
    }

    return {
      success: true, bundlePath, tmpDir, packInfo, settings,
      bundleSongs,
      categories: categoriesWithPaths,
      houseBandCharts,
      rubatoFiles:      rubatoFiles.map(f =>      ({ ...f, path: resolve(f.entryName) })),
      loopFiles:        loopFiles.map(f =>        ({ ...f, path: resolve(f.entryName) })),
      organFiles:       organFiles.map(f =>       ({ ...f, path: resolve(f.entryName) })),
      percussionLoops:  percussionLoops.map(f =>  ({ ...f, path: resolve(f.entryName) })),
      stemSongs: stemSongsWithPaths,
      summary: {
        hasServiceCategories: Object.values(categoriesWithPaths).some(c => c.files.length > 0),
        hasHouseBand:     houseBandCharts.length > 0,
        hasRubato:        rubatoFiles.length > 0,
        hasLoops:         loopFiles.length > 0,
        hasOrgan:         organFiles.length > 0,
        hasPercussion:    percussionLoops.length > 0,
        hasStems:         Object.keys(stemSongsWithPaths).length > 0,
        stemSongCount:    Object.keys(stemSongsWithPaths).length,
        hasSettings:      !!settings,
        hasSongs:         bundleSongs.length > 0,
        songCount:        bundleSongs.length,
        totalFiles:       entries.filter(e => !e.isDirectory).length,
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('vwb:readBundleFile', async (_evt, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isMidi = ext === '.mid' || ext === '.midi';
    return {
      success: true,
      buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      isMidi, fileName: path.basename(filePath), filePath
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ═══════════════════════════════════════════════════════════════
//  VWB Rubato Song Bundle (.vwbrs files)
//  A .vwbrs file is a zip archive containing:
//    song.vwb    — Rubato song pack JSON (phrases, triggers, key, etc.)
//    song.mid    — Matching MIDI file for piano playback
//  One file upload loads everything — no more two-step loading.
//  Extension .vwbrs chosen to avoid conflict with:
//    .vwb  (standalone Rubato song packs — JSON text)
//    .vwbs (VWB Session files — JSON text)
//    .vwbp (VWB Service Pack bundles — zip)
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('vwb:openRubatoBundle', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Load VWB Rubato Song',
    buttonLabel: 'Load Song',
    filters: [
      { name: 'VWB Rubato Song', extensions: ['vwbrs'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const bundlePath = result.filePaths[0];

  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(bundlePath);
    const entries = zip.getEntries();

    // ── Find the .vwb pack JSON ──
    const packEntry = entries.find(e =>
      !e.isDirectory && (e.entryName.endsWith('.vwb') || e.entryName === 'song.vwb' || e.entryName === 'pack.json')
    );
    if (!packEntry) return { success: false, error: 'No song pack (.vwb) found inside bundle' };

    let pack;
    try {
      pack = JSON.parse(zip.readAsText(packEntry));
    } catch (parseErr) {
      return { success: false, error: 'Song pack JSON is invalid: ' + parseErr.message };
    }

    // ── Find the .mid file ──
    const midiEntry = entries.find(e =>
      !e.isDirectory && /\.(mid|midi)$/i.test(e.entryName)
    );

    let midiBuffer = null;
    let midiFileName = null;
    if (midiEntry) {
      const raw = zip.readFile(midiEntry);
      midiBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      midiFileName = path.basename(midiEntry.entryName);
    }

    return {
      success: true,
      bundlePath,
      fileName: path.basename(bundlePath, '.vwbrs'),
      pack,                // full parsed .vwb JSON
      hasMidi: !!midiEntry,
      midiBuffer,          // ArrayBuffer of .mid file (may be null if not included)
      midiFileName
    };

  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Song Chart (.vwbs) IPC — added for Chart Player Engine ────
ipcMain.handle('vwb:openVwbs', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Load VWB Song Chart',
    buttonLabel: 'Load Chart',
    filters: [
      { name: 'VWB Song Chart', extensions: ['vwbs'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  try {
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf8');
    return { success: true, filePath, fileName: path.basename(filePath), text };
  } catch(e) {
    return { success: false, error: e.message };
  }
});
