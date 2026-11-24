// Spectral Timeline — Resolve-Style Timeline + Fragment Audio Server (grz0zrg/fas)
// + Flipbook Image Sequence (up to 256 frames) & True Neuromorphic Event-Camera Audio Engine.

import {
  buildFreqGrid,
  computeEventCameraSequence,
  computeSeamDelta,
  defaultConfig,
  renderEventOnOffRGBA,
  renderPlaneGreenRGBA,
  renderSeamDeltaRGBA,
  rgbaToChromaWarmthPlane,
  rgbaToConditionedPlane,
} from "./dsp.js";
import { FAS_SYNTH_METHODS, FasClient } from "./fas_client.js";
import {
  buildPlasmaShowreelSequence,
  buildSecp256k1BreathingCards,
  buildShapeMorphSequence,
  renderGeometricTestRGBA,
  renderUniformPixelBoxRGBA,
} from "./glyph_grid.js";
import {
  CARTRIDGE_SCHEMA,
  CARTRIDGE_TEXT_KEY,
  attachId3v2ToMp3,
  decodeLayer2FromCoverRGBA,
  encodeAudioToMp3,
  extractPngTextChunks,
  injectPngTextChunk,
  parseApicFromMp3,
  renderCartridgeCoverRGBA,
} from "./mp3_cartridge.js";

const MAX_CLIPS = 256;
const HI_RES_W = 240;
const HI_RES_H = 135;
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

function makeThumbDataUrl(rgba, w, h, tw = 192, th = 108) {
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
    method: 0,
    stereoMode: "mono",
  },
  fasConnected: false,
  fasLoad: null,
  fasLatencyMs: null,

  // Flipbook & Event-Camera Audio Settings
  flipbook: {
    synthSource: "full",   // "full" | "event" | "hybrid"
    trailDecay: 0.45,      // phosphor persistence 0.0 .. 0.72
    chromaBlue: true,      // route warm/cool pixel color -> FAS Blue timbre param
    hiResMode: true,       // true = crisp 16:9 240x135 flipbook, false = quantized audio sonar grid
    peakCutIdx: -1,
    peakCutScore: 0,
  },

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
  statusNote: "Connect local fas.exe (ws://127.0.0.1:3003) or load a Flipbook Sequence",

  mediaSeq: 0,
  clipSeq: 0,
  mediaPool: new Map(), // mediaId -> { mediaId, filename, width, height, rgba, thumbUrl, origCanvas }
  mediaOrder: [],
  clips: [],

  // Audio-grid synthesis planes ([h, C])
  planes: [],           // polarity-applied full-frame planes
  demodPlanes: [],      // positive un-flipped planes
  eventOnPlanes: [],    // Event-Cam +ON advancing motion (Left / R)
  eventOffPlanes: [],   // Event-Cam -OFF receding motion (Right / G)
  eventMixPlanes: [],   // Event-Cam max(on, off) for mono WAV
  chromaPlanes: [],     // Color warmth [h, C] for FAS Blue channel
  planeP: 512,
  planeC: 120,

  // Visual caches (audio-grid sonar vs. crisp 16:9 Hi-Res flipbook)
  clipThumbUrls: [],
  clipCanvases: [],
  clipDemodCanvases: [],
  clipEventCanvases: [],
  hiResOrigCanvases: [],
  hiResRawCanvases: [],
  hiResDemodCanvases: [],
  hiResEventCanvases: [],
  stitchedCanvas: null,
  seams: [],
  seamCanvases: [],

  // Optional offline WAV & MP3 Cartridge artifacts
  masterSpecCanvas: null,
  masterWavUrl: null,
  audioBuffer: null,
  lastAudioF32: null,
  lastAudioSr: 48000,
  blurryMp3Buffer: null,
  apicCoverCanvas: null,
  cartridgeLayer: "",
  abSource: "expanded", // "expanded" | "mp3"
  activeRecipe: {
    type: "secp256k1",
    kRaw: "1",
    count: 1,
    alignMode: "66_header",
    bandMode: "full",
  },

  // View & transport state
  monMode: "timeline", // "timeline" | "clip" | "seam" | "video" | "master"
  videoMode: "event",  // "event" | "demod" | "raw" | "orig"
  selectedClipIdx: 0,
  selectedSeamIdx: 0,
  dragPayload: null,
  loop: true,
  playing: false,
  playEngine: "none",
  playOffset: 0,
  playStartCtxTime: 0,
  audioCtx: null,
  gainNode: null,
  sourceNode: null,

  worker: null,
  jobSeq: 0,
  sliceScratch: new Uint8Array(512 * 4),
};

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
function totalDurationS() { return app.clips.length * (Number(app.cfg.slotDurationS) || 2.0); }

function addMediaFromRGBA(filename, rgba, width, height) {
  const mediaId = nextMediaId();
  const origCanvas = rgbaToCanvas(rgba, width, height);
  const thumbUrl = makeThumbDataUrl(rgba, width, height);
  const item = { mediaId, filename, width, height, rgba, thumbUrl, origCanvas };
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

function addClip(mediaId, polarity = "pos", insertIndex = null, skipRecompute = false) {
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
  if (!skipRecompute) {
    if (app.breathingEnabled && insertIndex === null && polarity === "pos") {
      applyAlternatingPolarities("pos");
    }
    markDirty(`Added ${clip.title} (${clip.polarity})`);
  }
}

function markDirty(note) {
  app.dirty = true;
  app.statusNote = note;
  recomputeTimelinePlanes();
  renderUI();
}

// Compute FAS-aligned [h, C] planes, Event-Cam (+ON/-OFF) + Phosphor Trail, Chroma Warmth,
// Hi-Res 16:9 flipbook frames, Scene-Cut Peak detector, and 4-state Seam Deltas.
function recomputeTimelinePlanes() {
  const h = Number(app.fasCfg.h) || 512;
  const oct = Number(app.fasCfg.octaves) || 10;
  const baseF = Number(app.fasCfg.baseFreq) || 16.35;
  const maxF = baseF * Math.pow(2, oct);

  app.cfg.partials = h;
  app.cfg.fMinHz = baseF;
  app.cfg.fMaxHz = Math.min(22050, maxF);
  app.cfg.freqScale = "log";
  app.cfg.pps = Number(app.fasCfg.fps) || 60;

  if (app.sliceScratch.length !== h * 4) app.sliceScratch = new Uint8Array(h * 4);

  const freqs = buildFreqGrid(app.cfg);
  const nClips = app.clips.length;
  const fastStripMode = nClips > 28; // skip heavy per-clip dataURL PNG encoding for 100-frame sequences

  app.planes = [];
  app.demodPlanes = [];
  app.chromaPlanes = [];
  app.clipCanvases = [];
  app.clipDemodCanvases = [];
  app.clipThumbUrls = [];
  app.hiResOrigCanvases = [];
  app.hiResRawCanvases = [];
  app.hiResDemodCanvases = [];
  app.hiResEventCanvases = [];

  app.planeP = h;
  app.planeC = Math.max(8, Math.round((Number(app.cfg.slotDurationS) || 2.0) * (Number(app.fasCfg.fps) || 60)));

  // 1. Audio-grid planes [h, C] + Chroma Warmth + Hi-Res 240x135 Flipbook luma
  const hiResLumaList = [];
  const hiCfg = { ...app.cfg, partials: HI_RES_H, pps: HI_RES_W / Math.max(0.05, Number(app.cfg.slotDurationS) || 0.125), featherMs: 0 };

  for (let i = 0; i < nClips; i++) {
    const clip = app.clips[i];
    const item = app.mediaPool.get(clip.mediaId);
    if (!item) continue;

    const { plane, P, C } = rgbaToConditionedPlane(
      item.rgba, item.width, item.height, app.cfg, clip.polarity, clip.condMode, true
    );
    app.planeP = P;
    app.planeC = C;
    app.planes.push(plane);

    const dem = new Float32Array(plane.length);
    if (clip.polarity === "neg") {
      for (let k = 0; k < plane.length; k++) dem[k] = 1.0 - plane[k];
    } else {
      dem.set(plane);
    }
    app.demodPlanes.push(dem);
    app.chromaPlanes.push(rgbaToChromaWarmthPlane(item.rgba, item.width, item.height, P, C));

    const greenRgba = renderPlaneGreenRGBA(plane, P, C);
    const cv = rgbaToCanvas(greenRgba, C, P);
    app.clipCanvases.push(cv);
    app.clipDemodCanvases.push(rgbaToCanvas(renderPlaneGreenRGBA(dem, P, C), C, P));
    // Fast thumbnail strategy: reuse Media Bay thumbnail for >28 clips so 100-frame DBZ timeline stays 60fps
    app.clipThumbUrls.push(fastStripMode ? item.thumbUrl : cv.toDataURL("image/png"));

    // Hi-Res 240x135 visual flipbook frames (always crisp 16:9 anime detail!)
    app.hiResOrigCanvases.push(item.origCanvas);
    const hiPos = rgbaToConditionedPlane(item.rgba, item.width, item.height, hiCfg, "pos", clip.condMode, true);
    hiResLumaList.push(hiPos.plane);
    app.hiResDemodCanvases.push(rgbaToCanvas(renderPlaneGreenRGBA(hiPos.plane, HI_RES_H, HI_RES_W), HI_RES_W, HI_RES_H));

    if (clip.polarity === "neg") {
      const hiNeg = new Float32Array(hiPos.plane.length);
      for (let k = 0; k < hiNeg.length; k++) hiNeg[k] = 1.0 - hiPos.plane[k];
      app.hiResRawCanvases.push(rgbaToCanvas(renderPlaneGreenRGBA(hiNeg, HI_RES_H, HI_RES_W), HI_RES_W, HI_RES_H));
    } else {
      app.hiResRawCanvases.push(app.hiResDemodCanvases[app.hiResDemodCanvases.length - 1]);
    }
  }

  // 2. Neuromorphic Event-Camera (+ON / -OFF) with Phosphor Persistence Trail
  const evAudio = computeEventCameraSequence(app.demodPlanes, app.planeP, app.planeC, {
    threshold: 0.045,
    gain: 1.85,
    decay: app.flipbook.trailDecay,
  });
  app.eventOnPlanes = evAudio.onPlanes;
  app.eventOffPlanes = evAudio.offPlanes;
  app.eventMixPlanes = evAudio.mixPlanes;

  app.clipEventCanvases = [];
  for (let k = 0; k < app.eventOnPlanes.length; k++) {
    app.clipEventCanvases.push(
      rgbaToCanvas(renderEventOnOffRGBA(app.eventOnPlanes[k], app.eventOffPlanes[k], app.planeP, app.planeC), app.planeC, app.planeP)
    );
  }

  const evHi = computeEventCameraSequence(hiResLumaList, HI_RES_H, HI_RES_W, {
    threshold: 0.045,
    gain: 2.1,
    decay: app.flipbook.trailDecay,
  });
  for (let k = 0; k < evHi.onPlanes.length; k++) {
    app.hiResEventCanvases.push(
      rgbaToCanvas(renderEventOnOffRGBA(evHi.onPlanes[k], evHi.offPlanes[k], HI_RES_H, HI_RES_W), HI_RES_W, HI_RES_H)
    );
  }

  // Detect strongest scene cut (ignoring wrap-around k=0 when >2 frames)
  let peakIdx = -1;
  let peakScore = 0;
  for (let k = 1; k < evHi.frameMotionScores.length; k++) {
    if (evHi.frameMotionScores[k] > peakScore) {
      peakScore = evHi.frameMotionScores[k];
      peakIdx = k;
    }
  }
  app.flipbook.peakCutIdx = peakIdx;
  app.flipbook.peakCutScore = peakScore;

  // 3. Stitched timeline canvas (reflects active Synth Source: Event-Cam, Hybrid, or Full Frame!)
  if (nClips > 0) {
    const srcArr = app.flipbook.synthSource === "event" ? app.clipEventCanvases : app.clipCanvases;
    const totalW = Math.min(4096, app.planeC * nClips);
    const colW = totalW / nClips;
    const st = document.createElement("canvas");
    st.width = totalW;
    st.height = app.planeP;
    const sctx = st.getContext("2d");
    srcArr.forEach((cv, i) => sctx.drawImage(cv, i * colW, 0, colW, app.planeP));
    app.stitchedCanvas = st;
  } else {
    app.stitchedCanvas = null;
  }

  // 4. 4-State Endomorphic Seam Deltas
  app.seams = [];
  app.seamCanvases = [];
  for (let i = 0; i < app.planes.length - 1; i++) {
    const d = computeSeamDelta(
      app.planes[i], app.planes[i + 1], app.planeP, app.planeC, freqs, app.clips[i], app.clips[i + 1], i
    );
    app.seams.push(d);
    if (!fastStripMode) {
      app.seamCanvases.push(
        rgbaToCanvas(renderSeamDeltaRGBA(app.planes[i], app.planes[i + 1], app.planeP, app.planeC), app.planeC, app.planeP)
      );
    }
  }

  if (app.selectedClipIdx >= app.clips.length) app.selectedClipIdx = Math.max(0, app.clips.length - 1);
  if (app.selectedSeamIdx >= app.seams.length) app.selectedSeamIdx = Math.max(0, app.seams.length - 1);
}

function getSeamCanvasLazy(seamIdx) {
  if (app.seamCanvases[seamIdx]) return app.seamCanvases[seamIdx];
  if (seamIdx >= 0 && seamIdx < app.planes.length - 1) {
    const cv = rgbaToCanvas(
      renderSeamDeltaRGBA(app.planes[seamIdx], app.planes[seamIdx + 1], app.planeP, app.planeC),
      app.planeC,
      app.planeP
    );
    app.seamCanvases[seamIdx] = cv;
    return cv;
  }
  return null;
}

/**
 * Extract 1-pixel-wide vertical RGBA slice for Fragment Audio Server at `timeSec`.
 * Supports:
 *   - "event":  Left (R) = +ON advancing edges, Right (G) = -OFF receding edges
 *   - "hybrid": 25% alternating breathing bed + 100% Event-Cam stereo motion spikes
 *   - "full":   Full frame (+ / - breathing, center mono or L/R breathing split)
 * Plus optional Chroma Warmth -> Blue (B) secondary FAS synthesis parameter!
 */
function getFasSliceAt(timeSec) {
  const n = app.planes.length;
  if (n === 0) return null;
  const dt = Number(app.cfg.slotDurationS) || 0.125;
  const clipIdx = Math.min(n - 1, Math.max(0, Math.floor(timeSec / dt)));
  const localFrac = Math.max(0, Math.min(0.999999, (timeSec - clipIdx * dt) / dt));
  const col = Math.min(app.planeC - 1, Math.floor(localFrac * app.planeC));

  const fullPlane = app.planes[clipIdx];
  const onPlane = app.eventOnPlanes[clipIdx];
  const offPlane = app.eventOffPlanes[clipIdx];
  const chromaPlane = app.chromaPlanes[clipIdx];
  const h = app.planeP;
  const C = app.planeC;
  const out = app.sliceScratch;
  const srcMode = app.flipbook.synthSource;
  const useChromaB = app.flipbook.chromaBlue;
  const isNeg = app.clips[clipIdx]?.polarity === "neg";
  const breathLR = app.fasCfg.stereoMode === "breath_lr";

  for (let r = 0; r < h; r++) {
    const idx = r * C + col;
    const o = r * 4;
    let lVal = 0;
    let rVal = 0;

    if (srcMode === "event") {
      lVal = onPlane[idx];
      rVal = offPlane[idx];
    } else if (srcMode === "hybrid") {
      const bed = fullPlane[idx] * 0.24;
      lVal = Math.min(1.0, bed + onPlane[idx]);
      rVal = Math.min(1.0, bed + offPlane[idx]);
    } else {
      const v = fullPlane[idx];
      if (breathLR) {
        lVal = isNeg ? v * 0.35 : v;
        rVal = isNeg ? v : v * 0.35;
      } else {
        lVal = v;
        rVal = v;
      }
    }

    out[o] = Math.min(255, Math.max(0, Math.round(lVal * 255)));
    out[o + 1] = Math.min(255, Math.max(0, Math.round(rVal * 255)));
    out[o + 2] = useChromaB ? Math.min(255, Math.max(0, Math.round(chromaPlane[idx] * 255))) : 0;
    out[o + 3] = 255;
  }
  return out;
}

// --- Playback Control ---
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
  if (app.playEngine === "fas") fas.stopStream(true);
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

  // If user selected "A: Blurry MP3" in Cartridge A/B mode, play the genuine compressed MP3 audio!
  if (app.abSource === "mp3" && app.blurryMp3Buffer) {
    ensureAudio();
    stopPlayback(false);
    const src = app.audioCtx.createBufferSource();
    src.buffer = app.blurryMp3Buffer;
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
    src.start(0, off % (app.blurryMp3Buffer.duration || 1));
    app.sourceNode = src;
    app.playStartCtxTime = app.audioCtx.currentTime;
    app.playOffset = off;
    app.playing = true;
    app.playEngine = "webaudio";
    $("btn-play").textContent = "Pause";
    return;
  }

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

  app.statusNote = "FAS not connected — click Connect FAS (start_fas.bat) or click Offline WAV";
  renderUI();
}

// --- Offline Browser WAV Synthesis (Respects Event-Cam / Hybrid / Full Synth Source!) ---
function ensureWorker() {
  if (!app.worker) app.worker = new Worker("./js/synth_worker.js", { type: "module" });
  return app.worker;
}

function buildActiveAudioPlanesForOffline() {
  const src = app.flipbook.synthSource;
  if (src === "event") {
    return app.eventMixPlanes.map((pl) => new Float32Array(pl));
  }
  if (src === "hybrid") {
    return app.planes.map((full, i) => {
      const ev = app.eventMixPlanes[i];
      const out = new Float32Array(full.length);
      for (let k = 0; k < out.length; k++) out[k] = Math.min(1.0, full[k] * 0.24 + ev[k]);
      return out;
    });
  }
  return app.planes.map((pl) => new Float32Array(pl));
}

function synthesizeOfflineWav({ autoDownload = false, autoPlay = false, onDone = null } = {}) {
  if (app.clips.length === 0) return;
  stopPlayback(false);
  recomputeTimelinePlanes();

  const worker = ensureWorker();
  const jobId = ++app.jobSeq;
  setBusy(true, `Rendering Offline WAV (${app.flipbook.synthSource})…`);

  // Keep offline browser synthesis snappy for 100-frame sequences by capping offline partials at 220 if >32 clips
  const rawPlanes = buildActiveAudioPlanesForOffline();
  let useP = app.planeP;
  let sendPlanes = rawPlanes;
  if (app.clips.length > 32 && useP > 200) {
    const stride = Math.ceil(useP / 180);
    const newP = Math.ceil(useP / stride);
    sendPlanes = rawPlanes.map((pl) => {
      const ds = new Float32Array(newP * app.planeC);
      for (let r = 0; r < newP; r++) {
        const srcRow = Math.min(useP - 1, r * stride) * app.planeC;
        ds.set(pl.subarray(srcRow, srcRow + app.planeC), r * app.planeC);
      }
      return ds;
    });
    useP = newP;
  }

  const transfers = sendPlanes.map((pl) => pl.buffer);
  const offlineCfg = {
    ...app.cfg,
    partials: useP,
    sr: 48000,
    bitDepth: 24,
    fftSize: app.cfg.slotDurationS < 0.35 ? 1024 : 2048,
    slotGapMs: app.cfg.slotDurationS < 0.25 ? 4.0 : 12.0,
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
      app.lastAudioF32 = new Float32Array(msg.audioF32Buf);
      app.lastAudioSr = msg.audioSr || 48000;
      app.masterSpecCanvas = rgbaToCanvas(new Uint8ClampedArray(msg.specRgbaBuf), msg.specW, msg.specH);
      try {
        ensureAudio();
        app.audioBuffer = await app.audioCtx.decodeAudioData(msg.playWavBuf.slice(0));
      } catch (_) {
        app.audioBuffer = null;
      }
      app.dirty = false;
      app.rendered = true;
      app.statusNote = `Offline WAV (${app.flipbook.synthSource}) ready (${(wavBlob.size / 1024).toFixed(0)} KB · ${msg.elapsedMs.toFixed(0)} ms)`;
      renderUI();
      if (autoPlay) startPlayback(0);
      if (autoDownload) $("btn-dl-wav").click();
      if (onDone) onDone();
    }
  };

  worker.postMessage({ jobId, planes: sendPlanes, P: useP, C: app.planeC, cfg: offlineCfg }, transfers);
}

// --- Dual-Layer APIC MP3 Synth-Cartridge Export & Drop-to-Expand ---
function buildCurrentCartridgeRecipe() {
  return {
    schema: CARTRIDGE_SCHEMA,
    ...app.activeRecipe,
    breathing: app.breathingEnabled,
    synthSource: app.flipbook.synthSource,
    trailDecay: app.flipbook.trailDecay,
    chromaBlue: app.flipbook.chromaBlue,
    fasMethod: app.fasCfg.method,
    fasHeight: app.fasCfg.h,
    slotDurationS: app.cfg.slotDurationS,
    numClips: app.clips.length,
  };
}

async function exportCartridgeMp3() {
  if (app.clips.length === 0) return;
  const finishPack = async () => {
    try {
      setBusy(true, "Encoding MP3 + Dual-Layer APIC Cover…");
      await new Promise((r) => setTimeout(r, 15));
      const bitrate = parseInt($("cart-bitrate").value, 10) || 96;
      const recipe = buildCurrentCartridgeRecipe();

      // Collect visual frame RGBA samples for the 512x512 neon mosaic album cover
      const coverFrames = [];
      const srcCanvases = app.flipbook.synthSource === "event"
        ? app.hiResEventCanvases
        : app.hiResRawCanvases;
      const sampleCount = Math.min(9, srcCanvases.length);
      for (let i = 0; i < sampleCount; i++) {
        const idx = Math.floor((i / Math.max(1, sampleCount)) * srcCanvases.length);
        const cv = srcCanvases[idx];
        const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height);
        coverFrames.push({ rgba: d.data, width: cv.width, height: cv.height });
      }

      // Render 512x512 cover with Layer 2 JPEG-safe 8x8 strip + visual mosaic body
      const cov = renderCartridgeCoverRGBA(recipe, coverFrames);
      const covCanvas = rgbaToCanvas(cov.rgba, cov.width, cov.height);
      app.apicCoverCanvas = covCanvas;

      // Convert cover to PNG and inject Layer 1 JSON `tEXt` chunk
      const pngBlob = await new Promise((resolve) => covCanvas.toBlob(resolve, "image/png"));
      const rawPngU8 = new Uint8Array(await pngBlob.arrayBuffer());
      const taggedPngU8 = injectPngTextChunk(rawPngU8, CARTRIDGE_TEXT_KEY, JSON.stringify(recipe));

      // Encode mono MP3 using vendored lamejs
      const rawMp3 = encodeAudioToMp3(app.lastAudioF32, app.lastAudioSr, bitrate);

      // Attach ID3v2.3 APIC + CHAP markers
      const slotMs = Math.round((Number(app.cfg.slotDurationS) || 0.25) * 1000);
      const chapters = app.clips.map((c, i) => ({
        startMs: i * slotMs,
        endMs: (i + 1) * slotMs,
        title: `${i + 1}_${c.polarity}_${c.title}`,
      }));
      const fullMp3 = attachId3v2ToMp3(rawMp3, {
        coverPngBytes: taggedPngU8,
        title: `Spectral Cartridge (${recipe.type})`,
        album: "Spectral Timeline",
        chapters,
      });

      // Also decode our own blurry MP3 into WebAudio so user can A/B compare immediately!
      try {
        ensureAudio();
        app.blurryMp3Buffer = await app.audioCtx.decodeAudioData(fullMp3.buffer.slice(0));
        app.cartridgeLayer = "Exported (L1 PNG + L2 8×8)";
      } catch (_) {}

      const blob = new Blob([fullMp3], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `spectral_cartridge_${recipe.type}_${bitrate}k.mp3`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      setBusy(false);
      app.statusNote = `Exported Cartridge MP3 (${(fullMp3.length / 1024).toFixed(1)} KB @ ${bitrate}k · L1 PNG + L2 8×8 APIC)`;
      $("deliver-note").textContent = `Ready to share! Drop this ${(fullMp3.length / 1024).toFixed(1)} KB .mp3 back onto this page anytime to re-expand.`;
      renderUI();
    } catch (err) {
      setBusy(false);
      app.statusNote = `Cartridge MP3 error: ${err?.message || err}`;
      renderUI();
    }
  };

  if (app.dirty || !app.lastAudioF32) {
    synthesizeOfflineWav({ autoDownload: false, autoPlay: false, onDone: finishPack });
  } else {
    finishPack();
  }
}

function expandCartridgeRecipe(recipe, layerLabel) {
  app.flipbook.synthSource = recipe.synthSource || "event";
  app.flipbook.trailDecay = Number(recipe.trailDecay ?? 0.45);
  app.flipbook.chromaBlue = Boolean(recipe.chromaBlue ?? true);
  app.breathingEnabled = Boolean(recipe.breathing ?? true);
  if (recipe.fasMethod !== undefined) {
    app.fasCfg.method = Number(recipe.fasMethod) || 0;
    fas.setSynthMethod(app.fasCfg.method);
  }

  if (recipe.type === "shape_morph") {
    runShowreelDemo("shape_morph", recipe, true);
  } else if (recipe.type === "plasma_showreel") {
    runShowreelDemo("plasma_showreel", recipe, true);
  } else if (recipe.type === "secp256k1") {
    runShowreelDemo("secp256k1", recipe, true);
  } else if (recipe.type === "text_card") {
    const res = renderUniformPixelBoxRGBA({
      text: recipe.text || "RAMANUJAN CHIME 1729",
      cols: recipe.cols || null,
      bandMode: recipe.bandMode || "full",
    });
    app.clips = [];
    const m = addMediaFromRGBA(`expanded_${res.rows}x${res.cols}.png`, res.rgba, res.width, res.height);
    addClip(m.mediaId, "pos", null, true);
    app.activeRecipe = { ...recipe };
    app.cfg.slotDurationS = Number(recipe.slotDurationS) || 2.0;
    markDirty(`Expanded Cartridge (${layerLabel})`);
    synthesizeOfflineWav({ autoDownload: false, autoPlay: true });
  } else {
    app.statusNote = `Loaded MP3 Cartridge (${layerLabel}, custom raster — playing blurry MP3)`;
    app.abSource = "mp3";
    renderUI();
    startPlayback(0);
    return;
  }

  app.cartridgeLayer = layerLabel;
  app.abSource = "expanded";
  app.statusNote = `★ CARTRIDGE EXPANDED (${layerLabel}) — toggle A: Blurry MP3 vs B: Expanded!`;
  renderUI();
}

async function loadCartridgeMp3(file) {
  try {
    setBusy(true, `Reading Cartridge ${file.name}…`);
    const ab = await file.arrayBuffer();
    const u8 = new Uint8Array(ab);

    // 1. Decode the actual compressed blurry MP3 audio for live A/B comparison
    try {
      ensureAudio();
      app.blurryMp3Buffer = await app.audioCtx.decodeAudioData(ab.slice(0));
    } catch (_) {
      app.blurryMp3Buffer = null;
    }

    // 2. Parse ID3v2 APIC cover art
    const apic = parseApicFromMp3(u8);
    if (!apic || !apic.bytes || apic.bytes.length < 32) {
      setBusy(false);
      app.statusNote = "MP3 has no embedded APIC Cartridge cover art.";
      renderUI();
      return;
    }

    // Decode APIC image (PNG or JPEG!) to canvas for display + Layer 2 pixel fallback
    const imgBlob = new Blob([apic.bytes], { type: apic.mime || "image/png" });
    const bmp = await createImageBitmap(imgBlob);
    const covC = document.createElement("canvas");
    covC.width = bmp.width; covC.height = bmp.height;
    const covCtx = covC.getContext("2d");
    covCtx.drawImage(bmp, 0, 0);
    const covRgba = covCtx.getImageData(0, 0, covC.width, covC.height).data;
    bmp.close();
    app.apicCoverCanvas = covC;

    // 3. Layer 1: Try lossless PNG tEXt chunk first
    let recipe = null;
    let layerLabel = "";
    const texts = extractPngTextChunks(apic.bytes);
    if (texts[CARTRIDGE_TEXT_KEY]) {
      try {
        const parsed = JSON.parse(texts[CARTRIDGE_TEXT_KEY]);
        if (parsed && parsed.schema === CARTRIDGE_SCHEMA) {
          recipe = parsed;
          layerLabel = "Layer 1: Lossless PNG tEXt";
        }
      } catch (_) {}
    }

    // 4. Layer 2: Automatic JPEG-resilient 8x8 macro-block fallback!
    if (!recipe) {
      const l2 = decodeLayer2FromCoverRGBA(covRgba, covC.width, covC.height);
      if (l2) {
        recipe = l2;
        layerLabel = "Layer 2: JPEG-Safe 8×8 Strip (CRC16 OK)";
      }
    }

    setBusy(false);
    if (!recipe) {
      app.statusNote = "APIC cover found, but no Spectral Cartridge math header detected.";
      app.monMode = "apic";
      renderUI();
      return;
    }

    expandCartridgeRecipe(recipe, layerLabel);
  } catch (err) {
    setBusy(false);
    app.statusNote = `MP3 load error: ${err?.message || err}`;
    renderUI();
  }
}

// --- 1-Click Procedural Showreel Launcher ---
function runShowreelDemo(kind, overrides = {}, autoPlay = true) {
  stopPlayback(false);
  if (kind === "shape_morph") {
    const bpm = Number(overrides.bpm) || 120;
    const beatsPerFrame = Number(overrides.beatsPerFrame) || 0.25;
    const framesPerLeg = Number(overrides.framesPerLeg) || 6;
    const style = overrides.style || "outline";
    const breathing = overrides.breathing !== undefined ? Boolean(overrides.breathing) : true;

    const seq = buildShapeMorphSequence({ bpm, beatsPerFrame, framesPerLeg, style, breathing });
    app.cfg.slotDurationS = seq.slotDurationS;
    app.flipbook.synthSource = overrides.synthSource || "hybrid";
    app.flipbook.trailDecay = overrides.trailDecay !== undefined ? Number(overrides.trailDecay) : 0.45;
    app.flipbook.hiResMode = false; // showcase the signature kinetic sonar look (user can flip Hi-Res anytime!)
    app.clips = [];
    app.breathingEnabled = false;
    for (const fr of seq.frames) {
      const m = addMediaFromRGBA(fr.filename, fr.grid.rgba, fr.grid.width, fr.grid.height);
      addClip(m.mediaId, fr.polarity, null, true);
    }
    app.breathingEnabled = breathing;
    app.activeRecipe = { type: "shape_morph", bpm, beatsPerFrame, framesPerLeg, style };
    app.selectedClipIdx = 0;
    app.selectedSeamIdx = 0;
    app.monMode = "video";
    app.videoMode = "event";
    markDirty(`Showreel 1: Shape Morph (${seq.frames.length}f @ ${bpm} BPM)`);
  } else if (kind === "plasma_showreel") {
    const bpm = Number(overrides.bpm) || 120;
    const beatsPerFrame = Number(overrides.beatsPerFrame) || 0.25;
    const totalFrames = Number(overrides.totalFrames) || 24;
    const breathing = overrides.breathing !== undefined ? Boolean(overrides.breathing) : true;

    const seq = buildPlasmaShowreelSequence({ bpm, beatsPerFrame, totalFrames, breathing });
    app.cfg.slotDurationS = seq.slotDurationS;
    app.flipbook.synthSource = overrides.synthSource || "event";
    app.flipbook.trailDecay = overrides.trailDecay !== undefined ? Number(overrides.trailDecay) : 0.45;
    app.flipbook.chromaBlue = true;
    app.flipbook.hiResMode = true;
    app.clips = [];
    app.breathingEnabled = false;
    for (const fr of seq.frames) {
      const m = addMediaFromRGBA(fr.filename, fr.grid.rgba, fr.grid.width, fr.grid.height);
      addClip(m.mediaId, fr.polarity, null, true);
    }
    app.breathingEnabled = breathing;
    app.activeRecipe = { type: "plasma_showreel", bpm, beatsPerFrame, totalFrames };
    app.selectedClipIdx = 0;
    app.selectedSeamIdx = 0;
    app.monMode = "video";
    app.videoMode = "event";
    markDirty(`Showreel 2: Plasma Sphere + Aura + Cut (${seq.frames.length}f · ★Cut #${seq.cutFrame + 1})`);
  } else if (kind === "secp256k1") {
    const kRaw = String(overrides.kRaw || "1");
    const count = Number(overrides.count) || 4;
    const alignMode = overrides.alignMode || "66_header";
    const bandMode = overrides.bandMode || "full";

    const { cards } = buildSecp256k1BreathingCards({ kRaw, count, alignMode, bandMode });
    app.cfg.slotDurationS = Number(overrides.slotDurationS) || 1.0;
    app.flipbook.synthSource = overrides.synthSource || "full";
    app.flipbook.hiResMode = true;
    app.clips = [];
    app.breathingEnabled = false;
    for (const card of cards) {
      const m = addMediaFromRGBA(card.filename, card.grid.rgba, card.grid.width, card.grid.height);
      addClip(m.mediaId, card.polarity, null, true);
    }
    app.breathingEnabled = true;
    app.activeRecipe = { type: "secp256k1", kRaw, count, alignMode, bandMode };
    app.selectedClipIdx = 0;
    app.selectedSeamIdx = 0;
    app.monMode = "timeline";
    markDirty(`Showreel 3: secp256k1 K / K·G Breathing (${count} pairs · 3×22 pixel-boxes)`);
  }

  if (autoPlay) {
    if (app.fasConnected) startPlayback(0);
    else synthesizeOfflineWav({ autoDownload: false, autoPlay: true });
  }
}

// --- Exports ---
function exportStitchedStripPng() {
  if (!app.stitchedCanvas) return;
  const a = document.createElement("a");
  a.href = app.stitchedCanvas.toDataURL("image/png");
  a.download = `spectral_timeline_${app.flipbook.synthSource}_${app.clips.length}f_${app.planeP}h.png`;
  a.click();
}

function downloadTimelineJSON() {
  const payload = {
    tool: "spectral-timeline-fas-flipbook",
    exportedAt: new Date().toISOString(),
    fasConfig: app.fasCfg,
    flipbook: app.flipbook,
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
    const hi = app.flipbook.hiResMode;
    let frames;
    if (app.videoMode === "orig") frames = app.hiResOrigCanvases;
    else if (app.videoMode === "raw") frames = hi ? app.hiResRawCanvases : app.clipCanvases;
    else if (app.videoMode === "event") frames = hi ? app.hiResEventCanvases : app.clipEventCanvases;
    else frames = hi ? app.hiResDemodCanvases : app.clipDemodCanvases;

    if (frames.length > 0) {
      const idx = app.playing
        ? Math.min(frames.length - 1, Math.floor((t / dur) * frames.length))
        : Math.min(frames.length - 1, app.selectedClipIdx);
      const fr = frames[idx];
      const targetAspect = hi ? (16 / 9) : (4 / 3);
      const padY = 44 * dpr;
      const drawH = Math.max(40, h - padY * 1.3);
      const drawW = Math.min(w - 24 * dpr, drawH * targetAspect);
      const dx = Math.floor((w - drawW) / 2);
      const dy = Math.floor((h - drawH) / 2 + 8 * dpr);

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(fr, dx, dy, drawW, drawH);

      const isCut = idx === app.flipbook.peakCutIdx && app.flipbook.peakCutScore > 0.14;
      ctx.strokeStyle = isCut
        ? "rgba(245, 166, 35, 0.9)"
        : (app.clips[idx]?.polarity === "neg" ? "rgba(72, 201, 240, 0.55)" : "rgba(56, 212, 122, 0.55)");
      ctx.lineWidth = (isCut ? 2.5 : 1.5) * dpr;
      ctx.strokeRect(dx, dy, drawW, drawH);

      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(dx, dy + drawH + 6 * dpr, drawW, 4 * dpr);
      ctx.fillStyle = isCut ? "#f5a623" : "#38d47a";
      ctx.fillRect(dx, dy + drawH + 6 * dpr, drawW * (t / dur), 4 * dpr);

      const polTag = app.clips[idx]?.polarity === "neg" ? "− NEG" : "+ POS";
      const cutTag = isCut ? " · ★ CUT" : "";
      $("video-frame-badge").textContent = `Frame ${idx + 1}/${frames.length} · ${polTag}${cutTag} · ${app.clips[idx]?.title || ""}`;
      $("hud-time").textContent = `${t.toFixed(2)} / ${totalDurationS().toFixed(2)} s`;
    }
    requestAnimationFrame(drawLoop);
    return;
  }

  let srcCanvas = null;
  if (app.monMode === "apic") srcCanvas = app.apicCoverCanvas;
  else if (app.monMode === "timeline") srcCanvas = app.stitchedCanvas;
  else if (app.monMode === "master") srcCanvas = app.masterSpecCanvas;
  else if (app.monMode === "seam") srcCanvas = getSeamCanvasLazy(app.selectedSeamIdx);
  else srcCanvas = app.clipCanvases[app.selectedClipIdx] || null;

  if (srcCanvas) {
    ctx.imageSmoothingEnabled = app.monMode !== "apic";
    if (app.monMode === "apic") {
      const side = Math.min(w, h) - 16 * dpr;
      ctx.drawImage(srcCanvas, Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side);
    } else {
      ctx.drawImage(srcCanvas, 0, 0, w, h);
    }
  } else {
    ctx.fillStyle = "#5c677a";
    ctx.font = `${13 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("Load a Flipbook Sequence (e.g. dbzframexz/*.png) · Connect FAS or click Offline WAV", w / 2, h / 2);
  }

  if ((app.monMode === "timeline" || app.monMode === "master") && app.clips.length > 0) {
    const n = app.clips.length;
    if (n <= 40) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
      ctx.lineWidth = Math.max(1, dpr);
      for (let i = 1; i < n; i++) {
        const x = (i / n) * w;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    // Highlight detected scene cut line on stitched timeline
    if (app.flipbook.peakCutIdx > 0 && app.flipbook.peakCutScore > 0.14) {
      const cx = (app.flipbook.peakCutIdx / n) * w;
      ctx.strokeStyle = "rgba(245, 166, 35, 0.75)";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    }
    const px = (t / dur) * w;
    ctx.strokeStyle = app.fasConnected ? "#ffd24c" : "#38d47a";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
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
  const srcLbl = app.flipbook.synthSource === "event" ? "EVENT-CAM Δ" : app.flipbook.synthSource === "hybrid" ? "HYBRID" : "FULL BREATH";
  $("engine-badge").textContent = app.fasConnected
    ? `FAS LIVE (${app.fasCfg.h} oscs · ${methodName} · ${srcLbl})`
    : app.audioBuffer
      ? `Offline WAV Ready (${srcLbl}) — or Connect FAS`
      : `FAS Offline (${srcLbl}) — start_fas.bat or Offline WAV`;

  const dl = $("btn-dl-wav");
  dl.classList.toggle("hidden", !app.masterWavUrl);
  if (app.masterWavUrl) dl.href = app.masterWavUrl;

  $("breathing-rms-lbl").textContent = `${app.fasCfg.h} oscs · ${srcLbl} · trail=${app.flipbook.trailDecay}`;

  const bBtn = $("btn-breathing");
  bBtn.textContent = `Breathing (+/−): ${app.breathingEnabled ? "ON" : "OFF"}`;
  bBtn.classList.toggle("active", app.breathingEnabled);

  // Peak cut jump button
  const cutBtn = $("btn-jump-cut");
  if (app.flipbook.peakCutIdx > 0) {
    cutBtn.classList.remove("hidden");
    cutBtn.textContent = `★ Peak Cut: #${app.flipbook.peakCutIdx + 1} (Δ=${app.flipbook.peakCutScore.toFixed(2)})`;
  } else {
    cutBtn.classList.add("hidden");
  }

  document.querySelectorAll(".mon-tab").forEach((b) => b.classList.toggle("active", b.dataset.mon === app.monMode));
  $("seam-legend").classList.toggle("hidden", app.monMode !== "seam");
  $("video-bar").classList.toggle("hidden", app.monMode !== "video");
  document.querySelectorAll(".vmode-btn[data-vmode]").forEach((b) => b.classList.toggle("active", b.dataset.vmode === app.videoMode));
  const vresBtn = $("btn-vres-toggle");
  vresBtn.textContent = app.flipbook.hiResMode ? "Hi-Res 16:9" : "Sonar Grid";
  vresBtn.classList.toggle("active", app.flipbook.hiResMode);

  $("mon-tab-apic").classList.toggle("hidden", !app.apicCoverCanvas);
  $("ab-mp3-wrap").classList.toggle("hidden", !app.blurryMp3Buffer);
  $("btn-ab-expanded").classList.toggle("active", app.abSource === "expanded");
  $("btn-ab-mp3").classList.toggle("active", app.abSource === "mp3");

  if (app.monMode === "apic") {
    $("mon-info").textContent = `Dual-Layer APIC Cover (512×512 · Top 32px = JPEG-Safe 8×8 Expansion Math Strip) · ${app.cartridgeLayer}`;
  } else if (app.monMode === "timeline") {
    $("mon-info").textContent = `Stitched ${srcLbl} Stream (${app.clips.length} clips · ${totalDurationS().toFixed(2)}s) · Click canvas to scrub`;
  } else if (app.monMode === "video") {
    const fps = (1 / Math.max(0.02, Number(app.cfg.slotDurationS) || 0.125)).toFixed(1);
    $("mon-info").textContent = `Flipbook (${fps} fps · ${app.flipbook.hiResMode ? "Hi-Res 16:9" : "Sonar Grid"}) · Audio=${srcLbl}`;
  } else if (app.monMode === "master") {
    $("mon-info").textContent = app.rendered ? "Offline Browser WAV STFT Preview" : "Click Offline WAV to render browser WAV";
  } else if (app.monMode === "seam") {
    const sm = app.seams[app.selectedSeamIdx];
    $("mon-info").textContent = sm
      ? `Seam ${sm.seamIndex + 1}: ${sm.polarityTransition} · Disp R=${sm.dispersionRatio.toFixed(2)} · Flux |Δ|=${sm.rectifiedFlux.toFixed(3)} · Δf=${sm.centroidDeltaHz >= 0 ? "+" : ""}${sm.centroidDeltaHz} Hz`
      : "Add 2+ clips to inspect Seam Delta";
  } else {
    const clip = app.clips[app.selectedClipIdx];
    $("mon-info").textContent = clip ? `Slot ${app.selectedClipIdx + 1}: ${clip.title} (${clip.polarity})` : "Add clips to Timeline";
  }

  // Media Bay (cap visible cards cleanly if 100+ items, keeping scrollable performance smooth)
  const grid = $("media-grid");
  grid.innerHTML = "";
  app.mediaOrder.forEach((mid) => {
    const m = app.mediaPool.get(mid);
    if (!m) return;
    const card = document.createElement("div");
    card.className = "media-card";
    card.draggable = true;
    card.innerHTML = `
      <button class="media-del-btn" title="Remove">✕</button>
      <img src="${m.thumbUrl}" alt="${m.filename}" loading="lazy" draggable="false" />
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
  const dt = Number(app.cfg.slotDurationS) || 0.125;
  const fastStripMode = app.clips.length > 28;
  $("tl-summary").textContent = `${app.clips.length} / ${MAX_CLIPS} clips · ${totalDurationS().toFixed(2)} s (${(1 / dt).toFixed(1)} fps)`;
  const strip = $("timeline-strip");
  strip.innerHTML = "";
  app.clips.forEach((c, idx) => {
    const card = document.createElement("div");
    card.className = `clip-card pol-${c.polarity}` + (idx === app.selectedClipIdx ? " selected" : "");
    card.draggable = true;
    const invCss = fastStripMode && c.polarity === "neg" ? " inv-css" : "";
    card.innerHTML = `
      <div class="clip-top mono">
        <span>#${String(idx + 1).padStart(2, "0")} · ${(idx * dt).toFixed(2)}s</span>
        <span>
          <button class="clip-mini" data-act="left">◀</button>
          <button class="clip-mini" data-act="right">▶</button>
          <button class="clip-mini" data-act="dup">±</button>
          <button class="clip-mini" data-act="del">✕</button>
        </span>
      </div>
      <img class="clip-thumb${invCss}" src="${app.clipThumbUrls[idx] || ""}" alt="${c.title}" loading="lazy" draggable="false" />
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
      const isPeakCut = idx + 1 === app.flipbook.peakCutIdx && app.flipbook.peakCutScore > 0.14;
      const chip = document.createElement("button");
      chip.className = "seam-chip mono"
        + (isPeakCut ? " cut-peak" : (sm.isInvertedSeam ? " inverted" : ""))
        + (app.monMode === "seam" && app.selectedSeamIdx === idx ? " selected" : "");
      chip.title = isPeakCut ? `★ PEAK SCENE CUT at Frame #${idx + 2}` : `Inspect Seam ${idx + 1} (${sm.polarityTransition})`;
      chip.innerHTML = isPeakCut
        ? `<span>★CUT</span><span>#${idx + 2}</span><span>${sm.rectifiedFlux.toFixed(2)}</span>`
        : `<span>Δ${idx + 1}</span><span>${sm.isInvertedSeam ? "⇄" : "→"}</span><span>${sm.rectifiedFlux.toFixed(2)}</span>`;
      chip.addEventListener("click", () => {
        app.selectedSeamIdx = idx;
        app.monMode = "seam";
        renderUI();
      });
      strip.appendChild(chip);
    }
  });

  // Sync FAS & Flipbook controls
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

  $("seq-synth-src").value = app.flipbook.synthSource;
  $("seq-trail").value = String(app.flipbook.trailDecay);
  $("seq-chroma-blue").checked = app.flipbook.chromaBlue;

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

// --- Media Bay & Flipbook Sequence Importers ---
async function decodeFileToRGBA(file, maxW = 640, maxH = 360) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  const w = Math.max(8, Math.round(bmp.width * scale));
  const h = Math.max(8, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cctx = c.getContext("2d");
  cctx.drawImage(bmp, 0, 0, w, h);
  const rgba = new Uint8ClampedArray(cctx.getImageData(0, 0, w, h).data);
  bmp.close();
  return { rgba, w, h };
}

async function importFiles(fileList) {
  const sorted = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  for (const file of sorted) {
    const { rgba, w, h } = await decodeFileToRGBA(file, 640, 360);
    addMediaFromRGBA(file.name, rgba, w, h);
    app.statusNote = `Imported to Media Bay: ${file.name} (${w}×${h})`;
  }
  renderUI();
}

async function importFlipbookSequence(fileList) {
  const sorted = Array.from(fileList)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name) || f.type.startsWith("image/"))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  if (sorted.length === 0) return;

  stopPlayback(false);
  const stride = Math.max(1, parseInt($("seq-stride").value, 10) || 1);
  const fps = Math.max(2, parseFloat($("seq-fps").value) || 8);
  const picked = sorted.filter((_, idx) => idx % stride === 0).slice(0, MAX_CLIPS);

  setBusy(true, `Loading sequence 0 / ${picked.length}…`);
  app.clips = [];
  app.cfg.slotDurationS = Number((1.0 / fps).toFixed(4));
  app.flipbook.synthSource = $("seq-synth-src").value || "event";
  app.flipbook.trailDecay = parseFloat($("seq-trail").value) || 0;
  app.flipbook.chromaBlue = $("seq-chroma-blue").checked;
  app.flipbook.hiResMode = true;

  for (let i = 0; i < picked.length; i++) {
    if (i % 6 === 0) setBusy(true, `Loading frame ${i + 1} / ${picked.length}…`);
    // 320x180 keeps 100 frames crisp 16:9 while staying lightweight (~23 MB total)
    const { rgba, w, h } = await decodeFileToRGBA(picked[i], 320, 180);
    const m = addMediaFromRGBA(picked[i].name, rgba, w, h);
    const pol = app.breathingEnabled ? (i % 2 === 0 ? "pos" : "neg") : "pos";
    addClip(m.mediaId, pol, null, true);
  }

  setBusy(true, `Computing Event-Cam Δ + Phosphor Trail (${picked.length} frames)…`);
  await new Promise((r) => setTimeout(r, 15));
  app.selectedClipIdx = 0;
  app.selectedSeamIdx = 0;
  app.monMode = "video";
  app.videoMode = "event";
  recomputeTimelinePlanes();
  setBusy(false);

  const cutMsg = app.flipbook.peakCutIdx > 0 ? ` · Peak Cut #${app.flipbook.peakCutIdx + 1}` : "";
  app.statusNote = `Loaded ${picked.length}-frame Flipbook @ ${fps} fps (${totalDurationS().toFixed(2)}s)${cutMsg}`;
  renderUI();

  if (app.fasConnected) {
    startPlayback(0);
  } else {
    synthesizeOfflineWav({ autoDownload: false, autoPlay: true });
  }
}

function syncFasConfigFromUI() {
  app.fasCfg.h = parseInt($("fas-height").value, 10) || 512;
  app.fasCfg.octaves = Math.max(2, Math.min(12, parseInt($("fas-octaves").value, 10) || 10));
  app.fasCfg.baseFreq = Math.max(8, parseFloat($("fas-basefreq").value) || 16.35);
  app.fasCfg.fps = parseInt($("fas-fps").value, 10) || 60;
  app.fasCfg.method = parseInt($("fas-method").value, 10) || 0;
  app.fasCfg.stereoMode = $("fas-stereo").value || "mono";
  app.fasCfg.gain = parseFloat($("gain-input").value) || 0.12;
  app.cfg.slotDurationS = Math.max(0.04, Math.min(10, parseFloat($("cfg-slot-s").value) || 2.0));
  app.cfg.condMode = $("cfg-cond").value || "raw";
  app.clips.forEach((c) => { c.condMode = app.cfg.condMode; });

  fas.syncSettings(
    { h: app.fasCfg.h, octaves: app.fasCfg.octaves, baseFreq: app.fasCfg.baseFreq, floatData: false },
    { fps: app.fasCfg.fps, gain: app.fasCfg.gain, method: app.fasCfg.method }
  );
  markDirty(`Synced FAS bank (${app.fasCfg.h} oscs, ${app.fasCfg.octaves} oct, ${app.fasCfg.baseFreq} Hz)`);
}

function bindEvents() {
  // 1-Click Showreel Selector
  $("showreel-select").addEventListener("change", () => {
    const val = $("showreel-select").value;
    if (val) {
      runShowreelDemo(val, {}, true);
      $("showreel-select").value = "";
    }
  });

  // Cartridge MP3 Export / Load & A/B Switcher
  $("btn-export-cartridge").addEventListener("click", exportCartridgeMp3);
  $("btn-load-cartridge").addEventListener("click", () => $("file-cartridge").click());
  $("file-cartridge").addEventListener("change", (ev) => {
    if (ev.target.files.length) loadCartridgeMp3(ev.target.files[0]);
    ev.target.value = "";
  });
  $("btn-ab-expanded").addEventListener("click", () => {
    app.abSource = "expanded";
    renderUI();
    if (app.playing) startPlayback(currentPlayheadSec());
  });
  $("btn-ab-mp3").addEventListener("click", () => {
    app.abSource = "mp3";
    renderUI();
    if (app.playing) startPlayback(currentPlayheadSec());
  });

  $("fas-addr").addEventListener("change", () => {
    app.fasCfg.address = $("fas-addr").value.trim() || "127.0.0.1:3003";
    localStorage.setItem("st-fas-addr", app.fasCfg.address);
  });
  $("btn-fas-connect").addEventListener("click", () => {
    if (app.fasConnected) fas.disconnect();
    else {
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
  $("fas-stereo").addEventListener("change", () => { app.fasCfg.stereoMode = $("fas-stereo").value; });
  $("btn-apply-cfg").addEventListener("click", syncFasConfigFromUI);

  // Flipbook / Sequence controls
  $("btn-import-seq").addEventListener("click", () => $("file-seq").click());
  $("file-seq").addEventListener("change", (ev) => {
    if (ev.target.files.length) importFlipbookSequence(ev.target.files);
    ev.target.value = "";
  });
  $("seq-fps").addEventListener("change", () => {
    const fps = parseFloat($("seq-fps").value) || 8;
    app.cfg.slotDurationS = Number((1.0 / fps).toFixed(4));
    markDirty(`Set Flipbook rate to ${fps} fps (${app.cfg.slotDurationS}s/frame)`);
  });
  $("seq-synth-src").addEventListener("change", () => {
    app.flipbook.synthSource = $("seq-synth-src").value;
    markDirty(`Audio Synth Source → ${app.flipbook.synthSource.toUpperCase()}`);
  });
  $("seq-trail").addEventListener("change", () => {
    app.flipbook.trailDecay = parseFloat($("seq-trail").value) || 0;
    markDirty(`Phosphor trail decay → ${app.flipbook.trailDecay}`);
  });
  $("seq-chroma-blue").addEventListener("change", () => {
    app.flipbook.chromaBlue = $("seq-chroma-blue").checked;
    app.statusNote = app.flipbook.chromaBlue ? "Chroma → FAS Blue timbre ON" : "Chroma → FAS Blue OFF";
    renderUI();
  });
  $("btn-jump-cut").addEventListener("click", () => {
    if (app.flipbook.peakCutIdx > 0) {
      app.selectedClipIdx = app.flipbook.peakCutIdx;
      const t = app.flipbook.peakCutIdx * (Number(app.cfg.slotDurationS) || 0.125);
      app.playOffset = t;
      if (app.playing) startPlayback(t);
      renderUI();
    }
  });
  $("btn-vres-toggle").addEventListener("click", () => {
    app.flipbook.hiResMode = !app.flipbook.hiResMode;
    renderUI();
  });

  $("btn-import-media").addEventListener("click", () => $("file-media").click());
  $("file-media").addEventListener("change", (ev) => {
    const files = Array.from(ev.target.files || []);
    const mp3 = files.find((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg");
    if (mp3) loadCartridgeMp3(mp3);
    else if (files.length) importFiles(files);
    ev.target.value = "";
  });

  // Allow dropping a Cartridge .mp3 anywhere onto the window
  window.addEventListener("dragover", (ev) => {
    if (!app.dragPayload) ev.preventDefault();
  });
  window.addEventListener("drop", (ev) => {
    if (app.dragPayload) return;
    const files = Array.from(ev.dataTransfer?.files || []);
    const mp3 = files.find((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg");
    if (mp3) {
      ev.preventDefault();
      loadCartridgeMp3(mp3);
    }
  });

  const bay = $("media-bay");
  bay.addEventListener("dragover", (ev) => { if (!app.dragPayload) { ev.preventDefault(); bay.classList.add("drag-over"); } });
  bay.addEventListener("dragleave", () => bay.classList.remove("drag-over"));
  bay.addEventListener("drop", (ev) => {
    if (app.dragPayload) return;
    ev.preventDefault();
    bay.classList.remove("drag-over");
    const files = Array.from(ev.dataTransfer.files || []);
    const mp3File = files.find((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg");
    if (mp3File) {
      loadCartridgeMp3(mp3File);
      return;
    }
    if (files.length >= 6) {
      app.activeRecipe = { type: "custom_raster" };
      importFlipbookSequence(files);
    } else if (files.length) {
      app.activeRecipe = { type: "custom_raster" };
      importFiles(files);
    }
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
      addClip(m.mediaId, fr.polarity, null, true);
    }
    app.breathingEnabled = breathing;
    app.activeRecipe = { type: "shape_morph", bpm, beatsPerFrame, framesPerLeg, style };
    app.selectedClipIdx = 0;
    app.selectedSeamIdx = 0;
    app.monMode = andPlay ? "video" : "timeline";
    markDirty(`Staged ${seq.frames.length}-frame Tri→Cir→Tri→Sq morph @ ${seq.bpm} BPM (${seq.slotDurationS}s/frame)`);
    if (andPlay) {
      if (app.fasConnected) startPlayback(0);
      else synthesizeOfflineWav({ autoDownload: false, autoPlay: true });
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
        addClip(m.mediaId, card.polarity, null, true);
      }
      app.breathingEnabled = true;
      app.activeRecipe = {
        type: "secp256k1",
        kRaw: $("secp-k").value,
        count: parseInt($("secp-count").value, 10) || 1,
        alignMode: $("secp-align").value,
        bandMode: $("secp-band").value,
      };
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

  $("btn-render").addEventListener("click", () => synthesizeOfflineWav({ autoDownload: false, autoPlay: false }));
  $("btn-export-wav2").addEventListener("click", () => synthesizeOfflineWav({ autoDownload: true, autoPlay: false }));
  $("btn-export-strip").addEventListener("click", exportStitchedStripPng);
  $("btn-export-json").addEventListener("click", downloadTimelineJSON);

  document.querySelectorAll(".mon-tab").forEach((btn) => {
    btn.addEventListener("click", () => { app.monMode = btn.dataset.mon; renderUI(); });
  });
  document.querySelectorAll(".vmode-btn[data-vmode]").forEach((btn) => {
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
    addClip(m.mediaId, card.polarity, null, true);
  }
  app.breathingEnabled = true;

  const textCard = renderUniformPixelBoxRGBA({ text: "RAMANUJAN CHIME 1729", cols: 10, bandMode: "rx11_lower" });
  addMediaFromRGBA("ramanujan_1729.png", textCard.rgba, textCard.width, textCard.height);

  const geo = renderGeometricTestRGBA(640, 360);
  addMediaFromRGBA("geometric_test.png", geo.rgba, geo.width, geo.height);

  app.monMode = "timeline";
  markDirty("Drop dbzframexz/*.png into Flipbook / Sequence or connect fas.exe (ws://127.0.0.1:3003)");
}

bindEvents();
seedStarterMedia();
requestAnimationFrame(drawLoop);
