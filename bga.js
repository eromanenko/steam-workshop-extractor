// ============================================================
// BGA Extractor – Main Application
// Parses Board Game Arena HTML to extract game assets
// ============================================================

'use strict';

// ─── State ───────────────────────────────────────────────────
let allAssets = [];
let currentBgaMeta = { gameName: 'BGA_Game', bgaId: null };
let bgaCutterData = null;

// ─── CORS-aware Fetcher ───────────────────────────────────────
const CORS_PROXIES = [
  { url: url => url.replace(/^https?:\/\/(?:[a-z0-9-]+\.)?boardgamearena\.com\//i, '/bga-proxy/'), type: 'text' },
  { url: url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, type: 'text' },
  { url: url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, type: 'json' },
  { url: url => `https://corsproxy.io/?${encodeURIComponent(url)}`, type: 'text' }
];

async function fetchHtmlWithCorsProxy(url) {
  // Try direct fetch first
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return await res.text();
  } catch {}

  // Fall back to each CORS proxy
  for (const proxy of CORS_PROXIES) {
    try {
      const proxyUrl = proxy.url(url);
      const res = await fetch(proxyUrl);
      if (res.ok) {
        if (proxy.type === 'json') {
          const data = await res.json();
          return data.contents;
        }
        return await res.text();
      }
    } catch {}
  }
  throw new Error(`Failed to fetch URL: ${url}. All CORS proxies failed.`);
}

// ─── Main Flow: Fetch from URL ────────────────────────────────
async function fetchFromUrl() {
  const input = document.getElementById('url-input').value.trim();
  if (!input) { showToast('Enter a Board Game Arena URL', 'error'); return; }

  // Update URL for sharing
  const urlParams = new URL(window.location);
  urlParams.searchParams.set('url', input);
  window.history.pushState({}, '', urlParams);

  showSection('loading');

  try {
    setLoading('Fetching BGA page...');
    
    // Download the raw HTML of the BGA page
    const htmlText = await fetchHtmlWithCorsProxy(input);

    setLoading('Parsing assets...');
    
    // Extract g_gamethemeurl
    const inputGameId = (input.match(/[?&]game=([^&#]+)/) || htmlText.match(/g_gamename\s*=\s*['"]([^'"]+)['"]/))?.[1];
    const catalogInfo = inputGameId ? findGameInCatalog(htmlText, inputGameId) : null;
    const catalogDisplayName = catalogInfo?.displayName || null;
    const bgaId = catalogInfo?.id || input.match(/[?&](?:tutorial|table|id)=([0-9]+)/)?.[1] || inputGameId || null;
    let gameThemeUrl;
    const themeUrlMatch = htmlText.match(/g_gamethemeurl\s*=\s*['"]([^'"]+)['"]/);
    if (themeUrlMatch) {
      gameThemeUrl = themeUrlMatch[1]; // e.g. https://x.boardgamearena.net/data/themereleases/current/games/allinpredictions/260506-1558/
    } else {
      // Fallback: BGA sometimes serves the main-site SPA shell (no game globals).
      // It embeds a game catalog JSON: {"id":2450,"name":"reforest","display_name_en":"Reforest","version":"260210-1342",...}
      if (!catalogInfo) {
        throw new Error('Could not find g_gamethemeurl or game version in the page source. This might not be a valid game or tutorial page.');
      }
      gameThemeUrl = `https://x.boardgamearena.net/data/themereleases/current/games/${inputGameId}/${catalogInfo.version}/`;
    }
    
    // Extract g_img_preload
    const preloadMatch = htmlText.match(/g_img_preload\s*=\s*(\[[^\]]+\])/);
    let preloadedImages = [];
    if (preloadMatch) {
      try {
        const matches = preloadMatch[1].match(/['"]([^'"]+)['"]/g);
        if (matches) {
          preloadedImages = matches.map(s => s.slice(1, -1));
        }
      } catch (e) {
        console.warn('Failed to parse g_img_preload array', e);
      }
    }

    // Attempt to extract game name from URL or HTML
    let gameName = 'Unknown Game';
    let gameIdMatch = input.match(/[?&]game=([^&]+)/);
    if (!gameIdMatch) {
        // sometimes it's in the path like /gamepanel?game=... or /3/gamename
        gameIdMatch = htmlText.match(/g_gamename\s*=\s*['"]([^'"]+)['"]/);
    }
    
    if (catalogDisplayName) {
        gameName = catalogDisplayName;
    } else if (gameIdMatch) {
        gameName = gameIdMatch[1];
    } else {
        const titleMatch = htmlText.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) gameName = titleMatch[1].replace(/Board Game Arena|Rules|Play online/gi, '').trim() || 'BGA Game';
    }

    const gameId = (input.match(/[?&]game=([^&]+)/) || htmlText.match(/g_gamename\s*=\s*['"]([^'"]+)['"]/))?.[1];

    allAssets = [];
    
    // Add preloaded images
    preloadedImages.forEach(imgName => {
        allAssets.push({
            url: `${gameThemeUrl}img/${imgName}`,
            field: 'Game Asset',
            type: 'image'
        });
    });

    // Add CSS file as an asset just in case user wants to parse it manually
    const cssMatch = htmlText.match(new RegExp(`href=['"]([^'"]+${gameId}\\.css(\\?.*?)?)['"]`));
    const cssUrl = cssMatch ? cssMatch[1] : `${gameThemeUrl}${gameId}.css`;
    allAssets.push({
        url: cssUrl,
        field: 'CSS (Sprite Map)',
        type: 'css'
    });

    // Parse the game CSS for image references and sprite grids (covers pages without g_img_preload)
    setLoading('Parsing game CSS...');
    bgaCutterData = null;
    try {
        const cssText = await fetchHtmlWithCorsProxy(cssUrl);
        extractCssImageUrls(cssText, cssUrl).forEach(url => {
            allAssets.push({ url, field: 'Game Asset (CSS)', type: 'image' });
        });
        bgaCutterData = extractCssDecks(cssText, cssUrl);
    } catch (e) {
        console.warn('Failed to fetch/parse game CSS', e);
    }

    // Try to add the box image if we know the gameId
    if (gameId) {
        allAssets.unshift({
            url: `https://x.boardgamearena.net/data/gamemedia/${gameId}/box/en_280.png`,
            field: 'Game Box',
            type: 'image'
        });
    }

    // Deduplicate just in case
    const uniqueAssetsMap = new Map();
    allAssets.forEach(a => uniqueAssetsMap.set(a.url, a));
    allAssets = Array.from(uniqueAssetsMap.values());

    currentBgaMeta = { gameName, bgaId, gameId };
    renderResults({ gameName, bgaId, input, thumbUrl: uniqueAssetsMap.get(`https://x.boardgamearena.net/data/gamemedia/${gameId}/box/en_280.png`)?.url });

  } catch (e) {
    console.error(e);
    showError('Failed to load page', e.message);
  }
}

// ─── Parsing Helpers ──────────────────────────────────────────
// Finds a game entry in BGA's embedded catalog JSON and returns its version, id, and display name.
function findGameInCatalog(htmlText, gameId) {
  const esc = gameId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"name"\\s*:\\s*"${esc}"`, 'g');
  let m;
  while ((m = re.exec(htmlText))) {
    const start = Math.max(0, m.index - 80);
    const chunk = htmlText.slice(start, m.index + 400);
    const version = chunk.match(/"version"\s*:\s*"(\d{6}-\d{4})"/);
    if (version) {
      const display = chunk.match(/"display_name_en"\s*:\s*"([^"]*)"/);
      const idMatch = chunk.match(/"id"\s*:\s*(\d+)/);
      return {
        id: idMatch ? idMatch[1] : null,
        version: version[1],
        displayName: display ? display[1] : null
      };
    }
  }
  return null;
}

// Extracts absolute image URLs referenced via url(...) in a CSS file.
function extractCssImageUrls(cssText, cssUrl) {
  const urls = new Set();
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(cssText))) {
    const raw = m[2].trim();
    if (raw.startsWith('data:')) continue;
    if (!/\.(png|jpe?g|gif|webp|svg|bmp)(\?|#|$)/i.test(raw)) continue;
    try { urls.add(new URL(raw, cssUrl).href); } catch {}
  }
  return [...urls];
}

// Parses CSS sprite rules and constructs a CustomDeck-compatible tree for cutter.js.
function extractCssDecks(cssText, cssUrl) {
  const sheets = new Map(); // absUrl -> { xPcts: Set, yPcts: Set, sizeW: number, sizeH: number, typeName: string }
  const typeBacks = new Map(); // typeName -> absBackUrl
  let currentUrl = null;
  let currentType = null;

  const ruleRe = /([^{}]+)\{([^{}]+)\}/g;
  let rm;
  while ((rm = ruleRe.exec(cssText))) {
    const selector = rm[1].trim();
    const body = rm[2];

    const typeMatch = selector.match(/data-type\s*=\s*['"]?([a-z0-9_-]+)['"]?/i);
    const hasArg = /data-type-arg/i.test(selector);

    const urlMatch = body.match(/background(?:-image)?\s*:[^;]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i);
    if (urlMatch) {
      const raw = urlMatch[2].trim();
      if (!raw.startsWith('data:') && /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(raw)) {
        try {
          const absUrl = new URL(raw, cssUrl).href;
          if (typeMatch && !hasArg && (/back/i.test(raw) || /cover|100%/i.test(body))) {
            typeBacks.set(typeMatch[1].toLowerCase(), absUrl);
          }
          currentUrl = absUrl;
          currentType = typeMatch ? typeMatch[1].toLowerCase() : null;
          if (!sheets.has(absUrl)) {
            sheets.set(absUrl, { xPcts: new Set(), yPcts: new Set(), sizeW: 0, sizeH: 0, typeName: currentType });
          } else if (currentType && !sheets.get(absUrl).typeName) {
            sheets.get(absUrl).typeName = currentType;
          }
        } catch {}
      }
    }

    const targetUrl = currentUrl;
    if (!targetUrl || !sheets.has(targetUrl)) continue;
    const info = sheets.get(targetUrl);

    const sizeMatch = body.match(/background-size\s*:\s*([0-9.]+)%?(?:\s+([0-9.]+)%)?/i);
    if (sizeMatch && body.includes('%')) {
      const sw = Math.round(parseFloat(sizeMatch[1]) / 100);
      const sh = sizeMatch[2] ? Math.round(parseFloat(sizeMatch[2]) / 100) : 0;
      if (sw > info.sizeW) info.sizeW = sw;
      if (sh > info.sizeH) info.sizeH = sh;
    }

    const posMatch = body.match(/background-position\s*:\s*([0-9.]+)%?\s+([0-9.]+)%?/i);
    if (posMatch) {
      const x = parseFloat(posMatch[1]);
      const y = parseFloat(posMatch[2]);
      if (!isNaN(x) && x >= 0 && x <= 100) info.xPcts.add(Math.round(x * 100) / 100);
      if (!isNaN(y) && y >= 0 && y <= 100) info.yPcts.add(Math.round(y * 100) / 100);
    }
  }

  function inferGridCount(pcts, sizeCount) {
    if (sizeCount > 1) return sizeCount;
    const sorted = [...pcts].sort((a, b) => a - b);
    if (sorted.length <= 1) return 1;
    let minStep = 100;
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0.5 && d < minStep) minStep = d;
    }
    const steps = Math.round(100 / minStep);
    return Math.max(sorted.length, steps + 1);
  }

  const decks = [];
  let keyIdx = 1;
  for (const [url, info] of sheets.entries()) {
    const numWidth = inferGridCount(info.xPcts, info.sizeW);
    const numHeight = inferGridCount(info.yPcts, info.sizeH);
    if (numWidth * numHeight <= 1) continue; // skip non-sprite single images

    const fileBase = url.split('/').pop().replace(/\.[a-z0-9]+(\?.*)?$/i, '');
    let backUrl = (info.typeName && typeBacks.get(info.typeName)) || '';
    if (!backUrl) {
      // Heuristic: look for a *-back.* asset matching the prefix
      for (const candidate of sheets.keys()) {
        if (/back/i.test(candidate) && candidate !== url) {
          const prefix = fileBase.replace(/-\d+$/, '');
          if (candidate.includes(prefix)) { backUrl = candidate; break; }
        }
      }
    }

    decks.push({
      Nickname: fileBase,
      CustomDeck: {
        [String(keyIdx++)]: {
          FaceURL: url,
          BackURL: backUrl,
          NumWidth: numWidth,
          NumHeight: numHeight,
          UniqueBack: false
        }
      }
    });
  }

  return { ObjectStates: decks };
}

function getBgaZipFilename(suffix) {
  const safeName = (currentBgaMeta.gameName || 'BGA_Game')
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/_+/g, '_')
    .slice(0, 40);
  const idTag = currentBgaMeta.bgaId ? `_[bga${currentBgaMeta.bgaId}]` : '';
  return `${safeName}_${suffix}${idTag}.zip`;
}

// ─── Render Results ───────────────────────────────────────────
function renderResults(meta) {
  document.getElementById('meta-game-name').textContent = meta.gameName;
  document.getElementById('meta-url').innerHTML = `<a href="${meta.input}" target="_blank" style="color:var(--accent-1);text-decoration:none;">${truncate(meta.input, 50)} ↗</a>`;
  
  if (meta.thumbUrl) {
    document.getElementById('meta-thumbnail').src = meta.thumbUrl;
    document.getElementById('meta-thumbnail-wrap').style.display = '';
  } else {
    document.getElementById('meta-thumbnail-wrap').style.display = 'none';
  }

  const imageAssets = allAssets.filter(a => a.type === 'image');
  document.getElementById('meta-total-images').textContent = imageAssets.length;
  document.getElementById('assets-count').textContent = imageAssets.length;

  updateActionBar(imageAssets.length, allAssets.length);
  renderAssets();

  // Initialize cutter if available
  if (typeof initCutter === 'function') initCutter(bgaCutterData);

  showSection('results');
}

// ─── Action Bar Updater ───────────────────────────────────────
function updateActionBar(imageCount, totalCount) {
  const zipCountEl = document.getElementById('zip-count');
  const zipBtn     = document.getElementById('download-zip-btn');
  const zipLabel   = document.getElementById('zip-btn-label');
  const cutZipBtn  = document.getElementById('download-cut-zip-btn');
  if (zipCountEl) zipCountEl.textContent = imageCount;
  if (zipBtn)     zipBtn.disabled = imageCount === 0;
  if (cutZipBtn)  cutZipBtn.disabled = totalCount === 0;
  if (zipLabel)   zipLabel.textContent = imageCount > 0 ? 'Download Images (ZIP)' : 'No images found';

  refreshOpenAllCount();
}

function refreshOpenAllCount() {
  const countEl = document.getElementById('open-all-count');
  const btn = document.getElementById('open-all-btn');
  if (countEl) countEl.textContent = allAssets.length;
  if (btn)     btn.disabled = allAssets.length === 0;
}

// ─── Asset Grid Renderer ──────────────────────────────────────
function typeLabel(type) {
    switch (type) {
      case 'image': return 'IMAGE';
      case 'css': return 'CSS';
      default: return type.toUpperCase();
    }
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, max) {
    return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function renderAssets() {
  const grid = document.getElementById('assets-grid');
  grid.innerHTML = '';
  
  allAssets.forEach((asset, idx) => grid.appendChild(createAssetCard(asset, idx)));

  if (allAssets.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px 0;font-size:14px;">No assets found on this page.</div>`;
  }
}

function createAssetCard(asset, idx) {
  const card   = document.createElement('div');
  card.className = 'asset-card';
  const safeId = `asset-${idx}`;

  const previewHtml = asset.type === 'image'
    ? `<img class="asset-preview" src="${escHtml(asset.url)}" alt="Preview" loading="lazy" onerror="this.style.display='none'" />`
    : '';

  card.innerHTML = `
    <div class="asset-type-bar type-${asset.type}"></div>
    <div class="asset-inner">
      <div class="asset-label">
        <span class="asset-type-badge badge-${asset.type}">${typeLabel(asset.type)}</span>
        <span class="asset-field-name">${escHtml(asset.field)}</span>
      </div>
      ${previewHtml}
      <a class="asset-url" href="${escHtml(asset.url)}" target="_blank" title="${escHtml(asset.url)}">${escHtml(truncate(asset.url, 80))}</a>
      <div class="asset-actions">
        <button class="asset-btn asset-btn-copy" id="${safeId}-copy" onclick="copyUrl(${escHtml(JSON.stringify(asset.url))}, '${safeId}-copy')">
          <svg viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 10V3a1 1 0 0 1 1-1h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Copy
        </button>
        <a class="asset-btn asset-btn-open" href="${escHtml(asset.url)}" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 16 16" fill="none"><path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9M10 2h4v4M7.5 8.5l6-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Open
        </a>
      </div>
    </div>
  `;
  return card;
}

// ─── Actions ──────────────────────────────────────────────────
function openAllFiltered() {
  if (allAssets.length === 0) return;
  if (allAssets.length > 5) {
    const ok = confirm(`Open ${allAssets.length} tabs?\nIf your browser blocks pop-ups, allow them and try again.`);
    if (!ok) return;
  }
  allAssets.forEach((asset, i) => {
    setTimeout(() => { window.open(asset.url, '_blank', 'noopener,noreferrer'); }, i * 80);
  });
  showToast(`Opening ${allAssets.length} tabs...`, 'success');
}

let zipCancelled = false;

async function downloadImagesZip() {
  const images = allAssets.filter(a => a.type === 'image');
  if (images.length === 0) return;

  zipCancelled = false;
  const overlay    = document.getElementById('zip-overlay');
  const statusEl   = document.getElementById('zip-status');
  const fillEl     = document.getElementById('zip-progress-fill');
  const progressEl = document.getElementById('zip-progress-text');
  const zipBtn     = document.getElementById('download-zip-btn');

  overlay.classList.remove('hidden');
  zipBtn.disabled = true;

  const zip     = new JSZip();
  const skipped = [];
  let done = 0;

  const setProgress = (i, total, msg) => {
    const pct = total > 0 ? Math.round((i / total) * 100) : 0;
    fillEl.style.width     = pct + '%';
    progressEl.textContent = `${i} / ${total}`;
    if (msg) statusEl.textContent = msg;
  };

  setProgress(0, images.length, 'Starting download...');

  for (let i = 0; i < images.length; i++) {
    if (zipCancelled) break;

    const asset    = images[i];
    const shortUrl = asset.url.split('/').pop() || `image_${i}`;
    const extMatch = asset.url.match(/\.(png|jpg|jpeg|gif|webp|bmp)(\?|$)/i);
    const fallbackExt = extMatch ? extMatch[1].toLowerCase() : 'png';
    const baseName = shortUrl.replace(/\.(png|jpg|jpeg|gif|webp|bmp)(\?.*)?$/i, '').slice(0, 40).replace(/[^\p{L}\p{N}_-]/gu, '_');
    const baseFilename = `${String(i + 1).padStart(3, '0')}_${baseName}`;

    setProgress(i, images.length, `Downloading: ${shortUrl} (${i + 1}/${images.length})`);

    try {
      let blob = null;
      const candidates = [asset.url, ...CORS_PROXIES.map(p => p.url(asset.url))];
      for (const tryUrl of candidates) {
        if (zipCancelled) break;
        try {
          const res = await fetch(tryUrl, { signal: AbortSignal.timeout(15000) });
          if (res.ok) { blob = await res.blob(); break; }
        } catch {}
      }

      if (blob && blob.size > 0) {
        const buffer = await blob.arrayBuffer();
        const view = new Uint8Array(buffer.slice(0, 12));
        let realExt = fallbackExt;
        
        if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) realExt = 'png';
        else if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) realExt = 'jpg';
        else if (view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46) realExt = 'pdf';
        else if (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) realExt = 'mp3';
        else if (view[0] === 0x55 && view[1] === 0x6E && view[2] === 0x69 && view[3] === 0x74 && view[4] === 0x79) realExt = 'unity3d';
        else if (view[0] === 0x4F && view[1] === 0x67 && view[2] === 0x67 && view[3] === 0x53) realExt = 'ogg';
        else if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46) {
          if (view.length >= 12 && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) realExt = 'webp';
          else realExt = 'wav';
        }
        else {
          const str = String.fromCharCode(...view.slice(0, 10));
          if (str.startsWith('v ') || str.startsWith('# ') || str.startsWith('vt ') || str.startsWith('vn ') || str.includes('mtllib')) realExt = 'obj';
        }

        zip.file(`${baseFilename}.${realExt}`, blob);
        done++;
      } else {
        skipped.push({ url: asset.url, reason: 'Fetch failed (CORS blocked)' });
      }
    } catch (e) {
      skipped.push({ url: asset.url, reason: e.message });
    }

    setProgress(i + 1, images.length);
  }

  if (zipCancelled) {
    overlay.classList.add('hidden');
    zipBtn.disabled = false;
    showToast('Download cancelled', 'error');
    return;
  }

  if (done === 0) {
    overlay.classList.add('hidden');
    zipBtn.disabled = false;
    showToast('Could not download any images (CORS?). Use "Open All" instead.', 'error');
    return;
  }

  const manifest = [
    'BGA Extractor — Image Manifest',
    '==========================================',
    `Total images : ${images.length}`,
    `Downloaded   : ${done}`,
    `Skipped      : ${skipped.length}`,
    '',
    ...images.filter(a => !skipped.some(s => s.url === a.url)).map(a => `[OK] ${a.url}`),
    ...skipped.map(s => `[SKIP] ${s.url}  // ${s.reason}`)
  ];
  zip.file('manifest.txt', manifest.join('\n'));

  statusEl.textContent = 'Generating ZIP file...';
  fillEl.style.width = '100%';

  try {
    const zipBlob  = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a        = document.createElement('a');
    a.href         = URL.createObjectURL(zipBlob);
    a.download     = getBgaZipFilename('images');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    overlay.classList.add('hidden');
    zipBtn.disabled = false;
    showToast(`Saved ${done} images to ZIP`, 'success');
  } catch (e) {
    overlay.classList.add('hidden');
    zipBtn.disabled = false;
    showToast('ZIP generation error: ' + e.message, 'error');
  }
}

async function downloadCutAndOthersZip() {
  if (allAssets.length === 0) return;

  zipCancelled = false;
  const overlay    = document.getElementById('zip-overlay');
  const statusEl   = document.getElementById('zip-status');
  const fillEl     = document.getElementById('zip-progress-fill');
  const progressEl = document.getElementById('zip-progress-text');
  const zipBtn     = document.getElementById('download-zip-btn');
  const cutZipBtn  = document.getElementById('download-cut-zip-btn');

  overlay.classList.remove('hidden');
  if (zipBtn)    zipBtn.disabled = true;
  if (cutZipBtn) cutZipBtn.disabled = true;

  const zip = new JSZip();
  const skipped = [];
  let totalCards = 0;
  let failedDecks = 0;
  let otherDone = 0;

  const setProgress = (i, total, msg) => {
    const pct = total > 0 ? Math.round((i / total) * 100) : 0;
    fillEl.style.width     = pct + '%';
    progressEl.textContent = total > 0 ? `${i} / ${total}` : '';
    if (msg) statusEl.textContent = msg;
  };

  const decks = typeof cutterDecks !== 'undefined' ? cutterDecks : [];
  const deckUrls = new Set();
  decks.forEach(d => {
    if (d.faceUrl) deckUrls.add(d.faceUrl);
    if (d.backUrl) deckUrls.add(d.backUrl);
  });

  // 1. Cut all detected sprite decks
  const nameCounts = new Map();
  for (let dIdx = 0; dIdx < decks.length; dIdx++) {
    if (zipCancelled) break;
    const deck = decks[dIdx];
    const rawName = deck.deckName || `deck_${deck.deckKey}`;
    let safeName = rawName.replace(/[^\p{L}\p{N}_\-]/gu, '_').replace(/_+/g, '_').slice(0, 40);
    const count = (nameCounts.get(safeName) || 0) + 1;
    nameCounts.set(safeName, count);
    if (count > 1) safeName = `${safeName}(${count})`;

    setProgress(dIdx, decks.length, `Cutting deck: ${rawName} (${dIdx + 1}/${decks.length})`);

    try {
      let faceBlob = null;
      const candidates = [deck.faceUrl, ...CORS_PROXIES.map(p => p.url(deck.faceUrl))];
      for (const tryUrl of candidates) {
        if (zipCancelled) break;
        try {
          const res = await fetch(tryUrl, { signal: AbortSignal.timeout(15000) });
          if (res.ok) { faceBlob = await res.blob(); break; }
        } catch {}
      }
      if (!faceBlob) throw new Error('Failed to fetch face sheet');

      const faceSuffix = (deck.backUrl && deck.backUrl === deck.faceUrl) ? 'back_face' : 'face';
      const faceCards = await sliceImageToCards(faceBlob, deck);
      for (const { canvas, index } of faceCards) {
        if (zipCancelled) break;
        zip.file(`${safeName}_${String(index + 1).padStart(3, '0')}_${faceSuffix}.png`, await canvasToBlob(canvas));
        totalCards++;
      }

      if (deck.backUrl && deck.backUrl !== deck.faceUrl && !zipCancelled) {
        setProgress(dIdx, decks.length, `Adding back: ${rawName}…`);
        let backBlob = null;
        const backCandidates = [deck.backUrl, ...CORS_PROXIES.map(p => p.url(deck.backUrl))];
        for (const tryUrl of backCandidates) {
          if (zipCancelled) break;
          try {
            const res = await fetch(tryUrl, { signal: AbortSignal.timeout(15000) });
            if (res.ok) { backBlob = await res.blob(); break; }
          } catch {}
        }
        if (backBlob) {
          if (deck.totalSlots === 1 || !deck.uniqueBack) {
            const ext = await getRealExtension(backBlob, deck.backUrl);
            zip.file(`${safeName}_back.${ext}`, backBlob);
            totalCards++;
          } else {
            const backCards = await sliceImageToCards(backBlob, deck);
            for (const { canvas, index } of backCards) {
              if (zipCancelled) break;
              zip.file(`${safeName}_${String(index + 1).padStart(3, '0')}_back.png`, await canvasToBlob(canvas));
              totalCards++;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to cut deck ${deck.deckKey}:`, e);
      failedDecks++;
      // If cutting failed, allow its raw URLs to be downloaded in otherFiles
      if (deck.faceUrl) deckUrls.delete(deck.faceUrl);
      if (deck.backUrl) deckUrls.delete(deck.backUrl);
    }
  }

  // 2. Download all remaining files (images + CSS) not part of cut decks
  const otherFiles = allAssets.filter(a => !deckUrls.has(a.url));
  for (let i = 0; i < otherFiles.length; i++) {
    if (zipCancelled) break;
    const asset    = otherFiles[i];
    const shortUrl = asset.url.split('/').pop() || `file_${i}`;
    const extMatch = asset.url.match(/\.([a-z0-9]{2,7})(\?|$)/i);
    const fallbackExt = extMatch ? extMatch[1].toLowerCase() : (asset.type === 'css' ? 'css' : 'png');
    const baseName = shortUrl.replace(/\.[a-z0-9]{2,7}(\?.*)?$/i, '').slice(0, 40).replace(/[^\p{L}\p{N}_-]/gu, '_');
    const baseFilename = `other_${String(i + 1).padStart(3, '0')}_${baseName}`;

    setProgress(i, otherFiles.length, `Downloading: ${shortUrl} (${i + 1}/${otherFiles.length})`);

    try {
      let blob = null;
      const candidates = [asset.url, ...CORS_PROXIES.map(p => p.url(asset.url))];
      for (const tryUrl of candidates) {
        if (zipCancelled) break;
        try {
          const res = await fetch(tryUrl, { signal: AbortSignal.timeout(15000) });
          if (res.ok) { blob = await res.blob(); break; }
        } catch {}
      }

      if (blob && blob.size > 0) {
        let realExt = fallbackExt;
        if (asset.type !== 'css') {
          const buffer = await blob.arrayBuffer();
          const view = new Uint8Array(buffer.slice(0, 12));
          if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) realExt = 'png';
          else if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) realExt = 'jpg';
          else if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
                   view.length >= 12 && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) realExt = 'webp';
        }
        zip.file(`${baseFilename}.${realExt}`, blob);
        otherDone++;
      } else {
        skipped.push({ url: asset.url, reason: 'Fetch failed (CORS blocked)' });
      }
    } catch (e) {
      skipped.push({ url: asset.url, reason: e.message });
    }

    setProgress(i + 1, otherFiles.length);
  }

  const restoreBtns = () => {
    overlay.classList.add('hidden');
    if (zipBtn)    zipBtn.disabled = false;
    if (cutZipBtn) cutZipBtn.disabled = false;
  };

  if (zipCancelled) {
    restoreBtns();
    showToast('Download cancelled', 'error');
    return;
  }

  if (totalCards === 0 && otherDone === 0) {
    restoreBtns();
    showToast('Could not download any files (CORS?).', 'error');
    return;
  }

  const manifest = [
    'BGA Extractor — Cut Decks & Other Files Manifest',
    '================================================',
    `Total cut cards   : ${totalCards}`,
    `Decks cut         : ${decks.length - failedDecks} / ${decks.length}`,
    `Other files saved : ${otherDone} / ${otherFiles.length}`,
    `Skipped           : ${skipped.length}`,
    '',
    '--- Cut Decks ---',
    ...decks.map(d => `[${d.deckName} (${d.numWidth}x${d.numHeight})] Face: ${d.faceUrl}${d.backUrl ? ' | Back: ' + d.backUrl : ''}`),
    '',
    '--- Other Files ---',
    ...otherFiles.filter(a => !skipped.some(s => s.url === a.url)).map(a => `[OK] ${a.url}`),
    ...skipped.map(s => `[SKIP] ${s.url}  // ${s.reason}`)
  ];
  zip.file('manifest.txt', manifest.join('\n'));

  statusEl.textContent = 'Generating ZIP file...';
  fillEl.style.width = '100%';

  try {
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a       = document.createElement('a');
    a.href        = URL.createObjectURL(zipBlob);
    a.download    = getBgaZipFilename('cut_and_others');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    restoreBtns();
    showToast(`Saved ${totalCards} cut cards & ${otherDone} other files to ZIP`, 'success');
  } catch (e) {
    restoreBtns();
    showToast('ZIP generation error: ' + e.message, 'error');
  }
}

function cancelZipDownload() {
  zipCancelled = true;
}

// ─── UI Helpers ───────────────────────────────────────────────
function showSection(name) {
  ['input', 'loading', 'error', 'results'].forEach(s => {
    const el = document.getElementById(`${s}-section`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function setLoading(msg) {
  document.getElementById('loading-message').textContent = msg;
}

function showError(title, msg) {
  document.getElementById('error-title').textContent   = title;
  document.getElementById('error-message').textContent = msg;
  showSection('error');
}

function resetToInput() {
  showSection('input');
  allAssets = [];
}

function clearInput() {
  document.getElementById('url-input').value = '';
  document.getElementById('url-input').focus();
}

async function copyAllUrls() {
  try {
    const text = allAssets.map(a => a.url).join('\n');
    await navigator.clipboard.writeText(text);
    showToast('All URLs copied to clipboard!', 'success');
  } catch {
    showToast('Could not copy to clipboard', 'error');
  }
}

async function copyUrl(url, btnId) {
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById(btnId);
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Copied';
      btn.style.color = 'var(--accent-3)';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 1500);
    }
  } catch {}
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  // Simple toast styles since we don't have them cleanly separated
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%) translateY(20px)',
    background: type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#3b82f6'),
    color: '#fff', padding: '10px 20px', borderRadius: '8px', fontSize: '14px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: '9999',
    opacity: '0', transition: 'all 0.3s ease'
  });

  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Initialization ───────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const targetUrl = params.get('url');
  if (targetUrl) {
    document.getElementById('url-input').value = targetUrl;
    fetchFromUrl();
  }
});
