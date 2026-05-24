// ============================================================
// Steam Workshop Extractor – Main Application
// Parses Tabletop Simulator BSON WorkshopUpload files
// ============================================================

'use strict';

// ─── State ───────────────────────────────────────────────────
let currentData = null;
let currentBuffer = null; // Original binary buffer (BSON)
let allAssets = [];
let activeFilter = 'all';

// ─── BSON Parser ─────────────────────────────────────────────
// Lightweight BSON deserializer – avoids depending on external CDN.
// Spec reference: http://bsonspec.org/spec.html

function parseBSON(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  function readInt32(offset) {
    return view.getInt32(offset, true); // little-endian
  }

  function readDouble(offset) {
    return view.getFloat64(offset, true);
  }

  function readCString(offset) {
    let end = offset;
    while (bytes[end] !== 0) end++;
    return { str: new TextDecoder('utf-8').decode(bytes.slice(offset, end)), next: end + 1 };
  }

  function readString(offset) {
    const len = readInt32(offset);
    const str = new TextDecoder('utf-8').decode(bytes.slice(offset + 4, offset + 4 + len - 1));
    return { str, next: offset + 4 + len };
  }

  function readDocument(offset) {
    const docSize = readInt32(offset);
    const end = offset + docSize;
    const result = {};
    let pos = offset + 4;

    while (pos < end - 1) {
      const typeCode = bytes[pos];
      pos++;

      const keyRes = readCString(pos);
      pos = keyRes.next;
      const key = keyRes.str;

      switch (typeCode) {
        case 0x01: { // Double (float64)
          result[key] = readDouble(pos);
          pos += 8;
          break;
        }
        case 0x02: { // UTF-8 string
          const s = readString(pos);
          result[key] = s.str;
          pos = s.next;
          break;
        }
        case 0x03: { // Embedded document
          const subDoc = readDocument(pos);
          result[key] = subDoc.value;
          pos = subDoc.next;
          break;
        }
        case 0x04: { // Array (stored as document with numeric keys)
          const arr = readDocument(pos);
          result[key] = Object.values(arr.value);
          pos = arr.next;
          break;
        }
        case 0x05: { // Binary data
          const binLen = readInt32(pos);
          result[key] = { _binary: true, length: binLen };
          pos += 5 + binLen;
          break;
        }
        case 0x07: { // ObjectId (12 bytes)
          result[key] = { _oid: Array.from(bytes.slice(pos, pos + 12)).map(b => b.toString(16).padStart(2,'0')).join('') };
          pos += 12;
          break;
        }
        case 0x08: { // Boolean
          result[key] = bytes[pos] === 1;
          pos++;
          break;
        }
        case 0x09: { // UTC datetime (int64 milliseconds)
          result[key] = new Date(Number(view.getBigInt64(pos, true)));
          pos += 8;
          break;
        }
        case 0x0A: { // Null
          result[key] = null;
          break;
        }
        case 0x10: { // Int32
          result[key] = readInt32(pos);
          pos += 4;
          break;
        }
        case 0x12: { // Int64
          result[key] = Number(view.getBigInt64(pos, true));
          pos += 8;
          break;
        }
        default: {
          // Unknown type – cannot safely continue parsing this document
          console.warn(`Unknown BSON type 0x${typeCode.toString(16)} for key "${key}" at offset ${pos}`);
          return { value: result, next: end };
        }
      }
    }

    return { value: result, next: end };
  }

  try {
    return readDocument(0).value;
  } catch (e) {
    throw new Error(`BSON parse error: ${e.message}`);
  }
}

// ─── URL Classification ───────────────────────────────────────
const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp|tga|tiff|svg)(\?|$)/i;
const MODEL_EXTS = /\.(obj|fbx|dae|gltf|glb|blend|3ds|stl)(\?|$)/i;
const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|aac|m4a)(\?|$)/i;

function classifyUrl(url) {
  if (IMAGE_EXTS.test(url)) return 'image';
  if (MODEL_EXTS.test(url)) return 'model';
  if (AUDIO_EXTS.test(url)) return 'audio';
  // Steam CDN UGC paths are always images (card faces, textures, etc.) even without an extension
  if (/steamusercontent\.com\/ugc\//i.test(url)) return 'image';
  if (/steamusercontent-a\.akamaihd\.net\/ugc\//i.test(url)) return 'image';
  if (/steamuserimages\.akamaized\.net/i.test(url)) return 'image';
  if (url.startsWith('http')) return 'url';
  return 'other';
}

// ─── Steam URL Updater ──────────────────────────────────────────
function fixSteamUrls(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/http:\/\/cloud-3\.steamusercontent\.com\//gi, 'https://steamusercontent-a.akamaihd.net/');
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = fixSteamUrls(obj[i]);
    }
    return obj;
  }
  if (obj && typeof obj === 'object' && !obj._binary && !obj._oid && !(obj instanceof Date)) {
    for (const key in obj) {
      if (Object.hasOwn(obj, key)) {
        obj[key] = fixSteamUrls(obj[key]);
      }
    }
  }
  return obj;
}

// ─── URL Extractor ────────────────────────────────────────────
// Recursively walks the parsed BSON tree and collects all URLs.
const URL_FIELDS = new Set([
  'ImageURL', 'DiffuseURL', 'NormalURL', 'ColliderURL', 'MeshURL',
  'Face', 'Back', 'TableURL', 'SkyURL', 'NotepadURL',
  'AssetURL', 'CustomURL', 'FaceURL', 'BackURL'
]);

// Fields injected internally by this app – must not appear in asset list
const INTERNAL_FIELDS = new Set(['_previewUrl', '_workshopUrl', '_workshopId', '_localFile', '_workshopTitle']);

function extractUrls(obj, parentKey, collected) {
  if (typeof obj === 'string') {
    if (obj.startsWith('http://') || obj.startsWith('https://')) {
      const key = parentKey || 'URL';
      if (INTERNAL_FIELDS.has(key)) return; // skip internal metadata fields
      if (!collected.has(obj)) {
        collected.set(obj, { url: obj, field: key, type: classifyUrl(obj) });
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach(item => extractUrls(item, parentKey, collected));
    return;
  }
  if (obj && typeof obj === 'object' && !obj._binary && !obj._oid && !(obj instanceof Date)) {
    for (const [k, v] of Object.entries(obj)) {
      if (INTERNAL_FIELDS.has(k)) continue; // skip internal keys entirely
      extractUrls(v, k, collected);
    }
  }
}

function getAssets(data) {
  const collected = new Map();
  extractUrls(data, null, collected);
  return Array.from(collected.values());
}

// ─── Metadata Extractor ───────────────────────────────────────
function extractMeta(data) {
  const saveName = data.SaveName;
  const isBlank = !saveName || saveName === 'None';
  return {
    // Prefer SaveName if meaningful, fall back to Steam workshop title or game mode
    gameName: !isBlank ? saveName : (data._workshopTitle || data.GameMode || '—'),
    version:  data.VersionNumber || data.Version || '—',
    date:     data.Date || (data.EpochTime ? new Date(data.EpochTime * 1000).toLocaleString('en-US') : '—'),
    gameMode: data.GameMode || '—',
  };
}

// ─── CORS-aware Fetcher ───────────────────────────────────────
// Steam API blocks browser requests directly; we fall back to public proxies.
// Steam API blocks browser requests directly.
// On Netlify, we use a native proxy redirect (see netlify.toml).
// Locally, we fall back to several public CORS proxies.
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://corsproxy.org/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function fetchWithCorsProxy(url) {
  // Try direct fetch first
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return res;
  } catch {}

  // Fall back to each CORS proxy
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy(url));
      if (res.ok) return res;
    } catch {}
  }
  throw new Error(`Failed to fetch URL: ${url}`);
}

async function getWorkshopFileUrl(workshopId) {
  setLoading('Fetching info from Steam API...');
  const apiUrl = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
  const body = new URLSearchParams({ itemcount: 1, 'publishedfileids[0]': workshopId });

  let data;
  // Sequence of attempts:
  // 1. Internal Netlify proxy (path defined in netlify.toml)
  // 2. Direct Steam API (usually fails in browser due to CORS)
  // 3. Various public CORS proxies
  const internalProxy = '/steam-api/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
  const attempts = [internalProxy, apiUrl, ...CORS_PROXIES.map(p => p(apiUrl))];

  for (const fetchUrl of attempts) {
    try {
      const res = await fetch(fetchUrl, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.ok) { data = await res.json(); break; }
    } catch {}
  }

  if (!data) {
    throw new Error('Could not reach Steam API. Try uploading the WorkshopUpload file manually.');
  }

  const fileInfo = data?.response?.publishedfiledetails?.[0];
  if (!fileInfo) throw new Error('Steam API returned no file info for this mod.');
  if (fileInfo.result !== 1) throw new Error(`Steam API error (result=${fileInfo.result}). The ID may be wrong or the mod private.`);

  const fileUrl = fileInfo.file_url;
  if (!fileUrl) throw new Error('Steam API did not provide a download URL. The mod may not have a direct file link.');

  return { fileUrl, workshopInfo: fileInfo };
}

// ─── Workshop ID Parser ───────────────────────────────────────
function extractWorkshopId(input) {
  input = input.trim();
  if (/^\d{5,}$/.test(input)) return input;                  // bare numeric ID
  const match = input.match(/[?&]id=(\d+)/);
  if (match) return match[1];                                 // ?id=XXXXX query param
  const match2 = input.match(/\/(\d{5,})\/?$/);
  if (match2) return match2[1];                              // trailing /XXXXX
  return null;
}

// ─── Main Flow: Fetch from URL ────────────────────────────────
async function fetchFromUrl() {
  const input = document.getElementById('url-input').value.trim();
  if (!input) { showToast('Enter a Workshop URL or ID', 'error'); return; }

  const workshopId = extractWorkshopId(input);
  if (!workshopId) {
    showToast('Could not detect a Workshop ID in the input', 'error');
    return;
  }

  showSection('loading');

  // Update URL with the workshop ID for persistence/sharing
  const url = new URL(window.location);
  url.searchParams.set('id', workshopId);
  window.history.pushState({}, '', url);

  try {
    // Step 1: resolve the download URL via Steam API
    const { fileUrl, workshopInfo } = await getWorkshopFileUrl(workshopId);

    setLoading('Downloading WorkshopUpload file...');

    // Step 2: download the BSON binary
    const res = await fetchWithCorsProxy(fileUrl);
    currentBuffer = await res.arrayBuffer();

    setLoading('Parsing BSON...');
    let bsonData = parseBSON(currentBuffer);
    bsonData = fixSteamUrls(bsonData);

    // Enrich parsed data with workshop metadata (kept in internal fields)
    if (workshopInfo) {
      if (workshopInfo.title)       bsonData._workshopTitle = workshopInfo.title;
      if (workshopInfo.preview_url) bsonData._previewUrl    = workshopInfo.preview_url;
      bsonData._workshopId  = workshopId;
      bsonData._workshopUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${workshopId}`;
    }

    renderResults(bsonData, workshopId);

  } catch (e) {
    console.error(e);
    showError('Failed to load mod', e.message);
  }
}

// ─── Main Flow: Local File ────────────────────────────────────
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) processFile(file);
}

function handleDragOver(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
}

function handleDragLeave() {
  document.getElementById('drop-zone').classList.remove('drag-over');
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) processFile(file);
}

async function processFile(file) {
  showSection('loading');
  setLoading(`Reading "${file.name}"...`);

  try {
    const buffer = await file.arrayBuffer();
    let bsonData;

    if (file.name.toLowerCase().endsWith('.json')) {
      setLoading('Parsing JSON...');
      const text = new TextDecoder('utf-8').decode(buffer);
      bsonData = fixSteamUrls(JSON.parse(text));
      currentBuffer = null; // No BSON buffer for JSON files
    } else if (file.name.toLowerCase().endsWith('.ttsmod')) {
      setLoading('Unpacking .ttsmod...');
      const jszip = new JSZip();
      const zip = await jszip.loadAsync(buffer);
      let jsonFile = null;
      for (const [filename, fileData] of Object.entries(zip.files)) {
        if (!fileData.dir && filename.toLowerCase().endsWith('.json')) {
          jsonFile = fileData;
          break;
        }
      }
      if (!jsonFile) {
        throw new Error('No .json configuration file found inside this .ttsmod archive.');
      }
      setLoading('Parsing JSON from .ttsmod...');
      const text = await jsonFile.async('string');
      bsonData = fixSteamUrls(JSON.parse(text));
      currentBuffer = null;
    } else {
      setLoading('Parsing BSON...');
      bsonData = fixSteamUrls(parseBSON(buffer));
      currentBuffer = buffer; // Store original BSON
    }

    bsonData._localFile = file.name;
    renderResults(bsonData, null);
  } catch (e) {
    console.error(e);
    showError('File read error', e.message + '\n\nMake sure this is a WorkshopUpload BSON, JSON, or .ttsmod file.');
  }
}

// ─── Render Results ───────────────────────────────────────────
function renderResults(data, workshopId) {
  currentData = data;

  const meta = extractMeta(data);
  allAssets = getAssets(data);

  // Populate metadata card
  document.getElementById('meta-game-name').textContent = meta.gameName;
  document.getElementById('meta-version').textContent   = meta.version;
  document.getElementById('meta-date').textContent      = meta.date;
  document.getElementById('meta-mode').textContent      = meta.gameMode;
  document.getElementById('meta-workshop-id').textContent =
    workshopId || data._workshopId || '—';

  // Thumbnail (preview image from Steam API or table background)
  const thumb = data._previewUrl || data.TableURL || null;
  if (thumb) {
    document.getElementById('meta-thumbnail').src = thumb;
    document.getElementById('meta-thumbnail-wrap').style.display = '';
  } else {
    document.getElementById('meta-thumbnail-wrap').style.display = 'none';
  }

  // Clickable Workshop ID link
  if (workshopId || data._workshopId) {
    const id = workshopId || data._workshopId;
    document.getElementById('meta-workshop-id').innerHTML =
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${id}" target="_blank" style="color:var(--accent-2);text-decoration:none;">${id} ↗</a>`;
  }

  // Update asset counts and action-bar buttons
  const imageAssets = allAssets.filter(a => a.type === 'image');
  document.getElementById('assets-count').textContent = allAssets.length;
  updateActionBar(imageAssets.length, allAssets.length);

  activeFilter = 'all';
  renderFilters();
  renderAssets('all');

  // Populate raw JSON viewer
  document.getElementById('raw-data').textContent = JSON.stringify(data, (k, v) => {
    if (v instanceof Date) return v.toISOString();
    return v;
  }, 2);

  // Initialize Card Sheet Cutter with the parsed mod data
  if (typeof initCutter === 'function') initCutter(data);

  // Show/hide Save BSON button
  const saveBsonBtn = document.getElementById('save-bson-btn');
  if (saveBsonBtn) {
    saveBsonBtn.style.display = currentBuffer ? '' : 'none';
  }

  showSection('results');
}

// ─── Action Bar Updater ───────────────────────────────────────
function updateActionBar(imageCount, totalCount) {
  // ZIP button
  const zipCountEl = document.getElementById('zip-count');
  const zipBtn     = document.getElementById('download-zip-btn');
  const zipLabel   = document.getElementById('zip-btn-label');
  if (zipCountEl) zipCountEl.textContent = imageCount;
  if (zipBtn)     zipBtn.disabled = imageCount === 0;
  if (zipLabel)   zipLabel.textContent = imageCount > 0 ? 'Download Images (ZIP)' : 'No images found';

  // Open-all button (shows count for current filter)
  refreshOpenAllCount();
}

// Update the "Open All in Tabs" counter to match the active filter
function refreshOpenAllCount() {
  const filtered = activeFilter === 'all'
    ? allAssets
    : allAssets.filter(a => a.type === activeFilter);
  const countEl = document.getElementById('open-all-count');
  const btn = document.getElementById('open-all-btn');
  if (countEl) countEl.textContent = filtered.length;
  if (btn)     btn.disabled = filtered.length === 0;
}

// ─── Filter Renderer ─────────────────────────────────────────
function renderFilters() {
  const types     = ['all', ...new Set(allAssets.map(a => a.type))];
  const container = document.getElementById('assets-filters');
  container.innerHTML = '';

  const counts = { all: allAssets.length };
  allAssets.forEach(a => { counts[a.type] = (counts[a.type] || 0) + 1; });

  types.forEach(type => {
    const btn = document.createElement('button');
    btn.className = `filter-btn ${type === 'all' ? 'active' : ''}`;
    btn.id        = `filter-${type}`;
    btn.textContent = `${typeLabel(type)} (${counts[type] || 0})`;
    btn.onclick = () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = type;
      renderAssets(type);
      refreshOpenAllCount(); // keep "Open All" badge in sync with filter
    };
    container.appendChild(btn);
  });
}

// ─── Asset Grid Renderer ──────────────────────────────────────
function renderAssets(filter) {
  const grid     = document.getElementById('assets-grid');
  const filtered = filter === 'all' ? allAssets : allAssets.filter(a => a.type === filter);

  grid.innerHTML = '';
  filtered.forEach((asset, idx) => grid.appendChild(createAssetCard(asset, idx)));

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px 0;font-size:14px;">No assets of this type found</div>`;
  }
}

function createAssetCard(asset, idx) {
  const card   = document.createElement('div');
  card.className = 'asset-card';
  const safeId = `asset-${idx}`;

  // Show inline image preview for image-type assets
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

// ─── Open All Filtered URLs in Tabs ──────────────────────────
function openAllFiltered() {
  const filtered = activeFilter === 'all'
    ? allAssets
    : allAssets.filter(a => a.type === activeFilter);

  if (filtered.length === 0) {
    showToast('No assets to open', 'error');
    return;
  }

  // Warn user if opening many tabs – and offer to proceed anyway
  if (filtered.length > 5) {
    const ok = confirm(
      `Open ${filtered.length} tabs?\n\n` +
      `If your browser blocks pop-ups for this site, allow them and try again.`
    );
    if (!ok) return;
  }

  // Open each URL in a new tab with a small delay to avoid popup blockers
  filtered.forEach((asset, i) => {
    setTimeout(() => {
      window.open(asset.url, '_blank', 'noopener,noreferrer');
    }, i * 80);
  });

  const label = activeFilter === 'all' ? 'all assets' : `${typeLabel(activeFilter)} assets`;
  showToast(`Opening ${filtered.length} ${label} in new tabs…`, 'success');
}

// ─── ZIP Image Downloader ─────────────────────────────────────
let zipCancelled = false;

async function downloadImagesZip() {
  const images = allAssets.filter(a => a.type === 'image');
  if (images.length === 0) {
    showToast('No images found in assets', 'error');
    return;
  }

  zipCancelled = false;
  const overlay    = document.getElementById('zip-overlay');
  const statusEl   = document.getElementById('zip-status');
  const fillEl     = document.getElementById('zip-progress-fill');
  const progressEl = document.getElementById('zip-progress-text');
  const zipBtn     = document.getElementById('download-zip-btn');

  overlay.classList.remove('hidden');
  zipBtn.disabled = true;

  const zip     = new JSZip();  // eslint-ignore – JSZip loaded via CDN
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
    const ext      = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const filename = `${String(i + 1).padStart(3, '0')}_${asset.field}_${shortUrl.slice(0, 40).replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;

    setProgress(i, images.length, `Downloading: ${asset.field} (${i + 1}/${images.length})`);

    try {
      let blob = null;
      // Try direct, then each CORS proxy
      const candidates = [asset.url, ...CORS_PROXIES.map(p => p(asset.url))];
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
        skipped.push({ field: asset.field, url: asset.url, reason: 'Fetch failed (CORS blocked)' });
      }
    } catch (e) {
      skipped.push({ field: asset.field, url: asset.url, reason: e.message });
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
    showToast('Could not download any images (CORS?). Use "Open All in Tabs" instead.', 'error');
    return;
  }

  // Append a manifest listing all URLs, including skipped ones
  const manifest = [
    'Steam Workshop Extractor — Image Manifest',
    '==========================================',
    `Total images : ${images.length}`,
    `Downloaded   : ${done}`,
    `Skipped      : ${skipped.length}`,
    '',
    '--- Downloaded ---',
    ...images
      .filter(a => !skipped.some(s => s.url === a.url))
      .map(a => `[${a.field}] ${a.url}`),
    '',
    '--- Skipped (open these manually) ---',
    ...skipped.map(s => `[${s.field}] ${s.url}  // ${s.reason}`),
  ];
  zip.file('manifest.txt', manifest.join('\n'));

  statusEl.textContent = 'Generating ZIP file...';
  fillEl.style.width = '100%';

  try {
    const modName  = (currentData?.SaveName || currentData?._workshopTitle || 'workshop')
      .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const zipBlob  = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a        = document.createElement('a');
    a.href         = URL.createObjectURL(zipBlob);
    a.download     = `${modName}_images.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    overlay.classList.add('hidden');
    zipBtn.disabled = false;

    showToast(
      skipped.length > 0
        ? `Saved ${done} image(s) (${skipped.length} skipped)`
        : `Saved ${done} image(s) to ZIP`,
      'success'
    );
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
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`panel-${tab}`).classList.add('active');
}

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
  currentData  = null;
  allAssets    = [];
  activeFilter = 'all';
  document.getElementById('raw-data').classList.add('hidden');
  document.getElementById('raw-toggle').innerHTML =
    `<svg viewBox="0 0 20 20" fill="none"><path d="M6 8l-4 4 4 4M14 8l4 4-4 4M11 4l-2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Show Raw JSON`;
}

function clearInput() {
  document.getElementById('url-input').value = '';
  document.getElementById('url-input').focus();
}

function toggleRaw() {
  const raw = document.getElementById('raw-data');
  const btn = document.getElementById('raw-toggle');
  raw.classList.toggle('hidden');
  const icon = `<svg viewBox="0 0 20 20" fill="none"><path d="M6 8l-4 4 4 4M14 8l4 4-4 4M11 4l-2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  btn.innerHTML = raw.classList.contains('hidden')
    ? `${icon} Show Raw JSON`
    : `${icon} Hide Raw JSON`;
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
    showToast('URL copied!', 'success');
  } catch {
    showToast('Could not copy to clipboard', 'error');
  }
}

async function copyAllUrls() {
  const urls = allAssets.map(a => a.url).join('\n');
  try {
    await navigator.clipboard.writeText(urls);
    showToast(`Copied ${allAssets.length} URL(s)`, 'success');
  } catch {
    showToast('Could not copy to clipboard', 'error');
  }
}

// ─── Save Local Files ─────────────────────────────────────────

function saveJson() {
  if (!currentData) return;
  const filename = (currentData._workshopTitle || currentData._localFile || 'workshop_mod')
    .replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';
    
  const json = JSON.stringify(currentData, (k, v) => {
    if (v instanceof Date) return v.toISOString();
    return v;
  }, 2);
  
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('JSON saved!', 'success');
}

function saveBson() {
  if (!currentBuffer) {
    showToast('BSON source not available', 'error');
    return;
  }
  const filename = (currentData._workshopTitle || currentData._localFile || 'workshop_mod')
    .replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.bson';
    
  const blob = new Blob([currentBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('BSON saved!', 'success');
}

// ─── Toast ────────────────────────────────────────────────────
let toastTimeout;
function showToast(message, type = 'success') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id        = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimeout);
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✅' : '❌'}</span>${message}`;
  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─── Utilities ────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (str.length <= max) return str;
  const keep = Math.floor(max / 2) - 3;
  return str.slice(0, keep) + ' … ' + str.slice(-keep);
}

function typeLabel(type) {
  return { image: 'Image', model: 'Model', audio: 'Audio', url: 'URL', other: 'Other', all: 'All' }[type] || type;
}

// ─── Keyboard Shortcuts ───────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'url-input') {
    fetchFromUrl();
  }
});

// Paste hint: detect Workshop ID on paste and update the hint text
document.getElementById('url-input').addEventListener('paste', () => {
  setTimeout(() => {
    const val  = document.getElementById('url-input').value.trim();
    const id   = extractWorkshopId(val);
    const hint = document.querySelector('.input-hint span');
    if (hint) {
      hint.textContent  = id ? `✓ Detected Workshop ID: ${id}` : 'Supported: Steam Workshop link or numeric ID';
      hint.style.color  = id ? 'var(--accent-3)' : '';
    }
  }, 50);
});
// ─── Auto-load from URL ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const idFromUrl = params.get('id');
  if (idFromUrl) {
    document.getElementById('url-input').value = idFromUrl;
    fetchFromUrl();
  }
});
