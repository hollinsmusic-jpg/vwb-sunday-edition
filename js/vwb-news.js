// ═══════════════════════════════════════════════════════════════
//  VWB — What's New  (vwb-news.js)
//  The unified hub for everything coming from HMPI:
//    • Content downloads (House Band phrases, Rubato packs,
//      Organ samples, Artist Series musicians)
//    • News and announcements
//    • Tips and power user advice
//    • VWB user spotlights
//    • New product and pack announcements
//
//  All content comes from a single JSON feed on Netlify:
//    virtualworshipband.netlify.app/vwb-news.json
//
//  Badge on the What's New tab lights up when anything is new.
//  User taps once → sees everything → downloads with one button.
//  Nothing downloads without their explicit tap.
// ═══════════════════════════════════════════════════════════════

const VWB_NEWS_FEED_URL = 'https://virtualworshipband.netlify.app/vwb-news.json';
const VWB_NEWS_SEEN_KEY = 'vwb_news_last_seen_id';
const VWB_HB_MANIFEST_URL = 'https://virtualworshipband.netlify.app/house-band-library/vwb-hb-manifest.json';

let _vwbNewsData     = null;   // last fetched news feed
let _vwbManifestData = null;   // last fetched content manifest
let _vwbPendingPacks = [];     // content packs available but not yet downloaded
let _vwbDownloading  = false;  // download in progress


// ── Entry point ───────────────────────────────────────────────
// Called from DOMContentLoaded in index.html

function vwbNewsInit() {
  // Inject styles
  _vwbInjectStyles();
  // Fetch news and manifest together, 3s after app loads
  // so the app finishes initializing first
  setTimeout(_vwbFetchAll, 3000);
}


// ── Fetch everything ──────────────────────────────────────────

async function _vwbFetchAll() {
  try {
    const [newsRes, manifestRes] = await Promise.allSettled([
      fetch(VWB_NEWS_FEED_URL    + '?t=' + Date.now()),
      fetch(VWB_HB_MANIFEST_URL  + '?t=' + Date.now()),
    ]);

    if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
      _vwbNewsData = await newsRes.value.json();
    }
    if (manifestRes.status === 'fulfilled' && manifestRes.value.ok) {
      _vwbManifestData = await manifestRes.value.json();
      _vwbProcessManifest(_vwbManifestData);
    }

    _vwbRender();
    _vwbUpdateBadge();
  } catch(e) {
    console.log('[VWBNews] Fetch error:', e.message);
    _vwbRenderOffline();
  }
}

// Also callable manually (e.g. user taps Refresh)
async function vwbNewsRefresh() {
  const el = document.getElementById('newsContent');
  if (el) el.innerHTML = '<div class="vn-loading">Checking for updates…</div>';
  await _vwbFetchAll();
}


// ── Manifest processing ───────────────────────────────────────
// Compares available packs against installed ones.
// Builds _vwbPendingPacks — everything available but not yet installed.

function _vwbProcessManifest(manifest) {
  if (!manifest) return;
  const allPacks = [
    ...(manifest.contentPacks      || []),
    ...(manifest.rubatoContentPacks || []),
    ...(manifest.organContentPacks  || []),
    ...(manifest.artistPacks        || []),
  ].filter(p => p.published !== false); // skip placeholder entries

  const installedPacks = (typeof hbGetInstalledPacks === 'function')
    ? hbGetInstalledPacks()
    : [];
  const installedIds = new Set(installedPacks.map(p => p.id));

  _vwbPendingPacks = allPacks.filter(pack => {
    if (!installedIds.has(pack.id)) return true; // brand new
    // Also include if version is higher than installed
    const installed = installedPacks.find(p => p.id === pack.id);
    if (!installed) return true;
    return _vwbVersionGt(pack.version, installed.version);
  });
}

function _vwbVersionGt(a, b) {
  const toNum = v => (v || '0').split('.').map(Number);
  const av = toNum(a), bv = toNum(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if ((av[i] || 0) > (bv[i] || 0)) return true;
    if ((av[i] || 0) < (bv[i] || 0)) return false;
  }
  return false;
}


// ── Badge ─────────────────────────────────────────────────────

function _vwbUpdateBadge() {
  const dot = document.getElementById('newsBellDot');
  if (!dot) return;

  const hasNewContent = _vwbPendingPacks.length > 0;
  const hasNewNews    = _vwbHasUnseenNews();

  if (hasNewContent || hasNewNews) {
    dot.classList.add('active');
    // Show count if there are pending downloads
    if (_vwbPendingPacks.length > 0) {
      dot.textContent  = _vwbPendingPacks.length;
      dot.style.cssText += ';width:auto;min-width:16px;padding:0 4px;font-size:9px;font-weight:700;border-radius:8px;display:flex;align-items:center;justify-content:center;';
    }
  } else {
    dot.classList.remove('active');
    dot.textContent = '';
  }
}

function _vwbHasUnseenNews() {
  if (!_vwbNewsData) return false;
  const lastSeenId = localStorage.getItem(VWB_NEWS_SEEN_KEY) || '';
  const latestId   = _vwbNewsData.latest_id || '';
  return latestId && latestId !== lastSeenId;
}

function vwbNewsDismissBadge() {
  const dot = document.getElementById('newsBellDot');
  if (dot) { dot.classList.remove('active'); dot.textContent = ''; }
  if (_vwbNewsData && _vwbNewsData.latest_id) {
    localStorage.setItem(VWB_NEWS_SEEN_KEY, _vwbNewsData.latest_id);
  }
}

// Called from goView patch below
function vwbNewsOnOpen() {
  vwbNewsDismissBadge();
  // Re-render in case pending packs changed
  _vwbRender();
}


// ── Download ──────────────────────────────────────────────────

async function vwbDownloadAll() {
  if (_vwbDownloading || _vwbPendingPacks.length === 0) return;
  _vwbDownloading = true;
  _vwbSetStatus('Downloading ' + _vwbPendingPacks.length + ' update(s)…');

  const packs = [..._vwbPendingPacks];
  let installed = 0;

  for (const pack of packs) {
    _vwbSetStatus('Downloading: ' + pack.title + '…');
    const ok = await _vwbDownloadPack(pack);
    if (ok) installed++;
  }

  _vwbDownloading = false;
  _vwbPendingPacks = [];

  if (installed > 0) {
    _vwbSetStatus('✓ ' + installed + ' update(s) installed. Your House Band is current.');
    if (typeof showNotification === 'function') {
      showNotification('🎵 ' + installed + ' House Band update(s) installed successfully.');
    }
    if (typeof hbInvalidateLibraryCache === 'function') hbInvalidateLibraryCache();
    if (typeof bandUiRender === 'function') bandUiRender();
  } else {
    _vwbSetStatus('Download failed. Check your internet connection and try again.');
  }

  _vwbUpdateBadge();
  _vwbRender();
}

async function vwbDownloadOnePack(packId) {
  const pack = _vwbPendingPacks.find(p => p.id === packId);
  if (!pack || _vwbDownloading) return;
  _vwbDownloading = true;
  _vwbSetStatus('Downloading: ' + pack.title + '…');

  const ok = await _vwbDownloadPack(pack);
  _vwbDownloading = false;

  if (ok) {
    _vwbPendingPacks = _vwbPendingPacks.filter(p => p.id !== packId);
    _vwbSetStatus('✓ ' + pack.title + ' installed.');
    if (typeof showNotification === 'function')
      showNotification('🎵 ' + pack.title + ' installed.');
    if (typeof hbInvalidateLibraryCache === 'function') hbInvalidateLibraryCache();
  } else {
    _vwbSetStatus('Download failed: ' + pack.title);
  }

  _vwbUpdateBadge();
  _vwbRender();
}

async function _vwbDownloadPack(pack) {
  try {
    const baseUrl = (_vwbManifestData && _vwbManifestData.baseUrl) || '';

    // Determine which file(s) to download based on type
    let primaryUrl = null;
    let metaUrl    = null;

    if (pack.type === 'phrases' || pack.type === 'chords' || pack.type === 'licks') {
      primaryUrl = baseUrl + pack.midiFile;
      metaUrl    = baseUrl + pack.metaFile;
    } else if (pack.type === 'rubato') {
      primaryUrl = baseUrl + pack.vwbFile;
    } else if (pack.type === 'organ') {
      primaryUrl = baseUrl + pack.zipFile;
    } else if (pack.type === 'artist') {
      primaryUrl = baseUrl + pack.packFile;
      metaUrl    = baseUrl + pack.metaFile;
    }

    if (!primaryUrl) throw new Error('No download URL for pack type: ' + pack.type);

    const primaryRes = await fetch(primaryUrl, { cache: 'no-store' });
    if (!primaryRes.ok) throw new Error('Download failed: ' + primaryUrl);
    const primaryBuffer = await primaryRes.arrayBuffer();

    let metadata = null;
    if (metaUrl) {
      const metaRes = await fetch(metaUrl, { cache: 'no-store' });
      if (metaRes.ok) metadata = await metaRes.json();
    }

    // Route to correct destination
    if (pack.type === 'phrases' || pack.type === 'chords' || pack.type === 'licks') {
      if (!window.vwb || typeof window.vwb.saveHBPack !== 'function')
        throw new Error('window.vwb.saveHBPack not available');
      await window.vwb.saveHBPack({
        packId:   pack.id,
        metadata: metadata || pack,
        midiData: Array.from(new Uint8Array(primaryBuffer)),
      });

    } else if (pack.type === 'rubato') {
      const text    = new TextDecoder().decode(primaryBuffer);
      await window.vwb.saveRubatoPack({ packId: pack.id, vwbData: text, title: pack.title });
      if (typeof rbRefreshInstalledPacks === 'function') rbRefreshInstalledPacks();

    } else if (pack.type === 'organ') {
      await window.vwb.saveOrganPack({
        packId:   pack.id,
        zipData:  Array.from(new Uint8Array(primaryBuffer)),
        targetFolder: (typeof abRootFolder !== 'undefined' && abRootFolder) ? abRootFolder : null,
      });
      if (typeof abScanFolder === 'function') await abScanFolder();

    } else if (pack.type === 'artist') {
      // Artist Series musician pack
      if (metadata && typeof bandInstallPack === 'function') {
        await window.vwb.saveHBPack({
          packId:   pack.id,
          metadata: metadata,
          midiData: Array.from(new Uint8Array(primaryBuffer)),
        });
        bandInstallPack({
          id:          pack.id,
          name:        metadata.artistName  || pack.title,
          slot:        metadata.slot,
          style:       metadata.style       || '',
          bio:         metadata.bio         || '',
          avatar:      metadata.avatarPath  || null,
          contentPath: pack.id,
        });
        if (typeof bandUiRender === 'function') bandUiRender();
      }
    }

    // Save to installed index
    if (typeof _hbSaveInstalledIndex === 'function') {
      if (typeof _hbUpdateState !== 'undefined') {
        _hbUpdateState.installedPacks[pack.id] = {
          version:     pack.version,
          title:       pack.title,
          type:        pack.type,
          installedAt: new Date().toISOString(),
        };
        await _hbSaveInstalledIndex();
      }
    }

    console.log('[VWBNews] Installed pack:', pack.id);
    return true;

  } catch(e) {
    console.error('[VWBNews] Download failed for', pack.id, ':', e.message);
    return false;
  }
}


// ── Render ────────────────────────────────────────────────────

function _vwbRender() {
  const el = document.getElementById('newsContent');
  if (!el) return;

  let html = '';

  // ── Content Downloads Section ──
  if (_vwbPendingPacks.length > 0) {
    html += `
      <div class="vn-downloads-section">
        <div class="vn-downloads-header">
          <div>
            <div class="vn-downloads-title">🎵 New Content Available</div>
            <div class="vn-downloads-sub">${_vwbPendingPacks.length} update${_vwbPendingPacks.length > 1 ? 's' : ''} ready for your House Band</div>
          </div>
          <button class="vn-download-all-btn" onclick="vwbDownloadAll()">
            ⬇ Download All
          </button>
        </div>
        <div class="vn-pack-list">
          ${_vwbPendingPacks.map(pack => `
            <div class="vn-pack-item">
              <div class="vn-pack-icon">${_vwbPackIcon(pack.type)}</div>
              <div class="vn-pack-info">
                <div class="vn-pack-title">${_esc(pack.title)}</div>
                <div class="vn-pack-meta">${_esc(pack.style || pack.type || '')}${pack.feel ? ' · ' + pack.feel : ''}${pack.keys ? ' · ' + pack.keys.join(', ') : ''}</div>
                <div class="vn-pack-desc">${_esc(pack.description || '')}</div>
              </div>
              <button class="vn-pack-btn" onclick="vwbDownloadOnePack('${pack.id}')">Get</button>
            </div>
          `).join('')}
        </div>
        <div class="vn-status" id="vwbDownloadStatus"></div>
      </div>`;
  } else if (_vwbManifestData) {
    // Show "up to date" indicator quietly
    const installed = (typeof hbGetInstalledPacks === 'function') ? hbGetInstalledPacks().length : 0;
    if (installed > 0) {
      html += `<div class="vn-current">
        <span class="vn-check">✓</span> House Band library is up to date
        <span class="vn-installed-count">${installed} pack${installed > 1 ? 's' : ''} installed</span>
      </div>`;
    }
  }

  const news = _vwbNewsData;

  if (!news) {
    if (!_vwbManifestData) {
      html += '<div class="vn-loading">Checking for updates…</div>';
    }
    el.innerHTML = html;
    return;
  }

  // ── Updated timestamp ──
  if (news.updated) {
    html += `<div class="vn-updated">Last updated: ${_esc(news.updated)}</div>`;
  }

  // ── Featured card ──
  if (news.featured) {
    const f = news.featured;
    html += `
      <div class="vn-featured">
        <div class="vn-featured-top">
          <div class="vn-feat-icon">${f.icon || '🎵'}</div>
          <div class="vn-feat-text">
            <div class="vn-feat-eyebrow">${_esc(f.eyebrow || '')}</div>
            <div class="vn-feat-title">${_esc(f.title)}</div>
            ${f.subtitle ? `<div class="vn-feat-sub">${_esc(f.subtitle)}</div>` : ''}
          </div>
          ${f.new ? '<span class="vn-new-pill">Just Released</span>' : ''}
        </div>
        <div class="vn-featured-body">
          <div class="vn-featured-desc">${f.description || ''}</div>
          ${f.cta_label && f.cta_url
            ? `<a class="vn-cta-btn" href="#" onclick="vwbNewsOpenLink('${_esc(f.cta_url)}');return false;">${_esc(f.cta_label)} →</a>`
            : ''}
        </div>
      </div>`;
  }

  // ── User Spotlights ──
  if (news.spotlights && news.spotlights.length > 0) {
    html += '<div class="vn-section-label">VWB Community Spotlight</div>';
    html += '<div class="vn-spotlights">';
    news.spotlights.forEach(s => {
      html += `
        <div class="vn-spotlight-card">
          <div class="vn-spotlight-top">
            ${s.photo
              ? `<img class="vn-spotlight-photo" src="${_esc(s.photo)}" alt="${_esc(s.name)}" onerror="this.style.display='none'">`
              : `<div class="vn-spotlight-avatar">${(s.name || '?')[0]}</div>`}
            <div class="vn-spotlight-info">
              <div class="vn-spotlight-name">${_esc(s.name)}</div>
              <div class="vn-spotlight-loc">${_esc(s.church || '')}${s.city ? ' · ' + s.city : ''}</div>
            </div>
          </div>
          <div class="vn-spotlight-quote">"${_esc(s.quote)}"</div>
        </div>`;
    });
    html += '</div>';
  }

  // ── Video Tutorials ──
  if (news.videos && news.videos.length > 0) {
    html += '<div class="vn-section-label">Video Tutorials</div>';
    html += '<div class="vn-videos-grid">';
    news.videos.forEach(vid => {
      // Extract YouTube video ID from various URL formats
      const ytId = _vwbExtractYouTubeId(vid.url);
      const thumb = ytId
        ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`
        : (vid.thumbnail || '');
      html += `
        <div class="vn-video-card" onclick="vwbNewsOpenLink('${_esc(vid.url)}')" title="Watch on YouTube">
          <div class="vn-video-thumb-wrap">
            ${thumb
              ? `<img class="vn-video-thumb" src="${_esc(thumb)}" alt="${_esc(vid.title)}">`
              : `<div class="vn-video-thumb-placeholder">🎬</div>`}
            <div class="vn-video-play">▶</div>
            ${vid.duration ? `<div class="vn-video-duration">${_esc(vid.duration)}</div>` : ''}
          </div>
          <div class="vn-video-info">
            <div class="vn-video-title">${_esc(vid.title)}</div>
            ${vid.description ? `<div class="vn-video-desc">${_esc(vid.description)}</div>` : ''}
            <div class="vn-video-cta">Watch on YouTube →</div>
          </div>
        </div>`;
    });
    html += '</div>';
  }

  // ── Tips & Tricks ──
  if (news.tips && news.tips.length > 0) {
    html += '<div class="vn-section-label">Tips &amp; Power Moves</div>';
    html += '<div class="vn-tips-grid">';
    news.tips.forEach(tip => {
      html += `
        <div class="vn-tip-card">
          <div class="vn-tip-icon">${tip.icon || '💡'}</div>
          <div class="vn-tip-title">${_esc(tip.title)}</div>
          <div class="vn-tip-body">${_esc(tip.body)}</div>
        </div>`;
    });
    html += '</div>';
  }

  // ── Announcements ──
  if (news.announcements && news.announcements.length > 0) {
    html += '<div class="vn-section-label">Announcements</div>';
    news.announcements.forEach(ann => {
      html += `
        <div class="vn-announce-card">
          <div class="vn-announce-icon">${ann.icon || '📢'}</div>
          <div class="vn-announce-body">
            <div class="vn-announce-title">${_esc(ann.title)}</div>
            <div class="vn-announce-sub">${_esc(ann.body)}</div>
          </div>
          ${ann.link_label && ann.link_url
            ? `<a class="vn-announce-link" href="#" onclick="vwbNewsOpenLink('${_esc(ann.link_url)}');return false;">${_esc(ann.link_label)} →</a>`
            : ''}
        </div>`;
    });
  }

  // Refresh button at bottom
  html += `
    <div class="vn-refresh-row">
      <button class="vn-refresh-btn" onclick="vwbNewsRefresh()">↻ Refresh</button>
    </div>`;

  if (!news.featured && (!news.tips || !news.tips.length) &&
      (!news.announcements || !news.announcements.length) &&
      (!news.spotlights || !news.spotlights.length) &&
      _vwbPendingPacks.length === 0) {
    html += '<div class="vn-empty">No updates yet — check back soon!</div>';
  }

  el.innerHTML = html;
}

function _vwbRenderOffline() {
  const el = document.getElementById('newsContent');
  if (el) el.innerHTML = `
    <div class="vn-empty">
      Unable to check for updates right now.<br>
      <button class="vn-refresh-btn" style="margin-top:1rem;" onclick="vwbNewsRefresh()">↻ Try Again</button>
    </div>`;
}

function _vwbSetStatus(msg) {
  const el = document.getElementById('vwbDownloadStatus');
  if (el) el.textContent = msg;
  console.log('[VWBNews]', msg);
}

function _vwbPackIcon(type) {
  const icons = {
    phrases: '🎵', chords: '🎹', licks: '⚡',
    rubato: '🎙', organ: '🎹', artist: '👤',
  };
  return icons[type] || '📦';
}


// ── External link opener ──────────────────────────────────────

function vwbNewsOpenLink(url) {
  if (window.vwb && window.vwb.openExternal) window.vwb.openExternal(url);
  else window.open(url, '_blank');
}


// ── goView patch ──────────────────────────────────────────────
// Dismiss badge and re-render when user opens What's New tab

document.addEventListener('DOMContentLoaded', () => {
  const orig = window.goView;
  if (typeof orig === 'function') {
    window.goView = function(view) {
      orig(view);
      if (view === 'news')    vwbNewsOnOpen();
      if (view === 'library') { if (typeof slOnOpen === 'function') slOnOpen(); }
    };
  }
});


// ── Helpers ───────────────────────────────────────────────────

function _vwbExtractYouTubeId(url) {
  if (!url) return null;
  // Handles: youtu.be/ID, youtube.com/watch?v=ID, youtube.com/embed/ID
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ── Styles ────────────────────────────────────────────────────

function _vwbInjectStyles() {
  if (document.getElementById('vwb-news-styles')) return;
  const s = document.createElement('style');
  s.id = 'vwb-news-styles';
  s.textContent = `

    /* ── Downloads section ── */
    .vn-downloads-section {
      background: linear-gradient(135deg,rgba(64,224,208,.10),rgba(64,224,208,.03));
      border: 1px solid rgba(64,224,208,.3);
      border-radius: 14px; padding: 1.1rem 1.25rem;
      margin-bottom: 1.25rem;
    }
    .vn-downloads-header {
      display: flex; align-items: center;
      justify-content: space-between; gap: 1rem;
      margin-bottom: 1rem;
    }
    .vn-downloads-title {
      font-size: .95rem; font-weight: 700;
      color: var(--accent, #40E0D0); margin-bottom: .2rem;
    }
    .vn-downloads-sub { font-size: .8rem; color: var(--text-secondary, #8892a4); }
    .vn-download-all-btn {
      padding: .6rem 1.3rem;
      background: var(--accent, #40E0D0); color: #080c12;
      font-weight: 700; font-size: .9rem; border: none;
      border-radius: 10px; cursor: pointer;
      font-family: inherit; white-space: nowrap;
      transition: opacity .15s; flex-shrink: 0;
    }
    .vn-download-all-btn:hover { opacity: .88; }

    .vn-pack-list { display: flex; flex-direction: column; gap: .6rem; margin-bottom: .5rem; }
    .vn-pack-item {
      background: rgba(255,255,255,.04); border: 1px solid var(--border, #1e2a3a);
      border-radius: 10px; padding: .85rem 1rem;
      display: flex; align-items: center; gap: .85rem;
    }
    .vn-pack-icon { font-size: 1.4rem; flex-shrink: 0; }
    .vn-pack-info { flex: 1; min-width: 0; }
    .vn-pack-title {
      font-size: .88rem; font-weight: 600;
      color: var(--text-primary, #e8edf4); margin-bottom: .15rem;
    }
    .vn-pack-meta {
      font-size: .72rem; color: var(--accent, #40E0D0);
      margin-bottom: .15rem;
    }
    .vn-pack-desc { font-size: .72rem; color: var(--text-secondary, #8892a4); line-height: 1.4; }
    .vn-pack-btn {
      flex-shrink: 0; padding: .45rem .9rem;
      background: rgba(64,224,208,.1);
      border: 1px solid rgba(64,224,208,.35);
      border-radius: 8px; color: var(--accent, #40E0D0);
      font-size: .82rem; font-weight: 700;
      cursor: pointer; font-family: inherit;
      transition: background .15s;
    }
    .vn-pack-btn:hover { background: rgba(64,224,208,.2); }
    .vn-status {
      font-size: .8rem; color: var(--text-secondary, #8892a4);
      min-height: 1.2rem; margin-top: .25rem;
    }
    .vn-current {
      display: flex; align-items: center; gap: .5rem;
      font-size: .82rem; color: var(--text-secondary, #8892a4);
      padding: .6rem 0; margin-bottom: .5rem;
    }
    .vn-check { color: var(--green, #44dd88); font-size: 1rem; }
    .vn-installed-count {
      margin-left: auto; font-size: .72rem;
      background: rgba(68,221,136,.08);
      border: 1px solid rgba(68,221,136,.2);
      border-radius: 6px; padding: .15rem .5rem;
      color: var(--green, #44dd88);
    }

    /* ── Section label ── */
    .vn-section-label {
      font-size: .7rem; font-weight: 700;
      letter-spacing: .12em; text-transform: uppercase;
      color: var(--text-dim, #4a5a6a);
      padding-bottom: .6rem;
      border-bottom: 1px solid var(--border, #1e2a3a);
      margin: 1.25rem 0 .9rem;
    }

    /* ── Featured card ── */
    .vn-featured {
      border: 1px solid var(--border, #1e2a3a); border-radius: 12px;
      overflow: hidden; margin-bottom: 1.25rem;
      background: var(--bg-card, #111620);
    }
    .vn-featured-top {
      background: var(--bg-tertiary, #0d1520);
      padding: 1.1rem 1.4rem;
      display: flex; align-items: center; gap: 1rem;
      border-bottom: 1px solid var(--border, #1e2a3a);
      position: relative;
    }
    .vn-feat-icon {
      width: 48px; height: 48px; border-radius: 10px; flex-shrink: 0;
      background: rgba(232,124,42,.15); border: 1px solid rgba(232,124,42,.3);
      display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
    }
    .vn-feat-eyebrow {
      font-size: .68rem; font-weight: 700; letter-spacing: .12em;
      text-transform: uppercase; color: #E87C2A; margin-bottom: .2rem;
    }
    .vn-feat-title { font-size: 1rem; font-weight: 600; color: var(--text-primary, #e8edf4); }
    .vn-feat-sub { font-size: .78rem; color: var(--text-secondary, #8892a4); margin-top: .15rem; }
    .vn-new-pill {
      background: #E87C2A; color: #fff; font-size: .62rem;
      font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
      padding: 3px 8px; border-radius: 4px; flex-shrink: 0; margin-left: auto;
    }
    .vn-featured-body {
      padding: .9rem 1.4rem;
      display: flex; align-items: center;
      justify-content: space-between; gap: 1rem;
    }
    .vn-featured-desc { font-size: .85rem; color: var(--text-secondary, #8892a4); line-height: 1.55; flex: 1; }
    .vn-cta-btn {
      flex-shrink: 0; background: #E87C2A; color: #fff;
      border: none; border-radius: 8px; padding: .55rem 1.1rem;
      font-size: .82rem; font-weight: 600; cursor: pointer;
      text-decoration: none; display: inline-block; white-space: nowrap;
      transition: background .15s;
    }
    .vn-cta-btn:hover { background: #f0922e; }

    /* ── User Spotlights ── */
    .vn-spotlights {
      display: grid; grid-template-columns: 1fr 1fr; gap: .85rem;
      margin-bottom: 1rem;
    }
    .vn-spotlight-card {
      background: var(--bg-card, #111620);
      border: 1px solid var(--border, #1e2a3a);
      border-radius: 12px; padding: 1rem 1.1rem;
    }
    .vn-spotlight-top {
      display: flex; align-items: center; gap: .75rem; margin-bottom: .75rem;
    }
    .vn-spotlight-photo {
      width: 44px; height: 44px; border-radius: 50%;
      object-fit: cover; flex-shrink: 0;
      border: 2px solid rgba(64,224,208,.25);
    }
    .vn-spotlight-avatar {
      width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
      background: rgba(64,224,208,.12); border: 2px solid rgba(64,224,208,.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem; font-weight: 700; color: var(--accent, #40E0D0);
    }
    .vn-spotlight-name {
      font-size: .88rem; font-weight: 600; color: var(--text-primary, #e8edf4);
    }
    .vn-spotlight-loc { font-size: .72rem; color: var(--text-secondary, #8892a4); margin-top: .1rem; }
    .vn-spotlight-quote {
      font-size: .82rem; color: var(--text-secondary, #8892a4);
      line-height: 1.55; font-style: italic;
    }

    /* ── Tips grid ── */
    .vn-tips-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-bottom: 1rem; }
    .vn-tip-card {
      background: var(--bg-card, #111620); border: 1px solid var(--border, #1e2a3a);
      border-radius: 10px; padding: 1rem 1.1rem; transition: border-color .15s;
    }
    .vn-tip-card:hover { border-color: rgba(64,224,208,.25); }
    .vn-tip-icon { font-size: 1.2rem; margin-bottom: .5rem; }
    .vn-tip-title { font-size: .875rem; font-weight: 600; color: var(--text-primary, #e8edf4); margin-bottom: .3rem; }
    .vn-tip-body { font-size: .8rem; color: var(--text-secondary, #8892a4); line-height: 1.5; }

    /* ── Announcements ── */
    .vn-announce-card {
      background: var(--bg-card, #111620); border: 1px solid var(--border, #1e2a3a);
      border-left: 3px solid #E87C2A; border-radius: 8px;
      padding: .85rem 1rem; display: flex; align-items: center;
      gap: .85rem; margin-bottom: .6rem;
    }
    .vn-announce-icon { font-size: 1.1rem; flex-shrink: 0; opacity: .8; }
    .vn-announce-body { flex: 1; min-width: 0; }
    .vn-announce-title { font-size: .875rem; font-weight: 600; color: var(--text-primary, #e8edf4); margin-bottom: .15rem; }
    .vn-announce-sub { font-size: .78rem; color: var(--text-secondary, #8892a4); }
    .vn-announce-link {
      margin-left: auto; font-size: .78rem; color: #E87C2A;
      text-decoration: none; white-space: nowrap; flex-shrink: 0; font-weight: 500;
    }
    .vn-announce-link:hover { text-decoration: underline; }

    /* ── Misc ── */
    .vn-empty { text-align: center; padding: 3rem 1rem; color: var(--text-dim, #4a5a6a); font-size: .9rem; }
    .vn-loading { text-align: center; padding: 3rem 1rem; color: var(--text-dim, #4a5a6a); font-size: .85rem; font-style: italic; }
    .vn-updated { font-size: .72rem; color: var(--text-dim, #4a5a6a); text-align: right; margin-bottom: 1rem; }
    .vn-refresh-row { text-align: center; padding: 1rem 0 .5rem; }
    .vn-refresh-btn {
      background: none; border: 1px solid var(--border, #1e2a3a);
      border-radius: 8px; padding: .4rem 1rem;
      color: var(--text-secondary, #8892a4); font-size: .8rem;
      cursor: pointer; font-family: inherit; transition: border-color .15s;
    }
    .vn-refresh-btn:hover { border-color: var(--accent, #40E0D0); color: var(--accent, #40E0D0); }

    /* ── Video tutorials ── */
    .vn-videos-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: .85rem; margin-bottom: 1rem;
    }
    .vn-video-card {
      background: var(--bg-card, #111620);
      border: 1px solid var(--border, #1e2a3a);
      border-radius: 12px; overflow: hidden;
      cursor: pointer; transition: border-color .2s, transform .2s;
    }
    .vn-video-card:hover {
      border-color: rgba(64,224,208,.35);
      transform: translateY(-2px);
    }
    .vn-video-thumb-wrap {
      position: relative; width: 100%;
      aspect-ratio: 16/9; overflow: hidden;
      background: #080c12;
    }
    .vn-video-thumb {
      width: 100%; height: 100%;
      object-fit: cover; display: block;
      transition: opacity .2s;
    }
    .vn-video-card:hover .vn-video-thumb { opacity: .85; }
    .vn-video-thumb-placeholder {
      width: 100%; height: 100%;
      display: flex; align-items: center;
      justify-content: center; font-size: 2.5rem;
      background: #0d1520;
    }
    .vn-video-play {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%);
      width: 44px; height: 44px; border-radius: 50%;
      background: rgba(64,224,208,.9);
      display: flex; align-items: center; justify-content: center;
      font-size: .9rem; color: #080c12; font-weight: 700;
      box-shadow: 0 4px 16px rgba(0,0,0,.4);
      transition: transform .15s, background .15s;
      padding-left: 3px;
    }
    .vn-video-card:hover .vn-video-play {
      transform: translate(-50%,-50%) scale(1.1);
      background: var(--teal, #40E0D0);
    }
    .vn-video-duration {
      position: absolute; bottom: 6px; right: 8px;
      background: rgba(0,0,0,.75); color: #fff;
      font-size: .68rem; font-weight: 600;
      padding: 2px 6px; border-radius: 4px;
      font-family: 'Space Mono', monospace;
    }
    .vn-video-info { padding: .75rem 1rem; }
    .vn-video-title {
      font-size: .875rem; font-weight: 600;
      color: var(--text-primary, #e8edf4);
      margin-bottom: .3rem; line-height: 1.35;
    }
    .vn-video-desc {
      font-size: .75rem; color: var(--text-secondary, #8892a4);
      line-height: 1.45; margin-bottom: .4rem;
    }
    .vn-video-cta {
      font-size: .72rem; color: var(--accent, #40E0D0);
      font-weight: 600;
    }

    /* ── Single-column on narrow screens ── */
    @media (max-width: 640px) {
      .vn-spotlights, .vn-tips-grid, .vn-videos-grid { grid-template-columns: 1fr; }
      .vn-downloads-header { flex-direction: column; align-items: flex-start; }
    }
  `;
  document.head.appendChild(s);
}
