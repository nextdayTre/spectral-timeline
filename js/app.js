// Spectral Timeline — Resolve-Style Timeline + Fragment Audio Server (grz0zrg/fas) Backend
// Primary engine: Real-time C11 Fragment Audio Server (ws://127.0.0.1:3003, 512+ oscillators @ 60fps).
// Fallback / export: Stitched PNG Strip exporter + optional Offline Browser WAV Worker.

import {
  buildFreqGrid,
  computeSeamDelta,
  defaultConfig,
  renderPlaneGreenRGBA,
  renderSeamDeltaRGBA,
  rgbaToConditionedPlane,
} from "./dsp.js";
import { FAS_SYNTH_METHODS, FasClient } from "./fas_client.js";
import {
  buildSecp256k1BreathingCards,
  buildShapeMorphSequence,
  renderGeometricTestRGBA,
  renderUniformPixelBoxRGBA,
} from "./glyph_grid.js";

const MAX_CLIPS = 64;
const $ = (id) => document.getElementById(id);
const canvas = $("monitor-canvas");
const ctx = canvas.getContext("2d");

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
  // FAS settings (primary real-time backend)
  fasCfg: {
    address: localStorage.getItem("st-fas-addr") || "127.0.0.1:3003",
    h: 512,
    octaves: 10,
    baseFreq: 16.35,
    fps: 60,
    gain: 0.12,
    method: 0, // 0 = FAS_ADDITIVE
    stereoMode: "mono", // "mono" | "breath_lr"
  },
  fasConnected: false,
  fasLoad: null,
  fasLatencyMs: null,

  // Timeline & conditioning config
  cfg: {
    ...defaultConfig(),
    partials: 512,
    freqScale: "log",
    fMinHz: 16.35,
    fMaxHz: 16742,
    pps: 60,
  },
  breathingEnabled: true,
  dirty: true,
  rendered: false,
  lastRenderMs: 0,
  statusNote: "Connect local fas.exe (ws://127.0.0.1:3003) for live 512-osc Fragment synthesis",

  mediaSeq: 0,
  clipSeq: 0,
  mediaPool: new Map(),
  mediaOrder: [],
  clips: [],

  // Pre-synthesis aligned planes & canvases (synced 1:1 with FAS height `h`!)
  planes: [],
  planeP: 512,
  planeC: 120,
  clipThumbUrls: [],
  clipCanvases: [],
  clipDemodCanvases: [],
  clipEventCanvases: [],
  stitchedCanvas: null,
  seams: [],
  seamCanvases: [],

  // Optional offline WAV artifacts
  masterSpecCanvas: null,
  stftRawFrames: [],
  stftDemodFrames: [],
  stftEventFrames: [],
  masterWavUrl: null,
  audioBuffer: null,

  // View & transport state
  monMode: "timeline", // "timeline" | "clip" | "seam" | "video" | "master"
  videoMode: "demod",  // "demod" | "raw" | "event"
  selectedClipIdx: 0,
  selectedSeamIdx: 0,
  dragPayload: null,
  loop: true,
  playing: false,
  playEngine: "none",  // "fas" | "webaudio" | "none"
  playOffset: 0,
  playStartCtxTime: 0,
  audioCtx: null,
  gainNode: null,
  sourceNode: null,

  worker: null,
  jobSeq: 0,
  sliceScratch: new Uint8Array(512 * 4),
};

// --- Fragment Audio Server (grz0zrg/fas) Client ---
const fas = new FasClient({
  onStatus: (connected, msg) => {
    app.fasConnected = connected;
    if (!connected) {
      app.fasLoad = null;
      app.fasLatencyMs = null;
      if (app.playEngine === "fas") {
        app.playing = false;
        app.playEngine = "none";
        $("btn-play").textContent = "Play";
      }
    }
    app.statusNote = msg;
    renderUI();
  },
  onTelemetry: ({ load, latencyMs }) => {
    app.fasLoad = load;
    app.fasLatencyMs = latencyMs;
    $("fas-telemetry").textContent = `${load}% · ${latencyMs.toFixed(1)}ms`;
  },
  onError: (msg) => {
    $("fas-led").className = "led led-err";
    app.statusNote = msg;
    $("hud-note").textContent = msg;
  },
});

function setBusy(on, text = "Working…") {
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
  recomputeTimelinePlanes();
  renderUI();
}

// Compute exact FAS-aligned [h, C] partial planes, stitched timeline canvas, and 4-state Seam Deltas
function recomputeTimelinePlanes() {
  // Align plane vertical rows `P` 1:1 with FAS oscillator bank height `h` and log frequency lattice!
  const h = Number(app.fasCfg.h) || 512;
  const oct = Number(app.fasCfg.octaves) || 10;
  const baseF = Number(app.fasCfg.baseFreq) || 16.35;
  const maxF = baseF * Math.pow(2, oct);

  app.cfg.partials = h;
  app.cfg.fMinHz = baseF;
  app.cfg.fMaxHz = Math.min(22050, maxF);
  app.cfg.freqScale = "log";
  app.cfg.pps = Number(app.fasCfg.fps) || 60;

  if (app.sliceScratch.length !== h * 4) {
    app.sliceScratch = new Uint8Array(h * 4);
  }

  const freqs = buildFreqGrid(app.cfg);
  const bypassEq = true;

  app.planes = [];
  app.clipCanvases = [];
  app.clipDemodCanvases = [];
  app.clipThumbUrls = [];
  app.planeP = h;
  app.planeC = Math.max(8, Math.round((Number(app.cfg.slotDurationS) || 2.0) * (Number(app.fasCfg.fps) || 60)));

  const demodPlanes = [];
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

    // Demodulated positive plane for clean live flipbook / Event-Cam view
    const dem = new Float32Array(plane.length);
    if (clip.polarity === "neg") {
      for (let i = 0; i < plane.length; i++) dem[i] = 1.0 - plane[i];
    } else {
      dem.set(plane);
    }
    demodPlanes.push(dem);
    app.clipDemodCanvases.push(rgbaToCanvas(renderPlaneGreenRGBA(dem, P, C), C, P));
  }

  // Build stitched timeline canvas (what streams live to FAS!)
  if (app.clipCanvases.length > 0) {
    const st = document.createElement("canvas");
    st.width = app.planeC * app.clipCanvases.length;
    st.height = app.planeP;
    const sctx = st.getContext("2d");
    app.clipCanvases.forEach((cv, i) => sctx.drawImage(cv, i * app.planeC, 0));
    app.stitchedCanvas = st;
  } else {
    app.stitchedCanvas = null;
  }

  // Event-camera live diff frames & 4-state Endomorphic Seam Deltas
  app.clipEventCanvases = [];
  for (let k = 0; k < demodPlanes.length; k++) {
    const prev = demodPlanes[(k - 1 + demodPlanes.length) % demodPlanes.length];
    const curr = demodPlanes[k];
    const evRgba = new Uint8ClampedArray(app.planeP * app.planeC * 4);
    for (let r = 0; r < app.planeP; r++) {
      const srcRow = (app.planeP - 1 - r) * app.planeC;
      const dstRow = r * app.planeC;
      for (let c = 0; c < app.planeC; c++) {
        const d = curr[srcRow + c] - prev[srcRow + c];
        const o = (dstRow + c) * 4;
        if (d > 0.06) {
          const m = Math.min(1, d / 0.7);
          evRgba[o] = Math.round(m * 30);
          evRgba[o + 1] = Math.round(m * 235);
          evRgba[o + 2] = Math.round(m * 255);
        } else if (d < -0.06) {
          const m = Math.min(1, -d / 0.7);
          evRgba[o] = Math.round(m * 255);
          evRgba[o + 1] = Math.round(m * 110);
          evRgba[o + 2] = Math.round(m * 30);
        }
        evRgba[o + 3] = 255;
      }
    }
    app.clipEventCanvases.push(rgbaToCanvas(evRgba, app.planeC, app.planeP));
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

/**
 * Extract 1-pixel-wide vertical RGBA slice for Fragment Audio Server at `timeSec`.
 * FAS note.c expects pixel index 0 = lowest frequency (`baseFreq`), index h-1 = highest frequency!
 * Our `planes[clipIdx]` is already bottom-anchored (row 0 = lowest Hz).
 */
function getFasSliceAt(timeSec) {
  const n = app.planes.length;
  if (n === 0) return null;
  const dt = Number(app.cfg.slotDurationS) || 2.0;
  const clipIdx = Math.min(n - 1, Math.max(0, Math.floor(timeSec / dt)));
  const localFrac = Math.max(0, Math.min(0.999999, (timeSec - clipIdx * dt) / dt));
  const col = Math.min(app.planeC - 1, Math.floor(localFrac * app.planeC));

  const plane = app.planes[clipIdx];
  const h = app.planeP;
  const C = app.planeC;
  const out = app.sliceScratch;
  const isNeg = app.clips[clipIdx]?.polarity === "neg";
  const breathLR = app.fasCfg.stereoMode === "breath_lr";

  for (let r = 0; r < h; r++) {
    const v = plane[r * C + col];
    const amp = Math.min(255, Math.max(0, Math.round(v * 255)));
    const o = r * 4;
    if (breathLR) {
      out[o] = isNeg ? Math.round(amp * 0.35) : amp;     // Left (R)
      out[o + 1] = isNeg ? amp : Math.round(amp * 0.35); // Right (G)
    } else {
      out[o] = amp;     // Left (R)
      out[o + 1] = amp; // Right (G)
    }
    out[o + 2] = 0;     // Blue (secondary synth param)
    out[o + 3] = 255;   // Alpha
  }
  return out;
}

// --- Playback Control (Primary: FAS Live 60fps | Fallback: Offline WebAudio WAV) ---
function ensureAudio() {
  if (!app.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    app.audioCtx = new AC();
    app.gainNode = app.audioCtx.createGain();
    app.gainNode.gain.value = parseFloat($("gain-input").value) || 0.12;
    app.gainNode.connect(app.audioCtx.destination);
  }
  if (app.audioCtx.state === "suspended") app.audioCtx.resume();
}

function currentPlayheadSec() {
  const dur = Math.max(0.001, totalDurationS());
  if (!app.playing) return Math.max(0, Math.min(dur, app.playOffset));
  if (app.playEngine === "fas") return Math.max(0, Math.min(dur, app.playOffset));
  if (app.playEngine === "webaudio" && app.audioCtx) {
    const pos = app.playOffset + (app.audioCtx.currentTime - app.playStartCtxTime);
    return app.loop ? ((pos % dur) + dur) % dur : Math.min(dur, pos);
  }
  return app.playOffset;
}

function stopPlayback(keepOffset = true) {
  if (keepOffset && app.playing) app.playOffset = currentPlayheadSec();
  if (app.playEngine === "fas") {
    fas.stopStream(true);
  }
  if (app.sourceNode) {
    try { app.sourceNode.onended = null; app.sourceNode.stop(); } catch (_) {}
    app.sourceNode.disconnect();
    app.sourceNode = null;
  }
  app.playing = false;
  app.playEngine = "none";
  $("btn-play").textContent = "Play";
}

function startPlayback(offsetSec = null) {
  if (app.clips.length === 0) return;
  const dur = totalDurationS();
  const off = offsetSec !== null ? Math.max(0, Math.min(dur - 0.001, offsetSec)) : (app.playOffset % dur);

  // 1. Primary path: live stream straight to native C11 Fragment Audio Server!
  if (app.fasConnected) {
    stopPlayback(false);
    app.playOffset = off;
    app.playing = true;
    app.playEngine = "fas";
    $("btn-play").textContent = "Pause";
    fas.startStream({
      durationS: dur,
      startOffsetS: off,
      loop: app.loop,
      getSliceAt: getFasSliceAt,
      onTick: (pos) => { app.playOffset = pos; },
      onEnded: () => {
        app.playing = false;
        app.playEngine = "none";
        app.playOffset = 0;
        $("btn-play").textContent = "Play";
      },
    });
    return;
  }

  // 2. Fallback path: Offline Browser WAV if already synthesized
  if (app.audioBuffer) {
    ensureAudio();
    stopPlayback(false);
    const src = app.audioCtx.createBufferSource();
    src.buffer = app.audioBuffer;
    src.loop = app.loop;
    src.connect(app.gainNode);
    src.onended = () => {
      if (!app.loop) {
        app.playing = false;
        app.playEngine = "none";
        app.playOffset = 0;
        $("btn-play").textContent = "Play";
      }
    };
    src.start(0, off % (app.audioBuffer.duration || 1));
    app.sourceNode = src;
    app.playStartCtxTime = app.audioCtx.currentTime;
    app.playOffset = off;
    app.playing = true;
    app.playEngine = "webaudio";
    $("btn-play").textContent = "Pause";
    return;
  }

  app.statusNote = "FAS not connected — click Connect FAS (start fas.exe) or click Offline WAV";
  renderUI();
}

// --- Optional Offline Browser WAV Synthesis Fallback ---
function ensureWorker() {
  if (!app.worker) app.worker = new Worker("./js/synth_worker.js", { type: "module" });
  return app.worker;
}

function synthesizeOfflineWav({ autoDownload = false } = {}) {
  if (app.clips.length === 0) return;
  stopPlayback(false);
  recomputeTimelinePlanes();

  const worker = ensureWorker();
  const jobId = ++app.jobSeq;
  setBusy(true, "Rendering Offline WAV…");

  const planesCopy = app.planes.map((pl) => new Float32Array(pl));
  const transfers = planesCopy.map((pl) => pl.buffer);
  const offlineCfg = {
    ...app.cfg,
    sr: 48000,
    bitDepth: 24,
    fftSize: app.cfg.slotDurationS < 0.35 ? 1024 : 2048,
    phaseMode: "schroeder",
  };

  worker.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.jobId !== app.jobSeq) return;
    if (msg.type === "progress") {
      setBusy(true, `${msg.stage} (${Math.round(msg.frac * 100)}%)…`);
      return;
    }
    if (msg.type === "error") {
      setBusy(false);
      app.statusNote = `Offline WAV error: ${msg.message}`;
      renderUI();
      return;
    }
    if (msg.type === "done") {
      setBusy(false);
      app.lastRenderMs = msg.elapsedMs;
      app.clips.forEach((c, i) => { c.rmsDb = msg.slotRmsDb[i] ?? null; });
      if (app.masterWavUrl) URL.revokeObjectURL(app.masterWavUrl);
      const wavBlob = new Blob([msg.masterWavBuf], { type: "audio/wav" });
      app.masterWavUrl = URL.createObjectURL(wavBlob);
      app.masterSpecCanvas = rgbaToCanvas(new Uint8ClampedArray(msg.specRgbaBuf), msg.specW, msg.specH);
      try {
        ensureAudio();
        app.audioBuffer = await app.audioCtx.decodeAudioData(msg.playWavBuf.slice(0));
      } catch (_) {
        app.audioBuffer = null;
      }
      app.dirty = false;
      app.rendered = true;
      app.statusNote = `Offline WAV ready (${(wavBlob.size / 1024).toFixed(0)} KB · ${msg.elapsedMs.toFixed(0)} ms)`;
      renderUI();
      if (autoDownload) $("btn-dl-wav").click();
    }
  };

  worker.postMessage({ jobId, planes: planesCopy, P: app.planeP, C: app.planeC, cfg: offlineCfg }, transfers);
}

// --- Exports: Stitched Breathing PNG Strip + Seam Delta JSON ---
function exportStitchedStripPng() {
  if (!app.stitchedCanvas) return;
  const a = document.createElement("a");
  a.href = app.stitchedCanvas.toDataURL("image/png");
  a.download = `spectral_timeline_strip_${app.clips.length}clips_${app.planeP}h.png`;
  a.click();
}

function downloadTimelineJSON() {
  const payload = {
    tool: "spectral-timeline-fas",
    exportedAt: new Date().toISOString(),
    fasConfig: app.fasCfg,
    slotDurationS: app.cfg.slotDurationS,
    breathingEnabled: app.breathingEnabled,
    clips: app.clips.map((c, i) => ({ index: i, title: c.title, polarity: c.polarity, condMode: c.condMode })),
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

  const dur = Math.max(0.001, totalDurationS());
  const t = currentPlayheadSec();

  if (app.monMode === "video") {
    const frames = app.videoMode === "raw"
      ? app.clipCanvases
      : app.videoMode === "event"
        ? app.clipEventCanvases
        : app.clipDemodCanvases;
    if (frames.length > 0) {
      const idx = app.playing
        ? Math.min(frames.length - 1, Math.floor((t / dur) * frames.length))
        : Math.min(frames.length - 1, app.selectedClipIdx);
      const fr = frames[idx];
      const padY = 44 * dpr;
      const drawH = Math.max(40, h - padY * 1.3);
      const drawW = Math.min(w - 24 * dpr, drawH * (4 / 3));
      const dx = Math.floor((w - drawW) / 2);
      const dy = Math.floor((h - drawH) / 2 + 8 * dpr);

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fr, dx, dy, drawW, drawH);
      ctx.strokeStyle = app.clips[idx]?.polarity === "neg" ? "rgba(72, 201, 240, 0.55)" : "rgba(56, 212, 122, 0.55)";
      ctx.lineWidth = Math.max(1.5, dpr);
      ctx.strokeRect(dx, dy, drawW, drawH);

      // Playhead bar
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(dx, dy + drawH + 6 * dpr, drawW, 4 * dpr);
      ctx.fillStyle = "#38d47a";
      ctx.fillRect(dx, dy + drawH + 6 * dpr, drawW * (t / dur), 4 * dpr);

      const polTag = app.clips[idx]?.polarity === "neg" ? "− NEG" : "+ POS";
      $("video-frame-badge").textContent = `Frame ${idx + 1}/${frames.length} · ${polTag} · ${app.clips[idx]?.title || ""}`;
      $("hud-time").textContent = `${t.toFixed(2)} / ${totalDurationS().toFixed(2)} s`;
    }
    requestAnimationFrame(drawLoop);
    return;
  }

  let srcCanvas = null;
  if (app.monMode === "timeline") srcCanvas = app.stitchedCanvas;
  else if (app.monMode === "master") srcCanvas = app.masterSpecCanvas;
  else if (app.monMode === "seam") srcCanvas = app.seamCanvases[app.selectedSeamIdx] || null;
  else srcCanvas = app.clipCanvases[app.selectedClipIdx] || null;

  if (srcCanvas) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(srcCanvas, 0, 0, w, h);
  } else {
    ctx.fillStyle = "#5c677a";
    ctx.font = `${13 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("Add clips to Timeline · Connect FAS (ws://127.0.0.1:3003) · Press Space to stream live", w / 2, h / 2);
  }

  // Draw slot dividers & live FAS / WebAudio scanline on stitched views
  if ((app.monMode === "timeline" || app.monMode === "master") && app.clips.length > 0) {
    const n = app.clips.length;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = Math.max(1, dpr);
    for (let i = 1; i < n; i++) {
      const x = (i / n) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    const px = (t / dur) * w;
    ctx.strokeStyle = app.fasConnected ? "#ffd24c" : "#38d47a";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }
  $("hud-time").textContent = `${t.toFixed(2)} / ${totalDurationS().toFixed(2)} s`;

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
  $("fas-led").className = app.fasConnected ? "led led-on" : "led led-off";
  $("btn-fas-connect").textContent = app.fasConnected ? "Disconnect FAS" : "Connect FAS";
  $("btn-fas-connect").classList.toggle("active", app.fasConnected);
  if (!app.fasConnected) $("fas-telemetry").textContent = "";

  $("hud-note").textContent = app.statusNote;
  const methodName = (FAS_SYNTH_METHODS.find((m) => m.id === app.fasCfg.method) || FAS_SYNTH_METHODS[0]).name;
  $("engine-badge").textContent = app.fasConnected
    ? `Engine: Fragment FAS LIVE (${app.fasCfg.h} oscs · ${methodName} · ${app.fasCfg.fps} fps)`
    : app.audioBuffer
      ? "Engine: Offline Browser WAV Ready (or click Connect FAS)"
      : "Engine: FAS Offline — start fas.exe & click Connect FAS (or Offline WAV)";

  const dl = $("btn-dl-wav");
  dl.classList.toggle("hidden", !app.masterWavUrl);
  if (app.masterWavUrl) dl.href = app.masterWavUrl;

  $("breathing-rms-lbl").textContent = `${app.fasCfg.h} oscs · ${app.fasCfg.baseFreq} Hz × 2^${app.fasCfg.octaves} (${Math.round(app.fasCfg.baseFreq * Math.pow(2, app.fasCfg.octaves))} Hz)`;

  const bBtn = $("btn-breathing");
  bBtn.textContent = `Breathing (+/−): ${app.breathingEnabled ? "ON" : "OFF"}`;
  bBtn.classList.toggle("active", app.breathingEnabled);

  document.querySelectorAll(".mon-tab").forEach((b) => b.classList.toggle("active", b.dataset.mon === app.monMode));
  $("seam-legend").classList.toggle("hidden", app.monMode !== "seam");
  $("video-bar").classList.toggle("hidden", app.monMode !== "video");
  document.querySelectorAll(".vmode-btn").forEach((b) => b.classList.toggle("active", b.dataset.vmode === app.videoMode));

  if (app.monMode === "timeline") {
    $("mon-info").textContent = `Stitched FAS Bank (${app.clips.length} clips · ${app.planeP} oscs × ${app.planeC * app.clips.length} cols) · Click canvas to scrub`;
  } else if (app.monMode === "video") {
    const fps = (1 / Math.max(0.05, Number(app.cfg.slotDurationS) || 0.5)).toFixed(1);
    $("mon-info").textContent = `Live Flipbook (${fps} fps) · Synced to ${app.fasConnected ? "Fragment FAS" : "Timeline"} Playhead`;
  } else if (app.monMode === "master") {
    $("mon-info").textContent = app.rendered ? "Offline Browser WAV STFT Preview" : "Click Offline WAV to generate a browser WAV preview";
  } else if (app.monMode === "seam") {
    const sm = app.seams[app.selectedSeamIdx];
    $("mon-info").textContent = sm
      ? `Seam ${sm.seamIndex + 1}: ${sm.polarityTransition} · Disp R=${sm.dispersionRatio.toFixed(2)} · Flux |Δ|=${sm.rectifiedFlux.toFixed(3)} · Δf=${sm.centroidDeltaHz >= 0 ? "+" : ""}${sm.centroidDeltaHz} Hz`
      : "Add 2+ clips to inspect Seam Delta";
  } else {
    const clip = app.clips[app.selectedClipIdx];
    $("mon-info").textContent = clip
      ? `Slot ${app.selectedClipIdx + 1}: ${clip.title} · ${clip.polarity === "neg" ? "NEGATIVE (black on green)" : "POSITIVE (green on black)"}`
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
          <button class="media-add-btn" data-pol="pos">+ Add</button>
          <button class="media-add-btn" data-pol="neg" style="color: var(--cyan)">− Add</button>
        </div>
      </div>
    `;
    card.addEventListener("dragstart", (ev) => {
      app.dragPayload = { kind: "media", mediaId: m.mediaId };
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", `media:${m.mediaId}`);
    });
    card.addEventListener("dragend", () => { app.dragPayload = null; clearTimelineDropHighlights(); });
    card.querySelector(".media-del-btn").addEventListener("click", (ev) => { ev.stopPropagation(); deleteMedia(m.mediaId); });
    card.querySelectorAll(".media-add-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const prevB = app.breathingEnabled;
        if (btn.dataset.pol === "neg") app.breathingEnabled = false;
        addClip(m.mediaId, btn.dataset.pol, null);
        if (btn.dataset.pol === "pos") app.breathingEnabled = prevB;
        app.selectedClipIdx = app.clips.length - 1;
        renderUI();
      });
    });
    grid.appendChild(card);
  });

  // Timeline Strip
  const dt = Number(app.cfg.slotDurationS) || 2.0;
  $("tl-summary").textContent = `${app.clips.length} / ${MAX_CLIPS} clips · ${totalDurationS().toFixed(2)} s`;
  const strip = $("timeline-strip");
  strip.innerHTML = "";
  app.clips.forEach((c, idx) => {
    const card = document.createElement("div");
    card.className = `clip-card pol-${c.polarity}` + (idx === app.selectedClipIdx ? " selected" : "");
    card.draggable = true;
    card.innerHTML = `
      <div class="clip-top mono">
        <span>#${String(idx + 1).padStart(2, "0")} · ${(idx * dt).toFixed(2)}s</span>
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
        <button class="pol-btn ${c.polarity}" data-act="pol">${c.polarity === "neg" ? "− NEG" : "+ POS"}</button>
      </div>
    `;
    card.addEventListener("dragstart", (ev) => {
      app.dragPayload = { kind: "clip", fromIndex: idx };
      card.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => { app.dragPayload = null; card.classList.remove("dragging"); clearTimelineDropHighlights(); });
    card.addEventListener("dragover", (ev) => {
      if (!app.dragPayload) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = card.getBoundingClientRect();
      clearTimelineDropHighlights();
      card.classList.add((ev.clientX - rect.left) < rect.width / 2 ? "drop-before" : "drop-after");
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
      const tSeek = idx * dt;
      app.playOffset = tSeek;
      if (app.playing) startPlayback(tSeek);
      if (app.monMode !== "video" && app.monMode !== "timeline") app.monMode = "clip";
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

  // FAS controls sync
  const mSel = $("fas-method");
  if (mSel.options.length === 0) {
    FAS_SYNTH_METHODS.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = String(m.id);
      opt.textContent = m.name;
      mSel.appendChild(opt);
    });
  }
  mSel.value = String(app.fasCfg.method);
  $("fas-addr").value = app.fasCfg.address;
  $("fas-height").value = String(app.fasCfg.h);
  $("fas-octaves").value = String(app.fasCfg.octaves);
  $("fas-basefreq").value = app.fasCfg.baseFreq;
  $("fas-fps").value = String(app.fasCfg.fps);
  $("fas-stereo").value = app.fasCfg.stereoMode;
  $("cfg-slot-s").value = app.cfg.slotDurationS;
  $("cfg-cond").value = app.cfg.condMode;

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

function syncFasConfigFromUI() {
  app.fasCfg.h = parseInt($("fas-height").value, 10) || 512;
  app.fasCfg.octaves = Math.max(2, Math.min(12, parseInt($("fas-octaves").value, 10) || 10));
  app.fasCfg.baseFreq = Math.max(8, parseFloat($("fas-basefreq").value) || 16.35);
  app.fasCfg.fps = parseInt($("fas-fps").value, 10) || 60;
  app.fasCfg.method = parseInt($("fas-method").value, 10) || 0;
  app.fasCfg.stereoMode = $("fas-stereo").value || "mono";
  app.fasCfg.gain = parseFloat($("gain-input").value) || 0.12;
  app.cfg.slotDurationS = Math.max(0.125, Math.min(10, parseFloat($("cfg-slot-s").value) || 2.0));
  app.cfg.condMode = $("cfg-cond").value || "raw";
  app.clips.forEach((c) => { c.condMode = app.cfg.condMode; });

  fas.syncSettings(
    { h: app.fasCfg.h, octaves: app.fasCfg.octaves, baseFreq: app.fasCfg.baseFreq, floatData: false },
    { fps: app.fasCfg.fps, gain: app.fasCfg.gain, method: app.fasCfg.method }
  );
  markDirty(`Synced FAS bank (${app.fasCfg.h} oscs, ${app.fasCfg.octaves} oct, ${app.fasCfg.baseFreq} Hz)`);
}

function bindEvents() {
  // FAS connect / live synth method / gain
  $("fas-addr").addEventListener("change", () => {
    app.fasCfg.address = $("fas-addr").value.trim() || "127.0.0.1:3003";
    localStorage.setItem("st-fas-addr", app.fasCfg.address);
  });
  $("btn-fas-connect").addEventListener("click", () => {
    if (app.fasConnected) {
      fas.disconnect();
    } else {
      app.fasCfg.address = $("fas-addr").value.trim() || "127.0.0.1:3003";
      localStorage.setItem("st-fas-addr", app.fasCfg.address);
      fas.bank = { h: app.fasCfg.h, octaves: app.fasCfg.octaves, baseFreq: app.fasCfg.baseFreq, floatData: false };
      fas.synth = { fps: app.fasCfg.fps, gain: app.fasCfg.gain, method: app.fasCfg.method };
      fas.connect(app.fasCfg.address);
    }
  });
  $("fas-method").addEventListener("change", () => {
    app.fasCfg.method = parseInt($("fas-method").value, 10) || 0;
    fas.setSynthMethod(app.fasCfg.method);
    renderUI();
  });
  $("fas-stereo").addEventListener("change", () => {
    app.fasCfg.stereoMode = $("fas-stereo").value;
  });
  $("btn-apply-cfg").addEventListener("click", syncFasConfigFromUI);

  $("btn-import-media").addEventListener("click", () => $("file-media").click());
  $("file-media").addEventListener("change", (ev) => {
    if (ev.target.files.length) importFiles(ev.target.files);
    ev.target.value = "";
  });

  const bay = $("media-bay");
  bay.addEventListener("dragover", (ev) => { if (!app.dragPayload) { ev.preventDefault(); bay.classList.add("drag-over"); } });
  bay.addEventListener("dragleave", () => bay.classList.remove("drag-over"));
  bay.addEventListener("drop", (ev) => {
    if (app.dragPayload) return;
    ev.preventDefault();
    bay.classList.remove("drag-over");
    if (ev.dataTransfer.files.length) importFiles(ev.dataTransfer.files);
  });

  const strip = $("timeline-strip");
  strip.addEventListener("dragover", (ev) => { if (app.dragPayload) { ev.preventDefault(); clearTimelineDropHighlights(); strip.classList.add("drag-over"); } });
  strip.addEventListener("dragleave", (ev) => { if (ev.target === strip) strip.classList.remove("drag-over"); });
  strip.addEventListener("drop", (ev) => {
    if (!app.dragPayload) return;
    ev.preventDefault();
    const payload = app.dragPayload;
    app.dragPayload = null;
    clearTimelineDropHighlights();
    if (payload.kind === "media") {
      addClip(payload.mediaId, ev.shiftKey ? "neg" : "pos", null);
      app.selectedClipIdx = app.clips.length - 1;
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

  function stageShapeMorphAnimation(andPlay = false) {
    const bpm = parseFloat($("anim-bpm").value) || 120;
    const beatsPerFrame = parseFloat($("anim-bpf").value) || 0.5;
    const framesPerLeg = parseInt($("anim-fpl").value, 10) || 3;
    const style = $("anim-style").value || "outline";
    const breathing = $("anim-breathing").checked;

    const seq = buildShapeMorphSequence({ bpm, beatsPerFrame, framesPerLeg, style, breathing });
    app.cfg.slotDurationS = seq.slotDurationS;
    app.clips = [];
    app.breathingEnabled = false;
    for (const fr of seq.frames) {
      const m = addMediaFromRGBA(fr.filename, fr.grid.rgba, fr.grid.width, fr.grid.height);
      addClip(m.mediaId, fr.polarity, null);
    }
    app.breathingEnabled = breathing;
    app.selectedClipIdx = 0;
    app.selectedSeamIdx = 0;
    app.monMode = andPlay ? "video" : "timeline";
    markDirty(`Staged ${seq.frames.length}-frame Tri→Cir→Tri→Sq morph @ ${seq.bpm} BPM (${seq.slotDurationS}s/frame)`);
    if (andPlay) {
      if (app.fasConnected) {
        startPlayback(0);
      } else {
        synthesizeOfflineWav({ autoDownload: false });
      }
    }
  }

  $("btn-gen-anim").addEventListener("click", () => stageShapeMorphAnimation(false));
  $("btn-gen-anim-play").addEventListener("click", () => stageShapeMorphAnimation(true));

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
      app.monMode = "timeline";
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
    renderUI();
  });

  $("btn-render").addEventListener("click", () => synthesizeOfflineWav({ autoDownload: false }));
  $("btn-export-wav2").addEventListener("click", () => synthesizeOfflineWav({ autoDownload: true }));
  $("btn-export-strip").addEventListener("click", exportStitchedStripPng);
  $("btn-export-json").addEventListener("click", downloadTimelineJSON);

  document.querySelectorAll(".mon-tab").forEach((btn) => {
    btn.addEventListener("click", () => { app.monMode = btn.dataset.mon; renderUI(); });
  });
  document.querySelectorAll(".vmode-btn").forEach((btn) => {
    btn.addEventListener("click", () => { app.videoMode = btn.dataset.vmode; renderUI(); });
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
    const g = parseFloat($("gain-input").value) || 0.12;
    app.fasCfg.gain = g;
    fas.setGain(g);
    if (app.gainNode) app.gainNode.gain.value = g;
  });

  canvas.addEventListener("click", (ev) => {
    if (app.monMode !== "timeline" && app.monMode !== "master") return;
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
  const { cards } = buildSecp256k1BreathingCards({ kRaw: "1", count: 1, alignMode: "66_header", bandMode: "full" });
  app.breathingEnabled = false;
  for (const card of cards) {
    const m = addMediaFromRGBA(card.filename, card.grid.rgba, card.grid.width, card.grid.height);
    addClip(m.mediaId, card.polarity, null);
  }
  app.breathingEnabled = true;

  const textCard = renderUniformPixelBoxRGBA({ text: "RAMANUJAN CHIME 1729", cols: 10, bandMode: "rx11_lower" });
  addMediaFromRGBA("ramanujan_1729.png", textCard.rgba, textCard.width, textCard.height);

  const geo = renderGeometricTestRGBA(640, 360);
  addMediaFromRGBA("geometric_test.png", geo.rgba, geo.width, geo.height);

  app.monMode = "timeline";
  markDirty("Connect local fas.exe (ws://127.0.0.1:3003) & press Space to stream 512 native oscillators live");
}

bindEvents();
seedStarterMedia();
requestAnimationFrame(drawLoop);
