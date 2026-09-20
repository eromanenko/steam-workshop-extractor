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
      updateCutAllButton(); // refresh Cut All state after each check
    });
  });
  updateCutAllButton(); // initial state (all checking → disabled)
}

// ─── CORS Check ───────────────────────────────────────────────
// Returns 'url' if images can be fetched directly, 'upload' otherwise.
async function checkDeckCors(deck) {
  const urls = [deck.faceUrl];
  // Only check back URL if it's a unique-back deck (sheet to be sliced).
  // For non-unique backs the image is a single template — no need to fetch it.
  if (deck.uniqueBack && deck.backUrl && deck.backUrl !== deck.faceUrl) urls.push(deck.backUrl);

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

// ─── Cut All Decks button state ───────────────────────────────
function updateCutAllButton() {
  const btn = document.getElementById('cutter-cut-all-btn');
  if (!btn) return;

  const urlDecks     = cutterDecks.filter(d => deckCorsStatus.get(d.deckKey) === 'url');
  const stillChecking = cutterDecks.some(d => deckCorsStatus.get(d.deckKey) === 'checking');

  if (urlDecks.length > 0) {
    btn.disabled = false;
    btn.innerHTML = `${cutAllIcon()} Cut all (${urlDecks.length})`;
  } else if (stillChecking) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spin">⟳</span> Checking…`;
  } else {
    btn.disabled = true;
    btn.innerHTML = `${cutAllIcon()} Cut all (0)`;
  }
}

function cutAllIcon() {
  return `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="5" cy="15" r="2" stroke="currentColor" stroke-width="1.4"/>
    <path d="M7 6.5L17 12M7 13.5L17 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

// ─── Shared Cut Decks Logic ───────────────────────────────────
async function appendCutDecksToZip(zip, setProgress) {
  const eligibleDecks = cutterDecks.filter(d => deckCorsStatus.get(d.deckKey) === 'url');
  let totalCards  = 0;
  let failedDecks = 0;
  const nameCounts = new Map();

  for (const deck of eligibleDecks) {
    const rawName  = deck.deckName || `deck_${deck.deckKey}`;
    let safeName = rawName.replace(/[^\p{L}\p{N}_\-]/gu, '_').replace(/_+/g, '_').slice(0, 40);

    const count = (nameCounts.get(safeName) || 0) + 1;
    nameCounts.set(safeName, count);
    if (count > 1) {
      safeName = `${safeName}(${count})`;
    }

    if (setProgress) setProgress(`Cutting ${escHtml(rawName)}…`);

    try {
      // Face sheet
      const faceResp = await fetch(deck.faceUrl, { mode: 'cors' });
      if (!faceResp.ok) throw new Error(`HTTP ${faceResp.status}`);
      
      const faceSuffix = (deck.backUrl && deck.backUrl === deck.faceUrl) ? 'back_face' : 'face';

      if (deck.totalSlots === 1) {
        const blob = await faceResp.blob();
        const ext = await getRealExtension(blob, deck.faceUrl);
        zip.file(`${safeName}_${faceSuffix}.${ext}`, blob);
        totalCards++;
      } else {
        const faceCards = await sliceImageToCards(await faceResp.blob(), deck);
        for (const { canvas, index } of faceCards) {
          zip.file(`${safeName}_${String(index + 1).padStart(3, '0')}_${faceSuffix}.png`, await canvasToBlob(canvas));
          totalCards++;
        }
      }

      // Back — unique: slice the sheet; non-unique: add single template file
      if (deck.backUrl && deck.backUrl !== deck.faceUrl) {
        if (setProgress) setProgress(`Cutting ${escHtml(rawName)} back…`);
        const backResp = await fetch(deck.backUrl, { mode: 'cors' });
        if (backResp.ok) {
          if (deck.totalSlots === 1 || !deck.uniqueBack) {
            // Shared back OR 1-slot deck — one file for the whole deck
            const blob = await backResp.blob();
            const ext = await getRealExtension(blob, deck.backUrl);
            zip.file(`${safeName}_back.${ext}`, blob);
            totalCards++;
          } else {
            const backCards = await sliceImageToCards(await backResp.blob(), deck);
            for (const { canvas, index } of backCards) {
              zip.file(`${safeName}_${String(index + 1).padStart(3, '0')}_back.png`, await canvasToBlob(canvas));
              totalCards++;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Failed to cut deck ${deck.deckKey}:`, e);
      failedDecks++;
    }
  }
  return { totalCards, failedDecks, eligibleDecksCount: eligibleDecks.length };
}

// ─── Cut All Decks ────────────────────────────────────────────
// Fetches + slices all decks with 'url' CORS status, packs into one ZIP.
async function cutAllDecks() {
  const eligibleDecks = cutterDecks.filter(d => deckCorsStatus.get(d.deckKey) === 'url');
  if (eligibleDecks.length === 0) { showToast('No decks available for direct cut', 'error'); return; }

  const btn = document.getElementById('cutter-cut-all-btn');
  const setProgress = label => { if (btn) btn.innerHTML = `<span class="spin">⟳</span> ${label}`; };
  if (btn) btn.disabled = true;

  const zip = new JSZip();
  
  const { totalCards, failedDecks } = await appendCutDecksToZip(zip, setProgress);

  if (totalCards === 0) {
    showToast('Failed to cut any decks', 'error');
    updateCutAllButton();
    return;
  }

  setProgress('Packing ZIP…');
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a       = document.createElement('a');
  a.href        = URL.createObjectURL(zipBlob);
  const modName = (typeof currentData !== 'undefined' && currentData ? (currentData.SaveName || currentData._workshopTitle || 'workshop') : 'workshop')
    .replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40);
  const wId     = (typeof currentData !== 'undefined' && currentData) ? currentData._workshopId : null;
  a.download    = wId ? `${modName}_decks_[tts${wId}].zip` : `${modName}_decks.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  const msg = failedDecks > 0
    ? `Saved ${totalCards} cards (${failedDecks} deck(s) failed)`
    : `Saved ${totalCards} cards from ${eligibleDecks.length - failedDecks} deck(s)`;
  showToast(msg, 'success');
  updateCutAllButton();
}

// ─── Meta Card Download Utilities ──────────────────────────────
async function fetchAssetBlob(url) {
  const candidates = [url, ...CORS_PROXIES.map(p => p(url))];
  for (const tryUrl of candidates) {
    try {
      const res = await fetch(tryUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) { return await res.blob(); }
    } catch {}
  }
  return null;
}

function setMetaStatus(i, total, msg) {
  const btnCut = document.getElementById('meta-btn-download-cut');
  const btnAll = document.getElementById('meta-btn-download-all');
  const statusBar = document.getElementById('meta-status-bar');
  const statusMsg = document.getElementById('meta-status-message');
  const statusCount = document.getElementById('meta-status-count');
  const statusFill = document.getElementById('meta-status-fill');

  if (btnCut) btnCut.disabled = true;
  if (btnAll) btnAll.disabled = true;
  if (statusBar) statusBar.classList.remove('hidden');

  const pct = total > 0 ? Math.round((i / total) * 100) : 0;
  if (statusFill) statusFill.style.width = pct + '%';
  if (statusMsg) statusMsg.textContent = msg || `Downloading...`;
  if (statusCount) statusCount.textContent = total > 0 ? `${i} / ${total}` : '';
}

function resetMetaStatus() {
  const btnCut = document.getElementById('meta-btn-download-cut');
  const btnAll = document.getElementById('meta-btn-download-all');
  const statusBar = document.getElementById('meta-status-bar');

  if (btnCut) btnCut.disabled = false;
  if (btnAll) btnAll.disabled = false;
  if (statusBar) statusBar.classList.add('hidden');
}

async function triggerZipDownload(zip, suffix) {
  const modName = (currentData?.SaveName || currentData?._workshopTitle || 'workshop')
    .replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 40);
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zipBlob);
  const wId = currentData?._workshopId;
  a.download = wId ? `${modName}_${suffix}_[tts${wId}].zip` : `${modName}_${suffix}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function downloadMetaAllFiles() {
  const files = allAssets.filter(a => a.type === 'image');
  if (files.length === 0) {
    showToast('No files found to download', 'error');
    return;
  }

  setMetaStatus(0, files.length, 'Starting download...');

  const zip = new JSZip();
  let done = 0;
  const skipped = [];

  for (let i = 0; i < files.length; i++) {
    const asset = files[i];
    const shortUrl = asset.url.split('/').pop() || `file_${i}`;
    const extMatch = asset.url.match(/\.(png|jpg|jpeg|gif|webp|bmp)(\?|$)/i);
    const fallbackExt = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const baseFilename = `${String(i + 1).padStart(3, '0')}_${asset.field}_${shortUrl.slice(0, 40).replace(/[^\p{L}\p{N}._-]/gu, '_')}`;

    setMetaStatus(i, files.length, `Downloading: ${asset.field}`);

    let blob = await fetchAssetBlob(asset.url);
    if (blob && blob.size > 0) {
      const ext = await getRealExtension(blob, asset.url);
      zip.file(`${baseFilename}.${ext}`, blob);
      done++;
    } else {
      skipped.push(asset.url);
    }
    setMetaStatus(i + 1, files.length, `Downloading: ${asset.field}`);
  }

  if (done === 0) {
    resetMetaStatus();
    showToast('Could not download any files. CORS may be blocking them.', 'error');
    return;
  }

  setMetaStatus(files.length, files.length, 'Generating ZIP file...');
  
  try {
    await triggerZipDownload(zip, 'all_files');
    showToast(
      skipped.length > 0 ? `Saved ${done} file(s) (${skipped.length} skipped)` : `Saved ${done} file(s) to ZIP`,
      'success'
    );
  } catch (e) {
    showToast('ZIP generation error: ' + e.message, 'error');
  }

  resetMetaStatus();
}

async function downloadMetaCutAndOthers() {
  setMetaStatus(0, 0, 'Preparing...');

  const zip = new JSZip();
  
  // 1. Append cut decks
  const { totalCards, failedDecks } = await appendCutDecksToZip(zip, (msg) => {
    setMetaStatus(0, 0, msg);
  });

  // 2. Determine "other" files (exclude Face/Back URLs from decks)
  const deckUrls = new Set();
  cutterDecks.forEach(d => {
    if (d.faceUrl) deckUrls.add(d.faceUrl);
    if (d.backUrl) deckUrls.add(d.backUrl);
  });

  const otherFiles = allAssets.filter(a => a.type === 'image' && !deckUrls.has(a.url));

  // 3. Download other files
  let otherDone = 0;
  const skipped = [];

  for (let i = 0; i < otherFiles.length; i++) {
    const asset = otherFiles[i];
    const shortUrl = asset.url.split('/').pop() || `other_${i}`;
    const baseFilename = `other_${String(i + 1).padStart(3, '0')}_${asset.field}_${shortUrl.slice(0, 40).replace(/[^\p{L}\p{N}._-]/gu, '_')}`;

    setMetaStatus(i, otherFiles.length, `Downloading other: ${asset.field}`);

    let blob = await fetchAssetBlob(asset.url);
    if (blob && blob.size > 0) {
      const ext = await getRealExtension(blob, asset.url);
      zip.file(`${baseFilename}.${ext}`, blob);
      otherDone++;
    } else {
      skipped.push(asset.url);
    }
    setMetaStatus(i + 1, otherFiles.length, `Downloading other: ${asset.field}`);
  }

  if (totalCards === 0 && otherDone === 0) {
    resetMetaStatus();
    showToast('Could not download any files.', 'error');
    return;
  }

  setMetaStatus(otherFiles.length, otherFiles.length, 'Generating ZIP file...');
  
  try {
    await triggerZipDownload(zip, 'cut_and_others');
    const msg = `Saved ${totalCards} cards & ${otherDone} other files.`;
    showToast(msg + (skipped.length > 0 ? ` (${skipped.length} skipped)` : ''), 'success');
  } catch (e) {
    showToast('ZIP generation error: ' + e.message, 'error');
  }

  resetMetaStatus();
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
    
    let faceCards      = null;
    let singleFaceBlob = null;
    const faceSuffix   = (deck.backUrl && deck.backUrl === deck.faceUrl) ? 'back_face' : 'face';
    
    if (deck.totalSlots === 1) {
      singleFaceBlob = faceBlob;
    } else {
      faceCards = await sliceImageToCards(faceBlob, deck);
    }

    let backCards      = null;  // sliced back cards (uniqueBack only)
    let singleBackBlob = null;  // single back image (non-unique back or 1-slot)

    if (deck.backUrl && deck.backUrl !== deck.faceUrl) {
      if (btn) btn.innerHTML = `<span class="spin">⟳</span> Loading back…`;
      const backResp = await fetch(deck.backUrl, { mode: 'cors' });
      if (!backResp.ok) throw new Error(`HTTP ${backResp.status}`);
      const backBlob = await backResp.blob();
      if (deck.totalSlots === 1 || !deck.uniqueBack) {
        // Shared back or single-slot deck — include as a single template image
        singleBackBlob = backBlob;
      } else {
        // Unique backs — slice the sheet into individual card backs
        backCards = await sliceImageToCards(backBlob, deck);
      }
    }

    await packAndDownload(deck, faceCards, backCards, singleBackBlob, singleFaceBlob, faceSuffix);
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

  try {
    showToast(`Select the FACE sheet for "${deck.deckName}"`, 'success');
    const faceFile = await promptFileUpload();
    if (!faceFile) return;

    let faceCards      = null;
    let singleFaceBlob = null;
    const faceSuffix   = (deck.backUrl && deck.backUrl === deck.faceUrl) ? 'back_face' : 'face';
    
    if (deck.totalSlots === 1) {
      singleFaceBlob = faceFile;
    } else {
      faceCards = await sliceImageToCards(faceFile, deck);
    }

    let backCards      = null;
    let singleBackBlob = null;

    if (deck.backUrl && deck.backUrl !== deck.faceUrl) {
      if (deck.totalSlots > 1 && deck.uniqueBack) {
        // Unique backs — slice a separate back sheet
        showToast(`Now select the BACK sheet for "${deck.deckName}"`, 'success');
        const backFile = await promptFileUpload();
        if (backFile) backCards = await sliceImageToCards(backFile, deck);
      } else {
        // Shared back or single-slot deck — try to fetch silently first; if CORS fails, ask for upload
        try {
          const resp = await fetch(deck.backUrl, { mode: 'cors', signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            singleBackBlob = await resp.blob();
          } else {
            throw new Error('not ok');
          }
        } catch {
          showToast(`Select the single BACK image for "${deck.deckName}"`, 'success');
          const backFile = await promptFileUpload();
          if (backFile) singleBackBlob = backFile;
        }
      }
    }

    await packAndDownload(deck, faceCards, backCards, singleBackBlob, singleFaceBlob, faceSuffix);
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
// faceCards      — array of sliced face card canvases (null if singleFaceBlob is used)
// backCards      — array of sliced back card canvases (uniqueBack decks)
// singleBackBlob — one back image added as-is (non-unique back decks or single slot)
// singleFaceBlob — one face image added as-is (single slot decks)
async function packAndDownload(deck, faceCards, backCards = null, singleBackBlob = null, singleFaceBlob = null, faceSuffix = 'face') {
  const rawName  = deck.deckName || `deck_${deck.deckKey}`;
  const safeName = rawName.replace(/[^\p{L}\p{N}_\-]/gu, '_').replace(/_+/g, '_').slice(0, 40);

  const zip = new JSZip();
  let faceCount = 0;

  if (singleFaceBlob) {
    const ext = await getRealExtension(singleFaceBlob, deck.faceUrl);
    zip.file(`${safeName}_${faceSuffix}.${ext}`, singleFaceBlob);
    faceCount = 1;
  } else if (faceCards) {
    for (const { canvas, index } of faceCards) {
      const blob    = await canvasToBlob(canvas);
      const cardNum = String(index + 1).padStart(3, '0');
      zip.file(`${safeName}_${cardNum}_${faceSuffix}.png`, blob);
      faceCount++;
    }
  }

  let backCount = 0;
  if (backCards && backCards.length > 0) {
    // Unique back — each card has its own back image
    for (const { canvas, index } of backCards) {
      const blob    = await canvasToBlob(canvas);
      const cardNum = String(index + 1).padStart(3, '0');
      zip.file(`${safeName}_${cardNum}_back.png`, blob);
    }
  } else if (singleBackBlob) {
    // Shared back — one template image for the whole deck
    const ext = await getRealExtension(singleBackBlob, deck.backUrl);
    zip.file(`${safeName}_back.${ext}`, singleBackBlob);
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

async function getRealExtension(blob, fallbackUrl = '') {
  if (!blob) return 'png';
  let ext = 'png';
  const nameToMatch = blob.name || fallbackUrl || '';
  const urlMatch = nameToMatch.match(/\.(png|jpg|jpeg|gif|webp|bmp)(\?|$)/i);
  if (urlMatch) ext = urlMatch[1].toLowerCase();

  try {
    if (blob.size >= 12) {
      const buffer = await blob.slice(0, 12).arrayBuffer();
      const view = new Uint8Array(buffer);
      if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) ext = 'png';
      else if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) ext = 'jpg';
      else if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
               view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) ext = 'webp';
      else if (view[0] === 0x47 && view[1] === 0x49 && view[2] === 0x46) ext = 'gif';
      else if (view[0] === 0x42 && view[1] === 0x4D) ext = 'bmp';
    }
  } catch (e) {
    // ignore errors reading the blob, default to url match or png
  }
  return ext;
}
