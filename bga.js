// ============================================================
// BGA Extractor – Main Application
// Parses Board Game Arena HTML to extract game assets
// ============================================================

'use strict';

// ─── State ───────────────────────────────────────────────────
let allAssets = [];

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

  showSection('loading');

  try {
    setLoading('Fetching BGA page...');
    
    // Download the raw HTML of the BGA page
    const htmlText = await fetchHtmlWithCorsProxy(input);

    setLoading('Parsing assets...');
    
    // Extract g_gamethemeurl
    const themeUrlMatch = htmlText.match(/g_gamethemeurl\s*=\s*['"]([^'"]+)['"]/);
    if (!themeUrlMatch) {
      throw new Error('Could not find g_gamethemeurl in the page source. This might not be a valid game or tutorial page.');
    }
    const gameThemeUrl = themeUrlMatch[1]; // e.g. https://x.boardgamearena.net/data/themereleases/current/games/allinpredictions/260506-1558/
    
    // Extract g_img_preload
    const preloadMatch = htmlText.match(/g_img_preload\s*=\s*(\[[^\]]+\])/);
    let preloadedImages = [];
    if (preloadMatch) {
      try {
        preloadedImages = JSON.parse(preloadMatch[1]);
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
    
    if (gameIdMatch) {
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
    if (cssMatch) {
        allAssets.push({
            url: cssMatch[1],
            field: 'CSS (Sprite Map)',
            type: 'css'
        });
    } else {
        allAssets.push({
            url: `${gameThemeUrl}${gameId}.css`,
            field: 'CSS (Sprite Map)',
            type: 'css'
        });
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

    renderResults({ gameName, input, thumbUrl: uniqueAssetsMap.get(`https://x.boardgamearena.net/data/gamemedia/${gameId}/box/en_280.png`)?.url });

  } catch (e) {
    console.error(e);
    showError('Failed to load page', e.message);
  }
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
  if (typeof initCutter === 'function') initCutter();

  showSection('results');
}

// ─── Action Bar Updater ───────────────────────────────────────
function updateActionBar(imageCount, totalCount) {
  const zipCountEl = document.getElementById('zip-count');
  const zipBtn     = document.getElementById('download-zip-btn');
  const zipLabel   = document.getElementById('zip-btn-label');
  if (zipCountEl) zipCountEl.textContent = imageCount;
  if (zipBtn)     zipBtn.disabled = imageCount === 0;
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
    const ext      = extMatch ? extMatch[1].toLowerCase() : 'png';
    const filename = `${String(i + 1).padStart(3, '0')}_${shortUrl.slice(0, 40).replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;

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
        zip.file(filename, blob);
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
    a.download     = `BGA_Assets.zip`;
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
