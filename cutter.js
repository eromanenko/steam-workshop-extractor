// ============================================================
// Card Sheet Cutter
// Flow:
//   1. User drops/selects a sheet image
//   2. Filename is matched against FaceURL / BackURL of every deck
//   3. Matched deck + side (face|back) are auto-selected
//   4. Sheet is sliced according to NumWidth × NumHeight grid
//   5. Cards are downloaded as ZIP with naming:
//        {deckName}_{card###}_{face|back}.png
//
// v1.2.0: Per-deck Cut button (Cut & Download / Upload & Cut)
//         Slices both face + back into one ZIP.
// ============================================================

'use strict';

// ─── Deck Extractor ───────────────────────────────────────────
// Walks the BSON tree and collects every unique CustomDeck entry.
function extractDecks(data) {
  const seen = new Map(); // deckKey → definition

  function visitObject(obj, contextName) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.CustomDeck && typeof obj.CustomDeck === 'object') {
      for (const [key, def] of Object.entries(obj.CustomDeck)) {
        if (!seen.has(key)) {
          seen.set(key, {
            deckKey:    key,
            faceUrl:    def.FaceURL   || def.faceURL  || '',
            backUrl:    def.BackURL   || def.backURL  || '',
            numWidth:   def.NumWidth  || 1,
            numHeight:  def.NumHeight || 1,
            uniqueBack: !!def.UniqueBack,
            deckName:   contextName  || `Deck ${key}`,
          });
        }
      }
    }

    // Recurse
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        v.forEach(item => visitObject(item, obj.Nickname || obj.Name || contextName || ''));
      } else if (v && typeof v === 'object') {
        visitObject(v, obj.Nickname || obj.Name || contextName || '');
      }
    }
  }

  visitObject(data, '');

  return Array.from(seen.values())
    .map(d => ({ ...d, totalSlots: d.numWidth * d.numHeight }))
    .filter(d => d.faceUrl); // only decks with an actual face image
}

// ─── State ────────────────────────────────────────────────────
let cutterDecks   = [];
let activeDeckKey = null;
let activeSide    = 'face'; // 'face' | 'back'
let slicedCards   = [];
let uploadedFile  = null;

// CORS status cache: deckKey → 'checking' | 'url' | 'upload'
const deckCorsStatus = new Map();

// ─── Init ─────────────────────────────────────────────────────
function initCutter(data) {
  cutterDecks   = extractDecks(data);
  activeDeckKey = cutterDecks.length > 0 ? cutterDecks[0].deckKey : null;
  activeSide    = 'face';
  slicedCards   = [];
  uploadedFile  = null;
  deckCorsStatus.clear();

  resetMatchStatus();
  renderCutterDecks();
  resetSliceArea();

  // Kick off async CORS checks for all decks
  cutterDecks.forEach(deck => {
    deckCorsStatus.set(deck.deckKey, 'checking');
    checkDeckCors(deck).then(status => {
      deckCorsStatus.set(deck.deckKey, status);
      updateDeckCutButton(deck.deckKey, status);
    });
  });
}

// ─── CORS Check ───────────────────────────────────────────────
// Returns 'url' if images can be fetched directly, 'upload' otherwise.
async function checkDeckCors(deck) {
  const urls = [deck.faceUrl];
  if (deck.backUrl && deck.backUrl !== deck.faceUrl) urls.push(deck.backUrl);

  for (const url of urls) {
    if (!url) continue;
    let ok = false;
    try {
      // Try HEAD first (minimal data transfer)
      await fetch(url, {
        mode: 'cors',
        method: 'HEAD',
        signal: AbortSignal.timeout(6000),
      });
      ok = true;
    } catch {
      // HEAD failed or CORS blocked — try GET with Range
      try {
        await fetch(url, {
          mode: 'cors',
          method: 'GET',
          headers: { Range: 'bytes=0-1023' },
          signal: AbortSignal.timeout(6000),
        });
        ok = true;
      } catch {
        return 'upload';
      }
    }
    if (!ok) return 'upload';
  }
  return 'url';
}

// ─── Update a single deck's cut button after CORS check ──────
function updateDeckCutButton(deckKey, status) {
  const btn = document.querySelector(`#cutter-deck-${deckKey} .cutter-cut-btn`);
  if (!btn) return;

  if (status === 'checking') {
    btn.innerHTML = `<span class="spin">⟳</span> Checking…`;
    btn.disabled = true;
    btn.className = 'cutter-cut-btn';
  } else if (status === 'url') {
    btn.innerHTML = `${scissorsIcon()} Cut &amp; download`;
    btn.title = 'Cut and download';
    btn.disabled = false;
    btn.className = 'cutter-cut-btn';
    btn.onclick = () => cutAndDownloadDeck(deckKey);
  } else {
    btn.innerHTML = `${uploadIcon()} Upload &amp; cut`;
    btn.title = 'Upload and cut';
    btn.disabled = false;
    btn.className = 'cutter-cut-btn mode-upload';
    btn.onclick = () => uploadAndCutDeck(deckKey);
  }
}

function scissorsIcon() {
  return `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="5" cy="15" r="2" stroke="currentColor" stroke-width="1.4"/>
    <path d="M7 6.5L17 12M7 13.5L17 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

function uploadIcon() {
  return `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 13V4M10 4L7 7M10 4l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4 16h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

// ─── Cut & Download ───────────────────────────────────────────
// Fetches face (and back if different) URLs, slices, zips both.
async function cutAndDownloadDeck(deckKey) {
  const deck = cutterDecks.find(d => d.deckKey === deckKey);
  if (!deck) return;

  const btn = document.querySelector(`#cutter-deck-${deckKey} .cutter-cut-btn`);
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin">⟳</span> Loading…`; }

  try {
    const faceResp = await fetch(deck.faceUrl, { mode: 'cors' });
    if (!faceResp.ok) throw new Error(`HTTP ${faceResp.status}`);
    const faceBlob = await faceResp.blob();
    const faceCards = await sliceImageToCards(faceBlob, deck);

    let backCards = null;
    const needsBack = deck.backUrl && deck.backUrl !== deck.faceUrl;
    if (needsBack) {
      if (btn) btn.innerHTML = `<span class="spin">⟳</span> Loading back…`;
      const backResp = await fetch(deck.backUrl, { mode: 'cors' });
      if (!backResp.ok) throw new Error(`HTTP ${backResp.status}`);
      const backBlob = await backResp.blob();
      backCards = await sliceImageToCards(backBlob, deck);
    }

    await packAndDownload(deck, faceCards, backCards);
  } catch (e) {
    showToast('Cut failed: ' + e.message, 'error');
  } finally {
    updateDeckCutButton(deckKey, 'url');
  }
}

// ─── Upload & Cut ─────────────────────────────────────────────
// Prompts user for image file(s), slices, zips both sides.
async function uploadAndCutDeck(deckKey) {
  const deck = cutterDecks.find(d => d.deckKey === deckKey);
  if (!deck) return;

  const needsBack = deck.backUrl && deck.backUrl !== deck.faceUrl;

  try {
    showToast(`Select the FACE sheet for "${deck.deckName}"`, 'success');
    const faceFile = await promptFileUpload();
    if (!faceFile) return;

    const faceCards = await sliceImageToCards(faceFile, deck);

    let backCards = null;
    if (needsBack) {
      showToast(`Now select the BACK sheet for "${deck.deckName}"`, 'success');
      const backFile = await promptFileUpload();
      if (!backFile) return;
      backCards = await sliceImageToCards(backFile, deck);
    }

    await packAndDownload(deck, faceCards, backCards);
  } catch (e) {
    showToast('Cut failed: ' + e.message, 'error');
  }
}

// Opens a native file picker and resolves with the chosen File (or null).
function promptFileUpload() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    const done = file => {
      document.body.removeChild(input);
      resolve(file || null);
    };

    input.addEventListener('change', e => done(e.target.files[0]));
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

// ─── Pure Image Slicer ────────────────────────────────────────
// Returns array of { canvas, index, col, row } without touching global state.
async function sliceImageToCards(source, deck) {
  const img = await loadImageFromSource(source);
  const { numWidth, numHeight } = deck;
  const cardW = Math.floor(img.width  / numWidth);
  const cardH = Math.floor(img.height / numHeight);

  const cards = [];
  for (let row = 0; row < numHeight; row++) {
    for (let col = 0; col < numWidth; col++) {
      const canvas  = document.createElement('canvas');
      canvas.width  = cardW;
      canvas.height = cardH;
      canvas.getContext('2d')
        .drawImage(img, col * cardW, row * cardH, cardW, cardH, 0, 0, cardW, cardH);
      cards.push({ canvas, index: row * numWidth + col, col, row });
    }
  }
  return cards;
}

// Loads an image from a File/Blob or URL string.
// For Blob sources, uses an object URL (avoids canvas taint).
function loadImageFromSource(source) {
  return new Promise((resolve, reject) => {
    const isBlob = source instanceof Blob;
    const url    = isBlob ? URL.createObjectURL(source) : source;
    const img    = new Image();
    if (!isBlob) img.crossOrigin = 'anonymous';
    img.onload  = () => { if (isBlob) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if (isBlob) URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

// ─── Pack & Download ZIP ──────────────────────────────────────
async function packAndDownload(deck, faceCards, backCards) {
  const rawName  = deck.deckName || `deck_${deck.deckKey}`;
  const safeName = rawName.replace(/[^\p{L}\p{N}_\-]/gu, '_').replace(/_+/g, '_').slice(0, 40);

  const zip = new JSZip();

  for (const { canvas, index } of faceCards) {
    const blob    = await canvasToBlob(canvas);
    const cardNum = String(index + 1).padStart(3, '0');
    zip.file(`${safeName}_${cardNum}_face.png`, blob);
  }

  if (backCards && backCards.length > 0) {
    for (const { canvas, index } of backCards) {
      const blob    = await canvasToBlob(canvas);
      const cardNum = String(index + 1).padStart(3, '0');
      zip.file(`${safeName}_${cardNum}_back.png`, blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(zipBlob);
  a.download    = `${safeName}_cards.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  const total = faceCards.length + (backCards?.length ?? 0);
  showToast(`Saved ${total} card images as ZIP`, 'success');
}

// ─── Deck List Renderer ───────────────────────────────────────
// Each row shows: [face thumb] [deck info + grid + cut btn] [back thumb]
function renderCutterDecks() {
  const list    = document.getElementById('cutter-deck-list');
  const countEl = document.getElementById('cutter-deck-count');
  if (!list) return;

  if (countEl) {
    countEl.textContent = `${cutterDecks.length} deck${cutterDecks.length !== 1 ? 's' : ''}`;
  }

  if (cutterDecks.length === 0) {
    list.innerHTML = `<div class="cutter-empty">No deck sheets found in this mod.<br>Load a mod with Deck objects first.</div>`;
    return;
  }

  list.innerHTML = cutterDecks.map(d => {
    const faceFile = filenameOf(d.faceUrl);
    const backFile  = filenameOf(d.backUrl);
    const isActive  = d.deckKey === activeDeckKey;
    const corsStatus = deckCorsStatus.get(d.deckKey) || 'checking';

    // Cut button label depends on cors status (updated later if still checking)
    let cutBtnHtml;
    if (corsStatus === 'checking') {
      cutBtnHtml = `<button class="cutter-cut-btn" disabled title="Checking…">
        <span class="spin">⟳</span> Checking…
      </button>`;
    } else if (corsStatus === 'url') {
      cutBtnHtml = `<button class="cutter-cut-btn" title="Cut and download"
        onclick="cutAndDownloadDeck('${d.deckKey}')">
        ${scissorsIcon()} Cut &amp; download
      </button>`;
    } else {
      cutBtnHtml = `<button class="cutter-cut-btn mode-upload" title="Upload and cut"
        onclick="uploadAndCutDeck('${d.deckKey}')">
        ${uploadIcon()} Upload &amp; cut
      </button>`;
    }

    return `
    <div class="cutter-deck-row ${isActive ? 'active' : ''}" id="cutter-deck-${d.deckKey}">
      <!-- Face side -->
      <div class="cutter-sheet-col ${isActive && activeSide === 'face' ? 'selected-side' : ''}"
           onclick="selectDeckSide('${d.deckKey}', 'face')" title="Face sheet">
        <div class="cutter-sheet-thumb">
          ${d.faceUrl
            ? `<img src="${escHtml(d.faceUrl)}" alt="Face" loading="lazy" onerror="this.style.opacity='0'" />`
            : '<div class="no-thumb">—</div>'}
        </div>
        <div class="cutter-sheet-label">FACE</div>
        <div class="cutter-sheet-file" title="${escHtml(d.faceUrl)}">${escHtml(faceFile)}</div>
      </div>

      <!-- Deck info centre -->
      <div class="cutter-deck-info-col">
        <div class="cutter-deck-name">${escHtml(d.deckName || `Deck ${d.deckKey}`)}</div>
        <div class="cutter-deck-meta">
          <span class="cutter-chip">${d.numWidth} × ${d.numHeight}</span>
          <span class="cutter-chip">${d.totalSlots} slots</span>
          ${d.uniqueBack ? '<span class="cutter-chip chip-unique">Unique backs</span>' : ''}
        </div>
        ${cutBtnHtml}
      </div>

      <!-- Back side -->
      <div class="cutter-sheet-col ${isActive && activeSide === 'back' ? 'selected-side' : ''}"
           onclick="selectDeckSide('${d.deckKey}', 'back')" title="Back sheet">
        <div class="cutter-sheet-thumb">
          ${d.backUrl
            ? `<img src="${escHtml(d.backUrl)}" alt="Back" loading="lazy" onerror="this.style.opacity='0'" />`
            : '<div class="no-thumb">—</div>'}
        </div>
        <div class="cutter-sheet-label">BACK</div>
        <div class="cutter-sheet-file" title="${escHtml(d.backUrl)}">${escHtml(backFile)}</div>
      </div>
    </div>`;
  }).join('');
}

// Select a specific deck + side by clicking a column
function selectDeckSide(deckKey, side) {
  activeDeckKey = deckKey;
  activeSide    = side;
  renderCutterDecks(); // re-render with new selection highlight

  // If a file is already uploaded, re-slice with the new selection
  if (uploadedFile) sliceSheet(uploadedFile);
}

// ─── Filename Matcher ─────────────────────────────────────────
// Returns { deck, side } or null if no match found.
function matchFilenameToDeck(filename) {
  const lc = filename.toLowerCase();

  for (const deck of cutterDecks) {
    // Compare against the bare filename at the end of each URL
    const faceFile = filenameOf(deck.faceUrl).toLowerCase();
    const backFile  = filenameOf(deck.backUrl).toLowerCase();

    // Exact match
    if (lc === faceFile) return { deck, side: 'face' };
    if (lc === backFile)  return { deck, side: 'back' };

    // Stem match (ignore extension): "planche1v" matches "planche1v.jpg"
    const lcStem  = stemOf(lc);
    const faceStem = stemOf(faceFile);
    const backStem  = stemOf(backFile);

    if (lcStem && lcStem === faceStem) return { deck, side: 'face' };
    if (lcStem && lcStem === backStem)  return { deck, side: 'back' };
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────
function filenameOf(url) {
  if (!url) return '—';
  try { return new URL(url).pathname.split('/').pop() || url.split('/').pop(); }
  catch { return url.split('/').pop() || url; }
}

function stemOf(filename) {
  // Returns "planche1v" from "planche1v.jpg"
  const last = filename.split('/').pop();
  const dot  = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

// ─── Match Status Banner ──────────────────────────────────────
function resetMatchStatus() {
  const el = document.getElementById('cutter-match-status');
  if (el) el.innerHTML = '';
}

function showMatchStatus(match, filename) {
  const el = document.getElementById('cutter-match-status');
  if (!el) return;

  if (match) {
    const sideLabel = match.side === 'face' ? '🟡 Face sheet' : '🔵 Back sheet';
    el.innerHTML = `
      <div class="match-status match-found">
        <span class="match-icon">✓</span>
        Auto-matched <strong>${escHtml(filename)}</strong>
        → <strong>${escHtml(match.deck.deckName || `Deck ${match.deck.deckKey}`)}</strong>
        — ${sideLabel}
      </div>`;
  } else {
    el.innerHTML = `
      <div class="match-status match-none">
        <span class="match-icon">?</span>
        Could not auto-match <strong>${escHtml(filename)}</strong>.
        Click the Face or Back column of a deck below to assign manually.
      </div>`;
  }
}

// ─── Reset ────────────────────────────────────────────────────
function resetSliceArea() {
  slicedCards = [];
  const preview = document.getElementById('cutter-preview-area');
  if (preview) preview.innerHTML = '';
  const info = document.getElementById('cutter-result-info');
  if (info) info.textContent = '';
  const btn = document.getElementById('cutter-download-btn');
  if (btn) btn.disabled = true;
}

// ─── File Handling (drop zone) ────────────────────────────────
function handleCutterFile(event) {
  const file = event.target.files[0];
  if (file) processUploadedFile(file);
}

function handleCutterDrop(event) {
  event.preventDefault();
  document.getElementById('cutter-drop-zone').classList.remove('drag-over');
  const file = event.dataTransfer.files[0];
  if (file) processUploadedFile(file);
}

function handleCutterDragOver(event) {
  event.preventDefault();
  document.getElementById('cutter-drop-zone').classList.add('drag-over');
}

function handleCutterDragLeave() {
  document.getElementById('cutter-drop-zone').classList.remove('drag-over');
}

function processUploadedFile(file) {
  uploadedFile = file;
  resetSliceArea();

  // Try to auto-match filename → deck + side
  const match = matchFilenameToDeck(file.name);
  showMatchStatus(match, file.name);

  if (match) {
    activeDeckKey = match.deck.deckKey;
    activeSide    = match.side;
    renderCutterDecks(); // highlight the matched deck+side
  }

  // Slice even if no match (use current selection)
  if (activeDeckKey) {
    sliceSheet(file);
  }
}

// ─── Core Slicer (for the drop zone preview flow) ─────────────
async function sliceSheet(file) {
  const deck = cutterDecks.find(d => d.deckKey === activeDeckKey);
  if (!deck) { showToast('Select a deck first', 'error'); return; }

  let cards;
  try {
    cards = await sliceImageToCards(file, deck);
  } catch (e) {
    showToast('Could not load image: ' + e.message, 'error');
    return;
  }

  slicedCards = cards;

  const img = await loadImageFromSource(file).catch(() => null);
  const sheetW = img?.width  || 0;
  const sheetH = img?.height || 0;
  const cardW  = deck.numWidth  > 0 ? Math.floor(sheetW / deck.numWidth)  : 0;
  const cardH  = deck.numHeight > 0 ? Math.floor(sheetH / deck.numHeight) : 0;

  renderSlicedCards(deck, cardW, cardH, sheetW, sheetH);
  showToast(`Sliced ${slicedCards.length} cards (${deck.numWidth}×${deck.numHeight})`, 'success');
}

// ─── Preview Renderer ─────────────────────────────────────────
function renderSlicedCards(deck, cardW, cardH, sheetW, sheetH) {
  const preview = document.getElementById('cutter-preview-area');
  const info    = document.getElementById('cutter-result-info');
  const btn     = document.getElementById('cutter-download-btn');

  if (info) {
    info.textContent = `${slicedCards.length} cards · ${cardW}×${cardH}px each · sheet ${sheetW}×${sheetH}px`;
  }
  if (btn) btn.disabled = false;
  if (!preview) return;

  preview.innerHTML = '';

  // Preview thumbnails capped at 120px wide
  const thumbW = Math.min(120, cardW || 120);
  const thumbH = Math.round(thumbW * (cardH || thumbW) / (cardW || thumbW));

  slicedCards.forEach(({ canvas, index, col, row }) => {
    const wrap  = document.createElement('div');
    wrap.className = 'sliced-card';
    wrap.title = `Card ${index + 1} (col ${col + 1}, row ${row + 1})`;

    const thumb = document.createElement('canvas');
    thumb.width  = thumbW;
    thumb.height = thumbH;
    thumb.className = 'sliced-thumb';
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumbW, thumbH);

    const label = document.createElement('div');
    label.className = 'sliced-label';
    label.textContent = `#${index + 1}`;

    wrap.append(thumb, label);
    preview.appendChild(wrap);
  });
}

// ─── ZIP Download (drop-zone flow — single side) ──────────────
async function downloadCardsZip() {
  if (slicedCards.length === 0) { showToast('No cards sliced yet', 'error'); return; }

  const deck = cutterDecks.find(d => d.deckKey === activeDeckKey);
  const rawName = deck?.deckName || `deck_${activeDeckKey}`;
  const safeName = rawName.replace(/[^\p{L}\p{N}_\-]/gu, '_').replace(/_+/g, '_').slice(0, 40);
  const sideSuffix = activeSide; // 'face' or 'back'

  const btn = document.getElementById('cutter-download-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Packing ZIP…'; }

  const zip = new JSZip();

  for (const { canvas, index } of slicedCards) {
    const blob     = await canvasToBlob(canvas);
    const cardNum  = String(index + 1).padStart(3, '0');
    // Naming: DeckName_001_face.png
    zip.file(`${safeName}_${cardNum}_${sideSuffix}.png`, blob);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(zipBlob);
  a.download    = `${safeName}_${sideSuffix}_cards.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  if (btn) {
    btn.disabled     = false;
    btn.innerHTML    = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 3v9M10 12l-3-3M10 12l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Download All Cards (ZIP)`;
  }
  showToast(`Saved ${slicedCards.length} cards as ZIP`, 'success');
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
