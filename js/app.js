// Spectral Timeline — 100% Browser-Native Resolve-Style Image-to-Spectrogram Synthesizer
// Zero backend, zero CLI required — ready for GitHub Pages.

import {
  PRESETS,
  buildFreqGrid,
  computeSeamDelta,
  defaultConfig,
  renderPlaneGreenRGBA,
  renderSeamDeltaRGBA,
  rgbaToConditionedPlane,
} from "./dsp.js";
import {
  buildSecp256k1BreathingCards,
  renderGeometricTestRGBA,
  renderUniformPixelBoxRGBA,
} from "./glyph_grid.js";

const MAX_CLIPS = 64;
const $ = (id) => document.getElementById(id);
const canvas = $("monitor-canvas");
const ctx = canvas.getContext("2d");

// Helper: convert RGBA Uint8ClampedArray -> offscreen Canvas (fast drawImage & dataURL thumbnails)
function rgbaToCanvas(rgba, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cctx = c.getContext("2d");
  cctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return c;
}

function makeThumbDataUrl(rgba, w, h, tw = 240, th = 135) {
  const src = rgbaToCanvas(rgba, w, h);
  const dst = document.createElement("canvas");
  dst.width = tw;
  dst.height = th;
  const dctx = dst.getContext("2d");
  dctx.fillStyle = "#0e1116";
  dctx.fillRect(0, 0, tw, th);
  const scale = Math.min(tw / w, th / h);
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  dctx.drawImage(src, Math.floor((tw - dw) / 2), Math.floor((th - dh) / 2), dw, dh);
  return dst.toDataURL("image/png");
}

const app = {
  cfg: defaultConfig(),
  breathingEnabled: true,
  dirty: true,
  rendered: false,
  lastRenderMs: 0,
  statusNote: "100% client-side · ready to arrange & synthesize",

  mediaSeq: 0,
  clipSeq: 0,
  mediaPool: new Map(), // mediaId -> { mediaId, filename, width, height, rgba, thumbUrl }
  mediaOrder: [],
  clips: [],            // [{ clipId, mediaId, title, polarity, condMode, rmsDb }]

  // Derived pre-synthesis caches
  planes: [],           // Float32Array[] aligned to current clips
  planeP: 0,
  planeC: 0,
  clipThumbUrls: [],
  clipCanvases: [],
  seams: [],
  seamCanvases: [],

  // Rendered master artifacts
  masterSpecCanvas: null,
  masterWavUrl: null,
  masterWavBytes: 0,
  audioBuffer: null,

  // View / playback state
  monMode: "seam", // "clip" | "master" | "seam"
  selectedClipIdx: 0,
  selectedSeamIdx: 0,
  dragPayload: null,
  loop: true,
  playing: false,
  audioCtx: null,
  gainNode: null,
  sourceNode: null,
  playStartCtxTime: 0,
  playOffset: 0,

  worker: null,
  jobSeq: 0,
  rendering: false,
};

function setBusy(on, text = "Synthesizing…") {
  app.rendering = on;
  $("busy-badge").textContent = text;
  $("busy-badge").classList.toggle("hidden", !on);
}

function nextMediaId() { return `m_${String(++app.mediaSeq).padStart(3, "0")}`; }
function nextClipId() { return `c_${String(++app.clipSeq).padStart(3, "0")}`; }

function totalDurationS() {
  return app.clips.length * (Number(app.cfg.slotDurationS) || 2.0);
}

function hasNegativeClip() {
  return app.clips.some((c) => c.polarity === "neg");
}

function addMediaFromRGBA(filename, rgba, width, height) {
  const mediaId = nextMediaId();
  const thumbUrl = makeThumbDataUrl(rgba, width, height);
  const item = { mediaId, filename, width, height, rgba, thumbUrl };
  app.mediaPool.set(mediaId, item);
  app.mediaOrder.push(mediaId);
  return item;
}

function deleteMedia(mediaId) {
  const item = app.mediaPool.get(mediaId);
  if (!item) return;
  app.mediaPool.delete(mediaId);
  app.mediaOrder = app.mediaOrder.filter((id) => id !== mediaId);
  const before = app.clips.length;
  app.clips = app.clips.filter((c) => c.mediaId !== mediaId);
  markDirty(app.clips.length !== before ? `Removed ${item.filename} from Media Bay & timeline` : `Removed ${item.filename}`);
}

function applyAlternatingPolarities(startPol = "pos") {
  const first = startPol === "neg" ? "neg" : "pos";
  const second = first === "neg" ? "pos" : "neg";
  app.clips.forEach((c, i) => { c.polarity = i % 2 === 0 ? first : second; });
}

function addClip(mediaId, polarity = "pos", insertIndex = null) {
  if (app.clips.length >= MAX_CLIPS) return;
  const item = app.mediaPool.get(mediaId);
  if (!item) return;
  const clip = {
    clipId: nextClipId(),
    mediaId,
    title: item.filename,
    polarity: polarity === "neg" ? "neg" : "pos",
    condMode: app.cfg.condMode || "raw",
    rmsDb: null,
  };
  if (insertIndex !== null && insertIndex >= 0 && insertIndex <= app.clips.length) {
    app.clips.splice(insertIndex, 0, clip);
  } else {
    app.clips.push(clip);
  }
  if (app.breathingEnabled && insertIndex === null && polarity === "pos") {
    applyAlternatingPolarities("pos");
  }
  markDirty(`Added ${clip.title} (${clip.polarity})`);
}

function markDirty(note) {
  app.dirty = true;
  app.statusNote = note;
  recomputePreSynth();
  renderUI();
}

// Instant pre-synthesis conditioning + clip previews + 4-state Endomorphic Seam Deltas
function recomputePreSynth() {
  const freqs = buildFreqGrid(app.cfg);
  const bypassEq = Boolean(app.cfg.preserveBreathingContrast) && (app.breathingEnabled || hasNegativeClip());

  app.planes = [];
  app.clipCanvases = [];
  app.clipThumbUrls = [];
  app.planeP = freqs.length;
  app.planeC = Math.max(8, Math.round((Number(app.cfg.slotDurationS) || 2.0) * (Number(app.cfg.pps) || 120.0)));

  for (const clip of app.clips) {
    const item = app.mediaPool.get(clip.mediaId);
    if (!item) continue;
    const { plane, P, C } = rgbaToConditionedPlane(
      item.rgba,
      item.width,
      item.height,
      app.cfg,
      clip.polarity,
      clip.condMode,
      bypassEq
    );
    app.planeP = P;
    app.planeC = C;
    app.planes.push(plane);
    const greenRgba = renderPlaneGreenRGBA(plane, P, C);
    const cv = rgbaToCanvas(greenRgba, C, P);
    app.clipCanvases.push(cv);
    app.clipThumbUrls.push(cv.toDataURL("image/png"));
  }

  app.seams = [];
  app.seamCanvases = [];
  for (let i = 0; i < app.planes.length - 1; i++) {
    const d = computeSeamDelta(
      app.planes[i],
      app.planes[i + 1],
      app.planeP,
      app.planeC,
      freqs,
      app.clips[i],
      app.clips[i + 1],
      i
    );
    app.seams.push(d);
    const sRgba = renderSeamDeltaRGBA(app.planes[i], app.planes[i + 1], app.planeP, app.planeC);
    app.seamCanvases.push(rgbaToCanvas(sRgba, app.planeC, app.planeP));
  }

  if (app.selectedClipIdx >= app.clips.length) app.selectedClipIdx = Math.max(0, app.clips.length - 1);
  if (app.selectedSeamIdx >= app.seams.length) app.selectedSeamIdx = Math.max(0, app.seams.length - 1);
}

// --- Web Worker Lossless Master Synthesis ---
function ensureWorker() {
  if (!app.worker) {
    app.worker = new Worker("./js/synth_worker.js", { type: "module" });
  }
  return app.worker;
}

function synthesizeMaster(autoDownload = false) {
  if (app.clips.length === 0) {
    app.statusNote = "Add at least one clip to the timeline before synthesizing.";
    renderUI();
    return;
  }
  stopPlayback(false);
  recomputePreSynth();

  const worker = ensureWorker();
  const jobId = ++app.jobSeq;
  setBusy(true, "Synthesizing Lossless WAV…");

  const planesCopy = app.planes.map((pl) => new Float32Array(pl));
  const transfers = planesCopy.map((pl) => pl.buffer);

  worker.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.jobId !== app.jobSeq) return;
    if (msg.type === "progress") {
      setBusy(true, `${msg.stage} (${Math.round(msg.frac * 100)}%)…`);
      return;
    }
    if (msg.type === "error") {
      setBusy(false);
      app.statusNote = `Synthesis error: ${msg.message}`;
      renderUI();
      return;
    }
    if (msg.type === "done") {
      setBusy(false);
      app.lastRenderMs = msg.elapsedMs;
      app.clips.forEach((c, i) => { c.rmsDb = msg.slotRmsDb[i] ?? null; });

      // Master WAV Blob URL
      if (app.masterWavUrl) URL.revokeObjectURL(app.masterWavUrl);
      const wavBlob = new Blob([msg.masterWavBuf], { type: "audio/wav" });
      app.masterWavUrl = URL.createObjectURL(wavBlob);
      app.masterWavBytes = wavBlob.size;

      // Master Spectrogram Canvas
      app.masterSpecCanvas = rgbaToCanvas(new Uint8ClampedArray(msg.specRgbaBuf), msg.specW, msg.specH);

      // Decode browser playback AudioBuffer
      try {
        ensureAudio();
        app.audioBuffer = await app.audioCtx.decodeAudioData(msg.playWavBuf.slice(0));
      } catch (e) {
        console.warn("WebAudio decode warning:", e);
        app.audioBuffer = null;
      }

      app.dirty = false;
      app.rendered = true;
      app.monMode = "master";
      app.statusNote = `Lossless ${app.cfg.sr / 1000} kHz / ${app.cfg.bitDepth}-bit WAV ready (${(wavBlob.size / 1024).toFixed(0)} KB · ${msg.elapsedMs.toFixed(0)} ms)`;
      renderUI();

      if (autoDownload) {
        const a = $("btn-dl-wav");
        a.click();
      }
    }
  };

  worker.postMessage(
    { jobId, planes: planesCopy, P: app.planeP, C: app.planeC, cfg: { ...app.cfg } },
    transfers
  );
}

// --- WebAudio Playback ---
function ensureAudio() {
  if (!app.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    app.audioCtx = new AC();
    app.gainNode = app.audioCtx.createGain();
    app.gainNode.gain.value = parseFloat($("gain-input").value) || 0.35;
    app.gainNode.connect(app.audioCtx.destination);
  }
  if (app.audioCtx.state === "suspended") app.audioCtx.resume();
}

function currentPlayheadSec() {
  const dur = Math.max(0.001, totalDurationS());
  if (!app.playing || !app.audioCtx) return Math.max(0, Math.min(dur, app.playOffset));
  const elapsed = app.audioCtx.currentTime - app.playStartCtxTime;
  const pos = app.playOffset + elapsed;
  return app.loop ? ((pos % dur) + dur) % dur : Math.min(dur, pos);
}

function stopPlayback(keepOffset = true) {
  if (keepOffset && app.playing) app.playOffset = currentPlayheadSec();
  if (app.sourceNode) {
    try { app.sourceNode.onended = null; app.sourceNode.stop(); } catch (_) {}
    app.sourceNode.disconnect();
    app.sourceNode = null;
  }
  app.playing = false;
  $("btn-play").textContent = "Play";
}

function startPlayback(offsetSec = null) {
  if (!app.audioBuffer) return;
  ensureAudio();
  stopPlayback(false);
  const dur = app.audioBuffer.duration || 1;
  const off = offsetSec !== null ? Math.max(0, Math.min(dur - 0.001, offsetSec)) : (app.playOffset % dur);
  const src = app.audioCtx.createBufferSource();
  src.buffer = app.audioBuffer;
  src.loop = app.loop;
  src.connect(app.gainNode);
  src.onended = () => {
    if (!app.loop) {
      app.playing = false;
      app.playOffset = 0;
      $("btn-play").textContent = "Play";
    }
  };
  src.start(0, off);
  app.sourceNode = src;
  app.playStartCtxTime = app.audioCtx.currentTime;
  app.playOffset = off;
  app.playing = true;
  $("btn-play").textContent = "Pause";
}

// --- Monitor Canvas Render Loop ---
function drawLoop() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  ctx.fillStyle = "#080a0d";
  ctx.fillRect(0, 0, w, h);

  let srcCanvas = null;
  if (app.monMode === "master") {
    srcCanvas = app.masterSpecCanvas;
  } else if (app.monMode === "seam") {
    srcCanvas = app.seamCanvases[app.selectedSeamIdx] || null;
  } else {
    srcCanvas = app.clipCanvases[app.selectedClipIdx] || null;
  }

  if (srcCanvas) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(srcCanvas, 0, 0, w, h);
  } else {
    ctx.fillStyle = "#5c677a";
    ctx.font = `${13 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("Stage images in Media Bay → arrange Timeline → click Synthesize WAV", w / 2, h / 2);
  }

  const dur = Math.max(0.001, totalDurationS());
  if (app.monMode === "master" && app.clips.length > 0) {
    const n = app.clips.length;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = Math.max(1, dpr);
    for (let i = 1; i < n; i++) {
      const x = (i / n) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    const t = currentPlayheadSec();
    const px = (t / dur) * w;
    ctx.strokeStyle = "#38d47a";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    $("hud-time").textContent = `${t.toFixed(2)} / ${totalDurationS().toFixed(2)} s`;
  } else {
    $("hud-time").textContent = `0.00 / ${totalDurationS().toFixed(2)} s`;
  }

  requestAnimationFrame(drawLoop);
}

function clearTimelineDropHighlights() {
  const strip = $("timeline-strip");
  if (strip) strip.classList.remove("drag-over");
  document.querySelectorAll(".clip-card.drop-before, .clip-card.drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

// --- Full UI Render ---
function renderUI() {
  const pill = $("status-pill");
  if (app.dirty) {
    pill.textContent = app.rendered ? "UNSYNCED EDITS" : "PRE-SYNTH";
    pill.className = "pill pill-dirty";
  } else {
    pill.textContent = `RENDERED (${app.lastRenderMs.toFixed(0)} ms)`;
    pill.className = "pill pill-ok";
  }
  $("format-pill").textContent = `${app.cfg.sr / 1000} kHz / ${app.cfg.bitDepth}-bit`;
  $("hud-note").textContent = app.statusNote;

  const dl = $("btn-dl-wav");
  dl.classList.toggle("hidden", !app.masterWavUrl);
  if (app.masterWavUrl) {
    dl.href = app.masterWavUrl;
    dl.download = `spectral_timeline_${app.cfg.sr / 1000}k_${app.cfg.bitDepth}b.wav`;
  }

  const rmsVals = app.clips.map((c) => c.rmsDb).filter((v) => v !== null && v !== undefined);
  $("breathing-rms-lbl").textContent = rmsVals.length
    ? "Slot RMS (dB): " + app.clips.map((c, i) => `${i + 1}:${c.polarity === "neg" ? "−" : "+"}${c.rmsDb}`).join("  ")
    : `Partials=${app.cfg.partials} · ${app.cfg.fMinHz}–${app.cfg.fMaxHz} Hz`;

  const bBtn = $("btn-breathing");
  bBtn.textContent = `Breathing (+/−): ${app.breathingEnabled ? "ON" : "OFF"}`;
  bBtn.classList.toggle("active", app.breathingEnabled);

  // Monitor header & legend
  document.querySelectorAll(".mon-tab").forEach((b) => b.classList.toggle("active", b.dataset.mon === app.monMode));
  $("seam-legend").classList.toggle("hidden", app.monMode !== "seam");

  if (app.monMode === "master") {
    $("mon-info").textContent = app.rendered
      ? `Master ${app.cfg.sr / 1000}kHz/${app.cfg.bitDepth}b · ${app.cfg.fMinHz}–${app.cfg.fMaxHz} Hz${app.dirty ? " (STALE)" : ""}`
      : "Not synthesized yet — click Synthesize WAV";
  } else if (app.monMode === "seam") {
    const sm = app.seams[app.selectedSeamIdx];
    $("mon-info").textContent = sm
      ? `Seam ${sm.seamIndex + 1}: ${sm.polarityTransition} · Disp R=${sm.dispersionRatio.toFixed(2)} · Flux |Δ|=${sm.rectifiedFlux.toFixed(3)} · Δf=${sm.centroidDeltaHz >= 0 ? "+" : ""}${sm.centroidDeltaHz} Hz`
      : "Add at least 2 clips to inspect Seam Delta";
  } else {
    const clip = app.clips[app.selectedClipIdx];
    const dt = Number(app.cfg.slotDurationS) || 2.0;
    $("mon-info").textContent = clip
      ? `Slot ${app.selectedClipIdx + 1}: ${clip.title} · ${clip.polarity === "neg" ? "NEGATIVE (black on green)" : "POSITIVE (green on black)"} · ${(app.selectedClipIdx * dt).toFixed(1)}–${((app.selectedClipIdx + 1) * dt).toFixed(1)} s`
      : "Drag images from Media Bay onto the Timeline";
  }

  // Media Bay
  const grid = $("media-grid");
  grid.innerHTML = "";
  app.mediaOrder.forEach((mid) => {
    const m = app.mediaPool.get(mid);
    if (!m) return;
    const card = document.createElement("div");
    card.className = "media-card";
    card.draggable = true;
    card.innerHTML = `
      <button class="media-del-btn" title="Remove from Media Bay">✕</button>
      <img src="${m.thumbUrl}" alt="${m.filename}" draggable="false" />
      <div class="media-meta">
        <div class="media-name mono" title="${m.filename}">${m.filename}</div>
        <div class="media-actions">
          <button class="media-add-btn" data-pol="pos" title="Add Positive (+ green on black)">+ Add</button>
          <button class="media-add-btn" data-pol="neg" title="Add Negative (− black on green)" style="color: var(--cyan)">− Add</button>
        </div>
      </div>
    `;
    card.addEventListener("dragstart", (ev) => {
      app.dragPayload = { kind: "media", mediaId: m.mediaId };
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", `media:${m.mediaId}`);
    });
    card.addEventListener("dragend", () => {
      app.dragPayload = null;
      clearTimelineDropHighlights();
    });
    card.querySelector(".media-del-btn").addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteMedia(m.mediaId);
    });
    card.querySelectorAll(".media-add-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const prevB = app.breathingEnabled;
        if (btn.dataset.pol === "neg") app.breathingEnabled = false;
        addClip(m.mediaId, btn.dataset.pol, null);
        if (btn.dataset.pol === "pos") app.breathingEnabled = prevB;
        app.selectedClipIdx = app.clips.length - 1;
        app.monMode = "clip";
        renderUI();
      });
    });
    grid.appendChild(card);
  });

  // Timeline Strip
  const dt = Number(app.cfg.slotDurationS) || 2.0;
  $("tl-summary").textContent = `${app.clips.length} / ${MAX_CLIPS} clips · ${totalDurationS().toFixed(1)} s`;
  const strip = $("timeline-strip");
  strip.innerHTML = "";
  app.clips.forEach((c, idx) => {
    const card = document.createElement("div");
    card.className = `clip-card pol-${c.polarity}` + (idx === app.selectedClipIdx && app.monMode === "clip" ? " selected" : "");
    card.draggable = true;
    card.innerHTML = `
      <div class="clip-top mono">
        <span>#${String(idx + 1).padStart(2, "0")} · ${(idx * dt).toFixed(1)}s</span>
        <span>
          <button class="clip-mini" data-act="left" title="Move Left">◀</button>
          <button class="clip-mini" data-act="right" title="Move Right">▶</button>
          <button class="clip-mini" data-act="dup" title="Duplicate inverted">±</button>
          <button class="clip-mini" data-act="del" title="Remove">✕</button>
        </span>
      </div>
      <img class="clip-thumb" src="${app.clipThumbUrls[idx] || ""}" alt="${c.title}" draggable="false" />
      <div class="clip-foot">
        <span class="clip-title mono" title="${c.title}">${c.title}</span>
        <button class="pol-btn ${c.polarity}" data-act="pol" title="Toggle polarity">
          ${c.polarity === "neg" ? "− NEG" : "+ POS"}
        </button>
      </div>
    `;
    card.addEventListener("dragstart", (ev) => {
      app.dragPayload = { kind: "clip", fromIndex: idx };
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", `clip:${idx}`);
    });
    card.addEventListener("dragend", () => {
      app.dragPayload = null;
      card.classList.remove("dragging");
      clearTimelineDropHighlights();
    });
    card.addEventListener("dragover", (ev) => {
      if (!app.dragPayload) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = card.getBoundingClientRect();
      const before = (ev.clientX - rect.left) < rect.width / 2;
      clearTimelineDropHighlights();
      card.classList.add(before ? "drop-before" : "drop-after");
    });
    card.addEventListener("drop", (ev) => {
      if (!app.dragPayload) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = card.getBoundingClientRect();
      const before = (ev.clientX - rect.left) < rect.width / 2;
      const payload = app.dragPayload;
      app.dragPayload = null;
      clearTimelineDropHighlights();

      if (payload.kind === "media") {
        const insertIdx = before ? idx : idx + 1;
        addClip(payload.mediaId, ev.shiftKey ? "neg" : "pos", insertIdx);
        app.selectedClipIdx = insertIdx;
        app.monMode = "clip";
        renderUI();
      } else if (payload.kind === "clip") {
        let toIdx = before ? idx : idx + 1;
        if (payload.fromIndex < toIdx) toIdx -= 1;
        toIdx = Math.max(0, Math.min(app.clips.length - 1, toIdx));
        if (toIdx !== payload.fromIndex) {
          const [moved] = app.clips.splice(payload.fromIndex, 1);
          app.clips.splice(toIdx, 0, moved);
          if (app.breathingEnabled) applyAlternatingPolarities("pos");
          app.selectedClipIdx = toIdx;
          markDirty(`Moved ${moved.title} to slot ${toIdx + 1}`);
        }
      }
    });
    card.addEventListener("click", () => {
      app.selectedClipIdx = idx;
      app.monMode = "clip";
      renderUI();
    });
    card.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === "pol") {
          c.polarity = c.polarity === "pos" ? "neg" : "pos";
          app.breathingEnabled = false;
          markDirty(`Flipped slot ${idx + 1} to ${c.polarity}`);
        } else if (act === "left" && idx > 0) {
          [app.clips[idx - 1], app.clips[idx]] = [app.clips[idx], app.clips[idx - 1]];
          if (app.breathingEnabled) applyAlternatingPolarities("pos");
          app.selectedClipIdx = idx - 1;
          markDirty("Reordered clips");
        } else if (act === "right" && idx + 1 < app.clips.length) {
          [app.clips[idx + 1], app.clips[idx]] = [app.clips[idx], app.clips[idx + 1]];
          if (app.breathingEnabled) applyAlternatingPolarities("pos");
          app.selectedClipIdx = idx + 1;
          markDirty("Reordered clips");
        } else if (act === "dup" && app.clips.length < MAX_CLIPS) {
          const dup = { ...c, clipId: nextClipId(), polarity: c.polarity === "pos" ? "neg" : "pos", rmsDb: null };
          app.clips.splice(idx + 1, 0, dup);
          app.selectedClipIdx = idx + 1;
          markDirty(`Duplicated ${c.title} (${dup.polarity})`);
        } else if (act === "del") {
          app.clips.splice(idx, 1);
          if (app.breathingEnabled) applyAlternatingPolarities("pos");
          markDirty(`Removed slot ${idx + 1}`);
        }
      });
    });
    strip.appendChild(card);

    if (idx < app.seams.length) {
      const sm = app.seams[idx];
      const chip = document.createElement("button");
      chip.className = "seam-chip mono" + (sm.isInvertedSeam ? " inverted" : "") + (app.monMode === "seam" && app.selectedSeamIdx === idx ? " selected" : "");
      chip.title = `Inspect Seam ${idx + 1} (${sm.polarityTransition})`;
      chip.innerHTML = `<span>Δ${idx + 1}</span><span>${sm.isInvertedSeam ? "⇄" : "→"}</span><span>${sm.rectifiedFlux.toFixed(2)}</span>`;
      chip.addEventListener("click", () => {
        app.selectedSeamIdx = idx;
        app.monMode = "seam";
        renderUI();
      });
      strip.appendChild(chip);
    }
  });

  // Config controls
  const presetSel = $("cfg-preset");
  if (presetSel.options.length === 0) {
    Object.keys(PRESETS).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      presetSel.appendChild(opt);
    });
  }
  presetSel.value = app.cfg.preset;
  $("cfg-slot-s").value = app.cfg.slotDurationS;
  $("cfg-fmin").value = app.cfg.fMinHz;
  $("cfg-fmax").value = app.cfg.fMaxHz;
  $("cfg-scale").value = app.cfg.freqScale;
  $("cfg-partials").value = app.cfg.partials;
  $("cfg-cond").value = app.cfg.condMode;
  $("cfg-sr").value = String(app.cfg.sr);
  $("cfg-bit-depth").value = String(app.cfg.bitDepth);
  $("cfg-preserve-breathing").checked = app.cfg.preserveBreathingContrast;

  // Seam Delta Table
  const wrap = $("seam-table-wrap");
  if (app.seams.length === 0) {
    wrap.innerHTML = `<div class="muted">Add 2+ clips to inspect 4-state Endomorphic Deltas across seams.</div>`;
  } else {
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Seam</th><th>Polarity</th><th>1→1 Carry</th><th>1→0 Quench</th><th>0→1 Ignite</th><th>0→0 Off</th>
            <th>Disp Ratio R</th><th>Signed Flux</th><th>Rect |Δ|</th><th>ΔCentroid (Hz)</th>
          </tr>
        </thead>
        <tbody>
          ${app.seams.map((s) => `
            <tr data-seam-idx="${s.seamIndex}">
              <td>#${s.seamIndex + 1} (${s.leftTitle} → ${s.rightTitle})</td>
              <td>${s.polarityTransition}</td>
              <td>${s.sustainedOn.toFixed(3)}</td>
              <td>${s.quenched.toFixed(3)}</td>
              <td>${s.ignited.toFixed(3)}</td>
              <td>${s.sustainedOff.toFixed(3)}</td>
              <td>${s.dispersionRatio.toFixed(2)}</td>
              <td>${s.signedFlux >= 0 ? "+" : ""}${s.signedFlux.toFixed(3)}</td>
              <td>${s.rectifiedFlux.toFixed(3)}</td>
              <td>${s.centroidDeltaHz >= 0 ? "+" : ""}${s.centroidDeltaHz.toFixed(1)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll("tr[data-seam-idx]").forEach((tr) => {
      tr.addEventListener("click", () => {
        app.selectedSeamIdx = parseInt(tr.dataset.seamIdx, 10);
        app.monMode = "seam";
        renderUI();
      });
    });
  }
}

// --- Image File Import (100% client-side) ---
async function importFiles(fileList) {
  for (const file of fileList) {
    const bmp = await createImageBitmap(file);
    const maxW = 1280, maxH = 720;
    const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
    const w = Math.max(8, Math.round(bmp.width * scale));
    const h = Math.max(8, Math.round(bmp.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cctx = c.getContext("2d");
    cctx.drawImage(bmp, 0, 0, w, h);
    const rgba = cctx.getImageData(0, 0, w, h).data;
    bmp.close();
    addMediaFromRGBA(file.name, new Uint8ClampedArray(rgba), w, h);
    app.statusNote = `Imported to Media Bay: ${file.name} (${w}×${h})`;
  }
  renderUI();
}

function downloadTimelineJSON() {
  const payload = {
    tool: "spectral-timeline",
    exportedAt: new Date().toISOString(),
    config: app.cfg,
    breathingEnabled: app.breathingEnabled,
    clips: app.clips.map((c, i) => ({ index: i, title: c.title, polarity: c.polarity, condMode: c.condMode, rmsDb: c.rmsDb })),
    seams: app.seams,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "spectral_timeline_deltas.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Event Wiring ---
function bindEvents() {
  $("btn-import-media").addEventListener("click", () => $("file-media").click());
  $("file-media").addEventListener("change", (ev) => {
    if (ev.target.files.length) importFiles(ev.target.files);
    ev.target.value = "";
  });

  const bay = $("media-bay");
  bay.addEventListener("dragover", (ev) => {
    if (app.dragPayload) return;
    ev.preventDefault();
    bay.classList.add("drag-over");
  });
  bay.addEventListener("dragleave", () => bay.classList.remove("drag-over"));
  bay.addEventListener("drop", (ev) => {
    if (app.dragPayload) return;
    ev.preventDefault();
    bay.classList.remove("drag-over");
    if (ev.dataTransfer.files.length) importFiles(ev.dataTransfer.files);
  });

  const strip = $("timeline-strip");
  strip.addEventListener("dragover", (ev) => {
    if (!app.dragPayload) return;
    ev.preventDefault();
    clearTimelineDropHighlights();
    strip.classList.add("drag-over");
  });
  strip.addEventListener("dragleave", (ev) => {
    if (ev.target === strip) strip.classList.remove("drag-over");
  });
  strip.addEventListener("drop", (ev) => {
    if (!app.dragPayload) return;
    ev.preventDefault();
    const payload = app.dragPayload;
    app.dragPayload = null;
    clearTimelineDropHighlights();
    if (payload.kind === "media") {
      addClip(payload.mediaId, ev.shiftKey ? "neg" : "pos", null);
      app.selectedClipIdx = app.clips.length - 1;
      app.monMode = "clip";
      renderUI();
    } else if (payload.kind === "clip" && app.clips.length > 1) {
      const lastIdx = app.clips.length - 1;
      if (payload.fromIndex !== lastIdx) {
        const [moved] = app.clips.splice(payload.fromIndex, 1);
        app.clips.push(moved);
        if (app.breathingEnabled) applyAlternatingPolarities("pos");
        app.selectedClipIdx = lastIdx;
        markDirty(`Moved ${moved.title} to end`);
      }
    }
  });

  $("btn-breathing").addEventListener("click", () => {
    app.breathingEnabled = !app.breathingEnabled;
    if (app.breathingEnabled) applyAlternatingPolarities("pos");
    else app.clips.forEach((c) => { c.polarity = "pos"; });
    markDirty(app.breathingEnabled ? "Breathing cycle ON (+ → − → +)" : "Breathing cycle OFF (all positive)");
  });

  $("btn-clear-tl").addEventListener("click", () => {
    stopPlayback(false);
    app.clips = [];
    markDirty("Cleared timeline");
  });

  $("cfg-preset").addEventListener("change", () => {
    const name = $("cfg-preset").value;
    if (PRESETS[name]) {
      app.cfg = { ...app.cfg, preset: name, ...PRESETS[name] };
      app.clips.forEach((c) => { c.condMode = app.cfg.condMode; });
      markDirty(`Loaded preset: ${name}`);
    }
  });

  $("btn-apply-cfg").addEventListener("click", () => {
    app.cfg.slotDurationS = Math.max(0.5, Math.min(10, parseFloat($("cfg-slot-s").value) || 2.0));
    app.cfg.fMinHz = Math.max(20, parseFloat($("cfg-fmin").value) || 120);
    app.cfg.fMaxHz = Math.max(app.cfg.fMinHz + 100, parseFloat($("cfg-fmax").value) || 18500);
    app.cfg.freqScale = $("cfg-scale").value;
    app.cfg.partials = Math.max(32, Math.min(516, parseInt($("cfg-partials").value, 10) || 320));
    app.cfg.condMode = $("cfg-cond").value;
    app.cfg.sr = parseInt($("cfg-sr").value, 10) || 48000;
    app.cfg.bitDepth = parseInt($("cfg-bit-depth").value, 10) || 24;
    app.cfg.preserveBreathingContrast = $("cfg-preserve-breathing").checked;
    app.clips.forEach((c) => { c.condMode = app.cfg.condMode; });
    markDirty("Updated synth settings (click Synthesize WAV)");
  });

  $("btn-gen-secp").addEventListener("click", () => {
    try {
      const { cards } = buildSecp256k1BreathingCards({
        kRaw: $("secp-k").value,
        count: parseInt($("secp-count").value, 10) || 1,
        alignMode: $("secp-align").value,
        bandMode: $("secp-band").value,
      });
      if ($("secp-replace").checked) app.clips = [];
      app.breathingEnabled = false;
      for (const card of cards) {
        const m = addMediaFromRGBA(card.filename, card.grid.rgba, card.grid.width, card.grid.height);
        addClip(m.mediaId, card.polarity, null);
      }
      app.breathingEnabled = true;
      app.selectedSeamIdx = 0;
      app.monMode = app.clips.length >= 2 ? "seam" : "clip";
      markDirty(`Generated ${cards.length / 2} secp256k1 K / K·G breathing pair(s)`);
    } catch (err) {
      app.statusNote = `secp256k1 error: ${err.message}`;
      renderUI();
    }
  });

  $("btn-gen-text").addEventListener("click", () => {
    const colsRaw = $("txt-cols").value.trim();
    const res = renderUniformPixelBoxRGBA({
      text: $("txt-payload").value,
      cols: colsRaw ? parseInt(colsRaw, 10) : null,
      bandMode: $("txt-band").value,
    });
    const m = addMediaFromRGBA(`hex_${res.rows}x${res.cols}.png`, res.rgba, res.width, res.height);
    const pol = $("txt-pol").value;
    if (pol === "neg") app.breathingEnabled = false;
    addClip(m.mediaId, pol, null);
    app.selectedClipIdx = app.clips.length - 1;
    app.monMode = "clip";
    renderUI();
  });

  $("btn-render").addEventListener("click", () => synthesizeMaster(false));
  $("btn-export-wav2").addEventListener("click", () => synthesizeMaster(true));
  $("btn-export-json").addEventListener("click", downloadTimelineJSON);

  document.querySelectorAll(".mon-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      app.monMode = btn.dataset.mon;
      renderUI();
    });
  });

  document.querySelectorAll(".dock-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dock-tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".dock-panel").forEach((p) => p.classList.toggle("active", p.id === `dock-${btn.dataset.dock}`));
    });
  });

  $("btn-play").addEventListener("click", () => {
    if (app.playing) stopPlayback(true);
    else startPlayback();
  });
  $("btn-rewind").addEventListener("click", () => {
    app.playOffset = 0;
    if (app.playing) startPlayback(0);
  });
  $("btn-loop").addEventListener("click", () => {
    app.loop = !app.loop;
    $("btn-loop").classList.toggle("active", app.loop);
    if (app.sourceNode) app.sourceNode.loop = app.loop;
  });
  $("gain-input").addEventListener("input", () => {
    if (app.gainNode) app.gainNode.gain.value = parseFloat($("gain-input").value) || 0.35;
  });

  canvas.addEventListener("click", (ev) => {
    if (app.monMode !== "master" || !app.audioBuffer) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
    const t = frac * totalDurationS();
    app.playOffset = t;
    if (app.playing) startPlayback(t);
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.code === "Space" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      ev.preventDefault();
      if (app.playing) stopPlayback(true);
      else startPlayback();
    }
  });
}

function seedStarterMedia() {
  // 1. Seed a crisp K=1 / K*G secp256k1 66-slot breathing pair right onto the timeline
  const { cards } = buildSecp256k1BreathingCards({ kRaw: "1", count: 1, alignMode: "66_header", bandMode: "full" });
  app.breathingEnabled = false;
  for (const card of cards) {
    const m = addMediaFromRGBA(card.filename, card.grid.rgba, card.grid.width, card.grid.height);
    addClip(m.mediaId, card.polarity, null);
  }
  app.breathingEnabled = true;

  // 2. Seed two extra Media Bay cards for quick drag-and-drop testing
  const textCard = renderUniformPixelBoxRGBA({ text: "RAMANUJAN CHIME 1729", cols: 10, bandMode: "rx11_lower" });
  addMediaFromRGBA("ramanujan_1729.png", textCard.rgba, textCard.width, textCard.height);

  const geo = renderGeometricTestRGBA(640, 360);
  addMediaFromRGBA("geometric_test.png", geo.rgba, geo.width, geo.height);

  app.monMode = "seam";
  app.selectedSeamIdx = 0;
  markDirty("Seeded K=1 / K·G breathing pair + 2 Media Bay cards · click Synthesize WAV");
}

bindEvents();
seedStarterMedia();
requestAnimationFrame(drawLoop);
