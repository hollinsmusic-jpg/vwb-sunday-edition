// ═══════════════════════════════════════════════════════════════
//  VWB — House Band IPC Handlers
//  js/hb-ipc-handlers.js
//
//  Registers ALL content delivery IPC handlers in main.js:
//    House Band packs (phrases, chords, licks)
//    Rubato song packs (.vwb files)
//    Organ sample packs (.zip → WAV files)
//    Service Pack (.vwbp bundle) opening
//
//  Usage in main.js:
//    const hbIpc = require('./js/hb-ipc-handlers');
//    hbIpc.register(ipcMain, app);
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs   = require('fs');

function _ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function register(ipcMain, app) {

  // ── House Band Pack Handlers ─────────────────────────────────

  function _hbPackDir(packId) {
    const base = path.join(app.getPath('userData'), 'house-band-packs');
    _ensureDir(base);
    if (packId) {
      const packPath = path.join(base, packId);
      _ensureDir(packPath);
      return packPath;
    }
    return base;
  }

  ipcMain.handle('hb:savePack', async (event, { packId, metadata, midiData }) => {
    try {
      const dir = _hbPackDir(packId);
      fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
      const buf = Buffer.from(midiData);
      fs.writeFileSync(path.join(dir, 'performance.mid'), buf);
      console.log('[Main] HB pack saved:', packId, '| MIDI:', buf.length, 'bytes');
      return { success: true, packId };
    } catch(e) {
      console.error('[Main] hb:savePack error:', e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('hb:loadPack', async (event, packId) => {
    try {
      const dir      = _hbPackDir(packId);
      const metaPath = path.join(dir, 'metadata.json');
      const midiPath = path.join(dir, 'performance.mid');
      if (!fs.existsSync(metaPath)) return { success: false, error: 'Pack not found: ' + packId };
      const metadata  = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return { success: true, packId, metadata, midiPath: fs.existsSync(midiPath) ? midiPath : null };
    } catch(e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('hb:readPackMidi', async (event, packId) => {
    try {
      const midiPath = path.join(_hbPackDir(packId), 'performance.mid');
      if (!fs.existsSync(midiPath)) return { success: false, error: 'MIDI not found: ' + packId };
      const buf = fs.readFileSync(midiPath);
      return { success: true, packId, buffer: buf };
    } catch(e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('hb:listPacks', async (event) => {
    try {
      const base    = _hbPackDir(null);
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const packIds = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => fs.existsSync(path.join(base, name, 'metadata.json')));
      return { success: true, packIds };
    } catch(e) {
      return { success: false, error: e.message, packIds: [] };
    }
  });

  ipcMain.handle('hb:deletePack', async (event, packId) => {
    try {
      const dir = path.join(_hbPackDir(null), packId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      console.log('[Main] HB pack deleted:', packId);
      return { success: true, packId };
    } catch(e) {
      return { success: false, error: e.message };
    }
  });


  // ── Rubato Pack Handlers ──────────────────────────────────────

  ipcMain.handle('vwb:saveRubatoPack', async (event, { packId, vwbData, title }) => {
    try {
      const dir = _ensureDir(path.join(app.getPath('userData'), 'rubato-packs', packId));
      fs.writeFileSync(path.join(dir, 'pack.vwb'), vwbData, 'utf8');
      fs.writeFileSync(
        path.join(dir, 'index.json'),
        JSON.stringify({ packId, title, installedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
      console.log('[Main] Rubato pack saved:', packId, '—', title);
      return { success: true, packId };
    } catch(e) {
      console.error('[Main] vwb:saveRubatoPack error:', e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('vwb:listRubatoPacks', async (event) => {
    try {
      const base = path.join(app.getPath('userData'), 'rubato-packs');
      if (!fs.existsSync(base)) return { success: true, packs: [] };
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const packs = entries
        .filter(e => e.isDirectory())
        .map(e => {
          const idxPath = path.join(base, e.name, 'index.json');
          const vwbPath = path.join(base, e.name, 'pack.vwb');
          if (!fs.existsSync(vwbPath)) return null;
          try {
            const idx = fs.existsSync(idxPath)
              ? JSON.parse(fs.readFileSync(idxPath, 'utf8'))
              : { packId: e.name, title: e.name };
            return { ...idx, vwbPath };
          } catch(e) { return null; }
        })
        .filter(Boolean);
      return { success: true, packs };
    } catch(e) {
      return { success: false, error: e.message, packs: [] };
    }
  });

  ipcMain.handle('vwb:readRubatoPack', async (event, packId) => {
    try {
      const vwbPath = path.join(app.getPath('userData'), 'rubato-packs', packId, 'pack.vwb');
      if (!fs.existsSync(vwbPath)) return { success: false, error: 'Pack not found: ' + packId };
      const content = fs.readFileSync(vwbPath, 'utf8');
      return { success: true, packId, content };
    } catch(e) {
      return { success: false, error: e.message };
    }
  });


  // ── Organ Sample Pack Handlers ────────────────────────────────

  ipcMain.handle('vwb:saveOrganPack', async (event, { packId, zipData, targetFolder }) => {
    try {
      // Try to use adm-zip if available; otherwise save raw zip for manual extraction
      let count = 0;
      const destDir = targetFolder || _ensureDir(path.join(app.getPath('userData'), 'organ-samples'));

      try {
        const AdmZip = require('adm-zip');
        const zip    = new AdmZip(Buffer.from(zipData));
        zip.getEntries().forEach(entry => {
          if (!entry.isDirectory && entry.name.endsWith('.wav')) {
            zip.extractEntryTo(entry, destDir, false, true);
            count++;
          }
        });
      } catch(zipErr) {
        // adm-zip not available — save the zip file for manual install
        const zipPath = path.join(destDir, packId + '.zip');
        fs.writeFileSync(zipPath, Buffer.from(zipData));
        console.warn('[Main] adm-zip not available — saved zip to:', zipPath);
        return { success: true, packId, filesInstalled: 0, zipSaved: zipPath };
      }

      console.log('[Main] Organ pack installed:', count, 'WAV files →', destDir);
      return { success: true, packId, filesInstalled: count, destDir };
    } catch(e) {
      console.error('[Main] vwb:saveOrganPack error:', e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('vwb:saveOrganSamples', async (event, { files, targetFolder }) => {
    try {
      const destDir = targetFolder || _ensureDir(path.join(app.getPath('userData'), 'organ-samples'));
      files.forEach(({ fileName, data }) => {
        fs.writeFileSync(path.join(destDir, fileName), Buffer.from(data));
      });
      console.log('[Main] Organ samples saved:', files.length, 'files →', destDir);
      return { success: true, filesInstalled: files.length, destDir };
    } catch(e) {
      return { success: false, error: e.message };
    }
  });


  // ── Service Pack (.vwbp) Handler ──────────────────────────────

  ipcMain.handle('vwb:openServicePack', async (event, filePath) => {
    try {
      // If no filePath passed, show file picker
      let bundlePath = filePath;
      if (!bundlePath) {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog({
          title: 'Open VWB Service Pack',
          filters: [
            { name: 'VWB Service Pack', extensions: ['vwbp', 'zip'] },
            { name: 'All Files', extensions: ['*'] }
          ],
          properties: ['openFile']
        });
        if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
        bundlePath = result.filePaths[0];
      }

      let AdmZip;
      try { AdmZip = require('adm-zip'); } catch(e) {
        return { success: false, error: 'adm-zip not available — cannot open .vwbp bundles' };
      }

      const zip = new AdmZip(bundlePath);
      const result = {
        success: true, packInfo: null, settings: null,
        houseBandCharts: [], rubatoPacks: [], organSamples: [], loops: [], serviceFiles: [],
      };

      zip.getEntries().forEach(entry => {
        if (entry.isDirectory) return;
        const name    = entry.name;
        const entPath = entry.entryName;
        const data    = entry.getData();

        if (name === 'pack-info.json') {
          try { result.packInfo = JSON.parse(data.toString('utf8')); } catch(e) {}
        } else if (name === 'settings.json') {
          try { result.settings = JSON.parse(data.toString('utf8')); } catch(e) {}
        } else if (entPath.startsWith('house-band/') && name.endsWith('.json')) {
          try { result.houseBandCharts.push({ fileName: name, data: JSON.parse(data.toString('utf8')) }); } catch(e) {}
        } else if (entPath.startsWith('rubato/') && name.endsWith('.vwb')) {
          result.rubatoPacks.push({ fileName: name, content: data.toString('utf8') });
        } else if (entPath.startsWith('organ/') && name.endsWith('.wav')) {
          result.organSamples.push({ fileName: name, data: Array.from(data) });
        } else if (entPath.startsWith('loops/')) {
          result.loops.push({ fileName: name, data: Array.from(data) });
        } else if (entPath.startsWith('service/')) {
          result.serviceFiles.push({ entryPath: entPath, fileName: name, data: Array.from(data) });
        }
      });

      const packName = result.packInfo?.name || path.basename(bundlePath);
      console.log('[Main] Service Pack opened:', packName,
        '| charts:', result.houseBandCharts.length,
        '| rubato:', result.rubatoPacks.length,
        '| organ:', result.organSamples.length,
        '| loops:', result.loops.length);

      return result;
    } catch(e) {
      console.error('[Main] vwb:openServicePack error:', e.message);
      return { success: false, error: e.message };
    }
  });

  console.log('[Main] House Band IPC handlers registered (HB packs, Rubato, Organ, Service Packs).');
}

module.exports = { register };
