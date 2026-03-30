// ============================================================
// Card Sheet Cutter
// Flow:
//   1. User drops/selects a sheet image
//   2. Filename is matched against FaceURL / BackURL of every deck
//   3. Matched deck + side (face|back) are auto-selected
//   4. Sheet is sliced according to NumWidth × NumHeight grid
//   5. Cards are downloaded as ZIP with naming:
//        {deckName}_{card###}_{face|back}.png
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

// ─── Init ─────────────────────────────────────────────────────
function initCutter(data) {
  cutterDecks   = extractDecks(data);
  activeDeckKey = cutterDecks.length > 0 ? cutterDecks[0].deckKey : null;
  activeSide    = 'face';
  slicedCards   = [];
  uploadedFile  = null;

  resetMatchStatus();
  renderCutterDecks();
  resetSliceArea();
}

// ─── Deck List Renderer ───────────────────────────────────────
// Each row shows: [face thumb] [deck info + grid] [back thumb]
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
        <div class="cutter-sheet-label">Face</div>
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
      </div>

      <!-- Back side -->
      <div class="cutter-sheet-col ${isActive && activeSide === 'back' ? 'selected-side' : ''}"
           onclick="selectDeckSide('${d.deckKey}', 'back')" title="Back sheet">
        <div class="cutter-sheet-thumb">
          ${d.backUrl
            ? `<img src="${escHtml(d.backUrl)}" alt="Back" loading="lazy" onerror="this.style.opacity='0'" />`
            : '<div class="no-thumb">—</div>'}
        </div>
        <div class="cutter-sheet-label">Back</div>
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

// ─── File Handling ────────────────────────────────────────────
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

// ─── Core Slicer ─────────────────────────────────────────────
async function sliceSheet(file) {
  const deck = cutterDecks.find(d => d.deckKey === activeDeckKey);
  if (!deck) { showToast('Select a deck first', 'error'); return; }

  const { numWidth, numHeight } = deck;

  let img;
  try {
    img = await loadImage(file);
  } catch (e) {
    showToast('Could not load image: ' + e.message, 'error');
    return;
  }

  const cardW = Math.floor(img.width  / numWidth);
  const cardH = Math.floor(img.height / numHeight);

  slicedCards = [];

  for (let row = 0; row < numHeight; row++) {
    for (let col = 0; col < numWidth; col++) {
      const canvas  = document.createElement('canvas');
      canvas.width  = cardW;
      canvas.height = cardH;
      canvas.getContext('2d')
        .drawImage(img, col * cardW, row * cardH, cardW, cardH, 0, 0, cardW, cardH);

      slicedCards.push({ canvas, index: row * numWidth + col, col, row });
    }
  }

  renderSlicedCards(deck, cardW, cardH, img.width, img.height);
  showToast(`Sliced ${slicedCards.length} cards (${numWidth}×${numHeight})`, 'success');
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
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
  const thumbW = Math.min(120, cardW);
  const thumbH = Math.round(thumbW * cardH / cardW);

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

// ─── ZIP Download ─────────────────────────────────────────────
async function downloadCardsZip() {
  if (slicedCards.length === 0) { showToast('No cards sliced yet', 'error'); return; }

  const deck = cutterDecks.find(d => d.deckKey === activeDeckKey);
  const rawName = deck?.deckName || `deck_${activeDeckKey}`;
  const safeName = rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').slice(0, 40);
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
