// Pure-JS Additive Synthesizer, Conditioning, 4-State Endomorphic Seam Deltas,
// Radix-2 STFT Spectrogram, and Lossless RIFF WAV Encoder (16b / 24b PCM & 32f).
// Zero external dependencies — runs identically in browser Web Workers and Node.

export const PRESETS = {
  "Harmor Lossless (48k / 24-bit)": {
    slotDurationS: 2.0, fMinHz: 120, fMaxHz: 18500, freqScale: "linear",
    partials: 320, pps: 140, condMode: "raw", colEqAlpha: 0.0,
    featherMs: 2.0, sr: 48000, bitDepth: 24, fftSize: 4096, phaseMode: "schroeder",
  },
  "RX11 Lower-Band Crisp (48k / 24-bit)": {
    slotDurationS: 2.0, fMinHz: 400, fMaxHz: 6000, freqScale: "linear",
    partials: 240, pps: 120, condMode: "raw", colEqAlpha: 0.0,
    featherMs: 2.0, sr: 48000, bitDepth: 24, fftSize: 4096, phaseMode: "schroeder",
  },
  "Harmor Hi-Res (96k / 32f)": {
    slotDurationS: 2.0, fMinHz: 120, fMaxHz: 22000, freqScale: "linear",
    partials: 400, pps: 160, condMode: "raw", colEqAlpha: 0.0,
    featherMs: 1.5, sr: 96000, bitDepth: 32, fftSize: 4096, phaseMode: "schroeder",
  },
  "Fast Preview (44.1k / 16-bit)": {
    slotDurationS: 1.5, fMinHz: 300, fMaxHz: 11000, freqScale: "linear",
    partials: 160, pps: 90, condMode: "raw", colEqAlpha: 0.0,
    featherMs: 3.0, sr: 44100, bitDepth: 16, fftSize: 2048, phaseMode: "schroeder",
  },
  "Log Scale (WaveCandy)": {
    slotDurationS: 2.0, fMinHz: 650, fMaxHz: 12500, freqScale: "log",
    partials: 135, pps: 100, condMode: "raw", colEqAlpha: 0.0,
    featherMs: 4.0, sr: 48000, bitDepth: 24, fftSize: 4096, phaseMode: "schroeder",
  },
};

export function defaultConfig() {
  return {
    preset: "Harmor Lossless (48k / 24-bit)",
    ...PRESETS["Harmor Lossless (48k / 24-bit)"],
    slotGapMs: 18.0,
    preserveBreathingContrast: true,
  };
}

export function buildFreqGrid(cfg) {
  const P = Math.max(8, Math.min(516, Number(cfg.partials) || 240));
  const sr = Number(cfg.sr) || 48000;
  const fLo = Math.max(20.0, Number(cfg.fMinHz) || 120.0);
  const fHi = Math.min(0.45 * sr, Math.max(fLo + 50.0, Number(cfg.fMaxHz) || 18500.0));
  const freqs = new Float64Array(P);
  if (cfg.freqScale === "log") {
    const ratio = fHi / fLo;
    for (let i = 0; i < P; i++) {
      freqs[i] = fLo * Math.pow(ratio, P > 1 ? i / (P - 1) : 0);
    }
  } else {
    const step = P > 1 ? (fHi - fLo) / (P - 1) : 0;
    for (let i = 0; i < P; i++) freqs[i] = fLo + i * step;
  }
  return freqs;
}

/**
 * Downsample source RGBA (w x h, top-down) onto bottom-anchored [P, C] partial plane in [0, 1].
 * Applies automatic light-background normalization in `raw` mode, optional `stroke` high-pass,
 * temporal feathering, optional per-column RMS equalization, and finally `+ / -` polarity.
 */
export function rgbaToConditionedPlane(rgba, srcW, srcH, cfg, polarity = "pos", condModeOverride = null, bypassEq = false) {
  const P = Math.max(8, Math.min(516, Number(cfg.partials) || 240));
  const C = Math.max(8, Math.round((Number(cfg.slotDurationS) || 2.0) * (Number(cfg.pps) || 120.0)));
  const mode = condModeOverride || cfg.condMode || "raw";

  // 1. Bilinear downsample to top-down grayscale [P, C]
  const grayTD = new Float32Array(P * C);
  let meanSum = 0;
  const scaleX = srcW / C;
  const scaleY = srcH / P;

  for (let r = 0; r < P; r++) {
    const sy = Math.min(srcH - 1, Math.max(0, (r + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let c = 0; c < C; c++) {
      const sx = Math.min(srcW - 1, Math.max(0, (c + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;

      const luma = (px, py) => {
        const o = (py * srcW + px) * 4;
        return (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255.0;
      };
      const v00 = luma(x0, y0), v01 = luma(x1, y0);
      const v10 = luma(x0, y1), v11 = luma(x1, y1);
      const v = (v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy;
      grayTD[r * C + c] = v;
      meanSum += v;
    }
  }
  const meanVal = meanSum / (P * C);

  // 2. Mode conditioning
  let edgesTD = new Float32Array(P * C);
  if (mode === "stroke") {
    // Fast separable box-blur local high-pass (unsigned DoG)
    const blurred = boxBlur2D(grayTD, P, C, 4);
    let maxHp = 1e-6;
    for (let i = 0; i < P * C; i++) {
      const hp = Math.abs(grayTD[i] - blurred[i]);
      edgesTD[i] = hp;
      if (hp > maxHp) maxHp = hp;
    }
    for (let i = 0; i < P * C; i++) {
      let v = edgesTD[i] / maxHp;
      v = v < 0.18 ? 0 : (v - 0.18) / 0.82;
      edgesTD[i] = Math.pow(Math.min(1, Math.max(0, v)), 0.75);
    }
  } else {
    // Raw mode: normalize light-background images so positive ALWAYS = bright ink on black
    const flip = meanVal > 0.5;
    for (let i = 0; i < P * C; i++) {
      edgesTD[i] = flip ? 1.0 - grayTD[i] : grayTD[i];
    }
  }

  // 3. Flip to bottom-anchored partial order (row 0 = lowest Hz)
  let plane = new Float32Array(P * C);
  for (let r = 0; r < P; r++) {
    const srcOff = (P - 1 - r) * C;
    const dstOff = r * C;
    plane.set(edgesTD.subarray(srcOff, srcOff + C), dstOff);
  }

  // 4. Optional per-column RMS equalization (bypassed automatically during breathing!)
  const alpha = bypassEq ? 0.0 : (Number(cfg.colEqAlpha) || 0.0);
  if (alpha > 1e-4) {
    const colRms = new Float32Array(C);
    const activeVals = [];
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let r = 0; r < P; r++) {
        const v = plane[r * C + c];
        s += v * v;
      }
      const rms = Math.sqrt(s / P + 1e-8);
      colRms[c] = rms;
      if (rms > 0.02) activeVals.push(rms);
    }
    if (activeVals.length) {
      activeVals.sort((a, b) => a - b);
      const refRms = activeVals[Math.floor(activeVals.length / 2)];
      for (let c = 0; c < C; c++) {
        if (colRms[c] <= 0.02) continue;
        const g = Math.min(2.8, Math.max(0.35, Math.pow(refRms / colRms[c], alpha)));
        for (let r = 0; r < P; r++) plane[r * C + c] *= g;
      }
    }
  }

  // 5. Horizontal temporal feathering (anti-splatter)
  const featherMs = Number(cfg.featherMs) || 0;
  if (featherMs > 0.5) {
    const sigma = (featherMs / 1000.0) * (Number(cfg.pps) || 120.0) * 0.45;
    if (sigma >= 0.35) {
      plane = gaussianBlurHoriz(plane, P, C, sigma);
    }
  }

  // Normalize ceiling cleanly to [0, 1]
  let hi = 0;
  for (let i = 0; i < plane.length; i++) if (plane[i] > hi) hi = plane[i];
  const div = Math.max(1.0, hi);
  for (let i = 0; i < plane.length; i++) {
    let v = Math.min(1.0, Math.max(0.0, plane[i] / div));
    if (polarity === "neg") v = 1.0 - v;
    plane[i] = v;
  }

  return { plane, P, C };
}

/**
 * Extract normalized color warmth/saturation [P, C] (bottom-anchored) for FAS Blue-channel timbre routing.
 * Warm gold/yellow/pink (R > B) -> high (0.75..1.0); cool cyan/blue (B > R) -> low (0.05..0.35).
 */
export function rgbaToChromaWarmthPlane(rgba, srcW, srcH, P, C) {
  const out = new Float32Array(P * C);
  const scaleX = srcW / C;
  const scaleY = srcH / P;
  for (let r = 0; r < P; r++) {
    const sy = Math.min(srcH - 1, Math.max(0, ((P - 1 - r) + 0.5) * scaleY - 0.5)) | 0;
    const dstOff = r * C;
    for (let c = 0; c < C; c++) {
      const sx = Math.min(srcW - 1, Math.max(0, (c + 0.5) * scaleX - 0.5)) | 0;
      const o = (sy * srcW + sx) * 4;
      const R = rgba[o] / 255.0;
      const G = rgba[o + 1] / 255.0;
      const B = rgba[o + 2] / 255.0;
      const maxC = Math.max(R, G, B);
      const minC = Math.min(R, G, B);
      const sat = maxC > 1e-4 ? (maxC - minC) / maxC : 0.0;
      // Warmth centered at 0.5, pulled toward 1.0 for gold/red/pink and 0.0 for cyan/blue
      const warmth = 0.5 + 0.5 * (R - B);
      out[dstOff + c] = Math.min(1.0, Math.max(0.0, warmth * (0.25 + 0.75 * sat)));
    }
  }
  return out;
}

/**
 * Compute neuromorphic Event-Camera (+ON / -OFF) planes across a sequence of positive-demodulated
 * [P, C] frames, with optional exponential phosphor persistence trail (0.0..0.85).
 * Returns { onPlanes, offPlanes, mixPlanes, frameMotionScores }.
 */
export function computeEventCameraSequence(demodPlanes, P, C, { threshold = 0.05, gain = 1.65, decay = 0.45 } = {}) {
  const N = demodPlanes.length;
  const onPlanes = [];
  const offPlanes = [];
  const mixPlanes = [];
  const frameMotionScores = [];
  if (N === 0) return { onPlanes, offPlanes, mixPlanes, frameMotionScores };

  const len = P * C;
  const thr = Math.max(0.0, Number(threshold) || 0.05);
  const g = Math.max(0.5, Number(gain) || 1.65);
  const dec = Math.max(0.0, Math.min(0.88, Number(decay) || 0.0));

  let trailOn = new Float32Array(len);
  let trailOff = new Float32Array(len);

  for (let k = 0; k < N; k++) {
    const prev = k === 0 ? demodPlanes[N - 1] : demodPlanes[k - 1];
    const curr = demodPlanes[k];
    const pOn = new Float32Array(len);
    const pOff = new Float32Array(len);
    const pMix = new Float32Array(len);

    let sumDelta = 0;
    for (let i = 0; i < len; i++) {
      const d = curr[i] - prev[i];
      sumDelta += Math.abs(d);
      const rawOn = d > thr ? Math.min(1.0, (d - thr) * g) : 0.0;
      const rawOff = d < -thr ? Math.min(1.0, (-d - thr) * g) : 0.0;

      const vOn = Math.max(rawOn, trailOn[i] * dec);
      const vOff = Math.max(rawOff, trailOff[i] * dec);
      trailOn[i] = vOn;
      trailOff[i] = vOff;

      pOn[i] = vOn;
      pOff[i] = vOff;
      pMix[i] = Math.min(1.0, Math.max(vOn, vOff));
    }

    onPlanes.push(pOn);
    offPlanes.push(pOff);
    mixPlanes.push(pMix);
    frameMotionScores.push(Number((sumDelta / Math.max(1, len)).toFixed(4)));
  }

  return { onPlanes, offPlanes, mixPlanes, frameMotionScores };
}

/**
 * Render an Event-Camera (+ON cyan / -OFF amber) RGBA image from precomputed on/off planes.
 */
export function renderEventOnOffRGBA(onPlane, offPlane, P, C) {
  const rgba = new Uint8ClampedArray(P * C * 4);
  for (let r = 0; r < P; r++) {
    const srcRow = (P - 1 - r) * C;
    const dstRow = r * C;
    for (let c = 0; c < C; c++) {
      const vOn = onPlane[srcRow + c];
      const vOff = offPlane[srcRow + c];
      const o = (dstRow + c) * 4;
      rgba[o] = Math.min(255, Math.round(vOff * 255 + vOn * 28));
      rgba[o + 1] = Math.min(255, Math.round(vOn * 238 + vOff * 112));
      rgba[o + 2] = Math.min(255, Math.round(vOn * 255 + vOff * 26));
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function boxBlur2D(src, H, W, radius) {
  const tmp = new Float32Array(H * W);
  const out = new Float32Array(H * W);
  const k = 2 * radius + 1;
  for (let r = 0; r < H; r++) {
    const row = r * W;
    for (let c = 0; c < W; c++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) {
        const cc = Math.min(W - 1, Math.max(0, c + d));
        s += src[row + cc];
      }
      tmp[row + c] = s / k;
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) {
        const rr = Math.min(H - 1, Math.max(0, r + d));
        s += tmp[rr * W + c];
      }
      out[r * W + c] = s / k;
    }
  }
  return out;
}

function gaussianBlurHoriz(src, P, C, sigma) {
  const rad = Math.max(1, Math.ceil(2.5 * sigma));
  const ker = new Float32Array(2 * rad + 1);
  let ksum = 0;
  for (let i = -rad; i <= rad; i++) {
    const w = Math.exp(-0.5 * (i / sigma) ** 2);
    ker[i + rad] = w;
    ksum += w;
  }
  for (let i = 0; i < ker.length; i++) ker[i] /= ksum;

  const out = new Float32Array(P * C);
  for (let r = 0; r < P; r++) {
    const row = r * C;
    for (let c = 0; c < C; c++) {
      let acc = 0;
      for (let d = -rad; d <= rad; d++) {
        const cc = Math.min(C - 1, Math.max(0, c + d));
        acc += src[row + cc] * ker[d + rad];
      }
      out[row + c] = acc;
    }
  }
  return out;
}

/**
 * Compute exact 4-state Endomorphic Seam Delta + vertical spectral optical flow.
 * Partition of unity: sustainedOn + quenched + ignited + sustainedOff === 1.0
 */
export function computeSeamDelta(planeA, planeB, P, C, freqsHz, leftMeta, rightMeta, seamIndex) {
  const n = P * C;
  let s11 = 0, s10 = 0, s01 = 0, s00 = 0;
  let signedSum = 0, rectSum = 0;

  let wSumA = 0, fSumA = 0;
  let wSumB = 0, fSumB = 0;

  for (let r = 0; r < P; r++) {
    const off = r * C;
    let rowA = 0, rowB = 0;
    for (let c = 0; c < C; c++) {
      const a = Math.min(1, Math.max(0, planeA[off + c]));
      const b = Math.min(1, Math.max(0, planeB[off + c]));
      s11 += a * b;
      s10 += a * (1 - b);
      s01 += (1 - a) * b;
      s00 += (1 - a) * (1 - b);
      const d = b - a;
      signedSum += d;
      rectSum += Math.abs(d);
      rowA += a;
      rowB += b;
    }
    const f = freqsHz[r];
    wSumA += rowA; fSumA += rowA * f;
    wSumB += rowB; fSumB += rowB * f;
  }

  s11 /= n; s10 /= n; s01 /= n; s00 /= n;
  const midHz = freqsHz.length ? 0.5 * (freqsHz[0] + freqsHz[freqsHz.length - 1]) : 0;
  const cLeft = wSumA > 1e-9 ? fSumA / wSumA : midHz;
  const cRight = wSumB > 1e-9 ? fSumB / wSumB : midHz;
  const dispR = Math.min(999.0, s01 / Math.max(s10, 1e-6));

  return {
    seamIndex,
    leftTitle: leftMeta.title,
    rightTitle: rightMeta.title,
    polarityTransition: `${leftMeta.polarity}->${rightMeta.polarity}`,
    isInvertedSeam: leftMeta.polarity !== rightMeta.polarity,
    sustainedOn: Number(s11.toFixed(5)),
    quenched: Number(s10.toFixed(5)),
    ignited: Number(s01.toFixed(5)),
    sustainedOff: Number(s00.toFixed(5)),
    dispersionRatio: Number(dispR.toFixed(4)),
    signedFlux: Number((signedSum / n).toFixed(5)),
    rectifiedFlux: Number((rectSum / n).toFixed(5)),
    centroidLeftHz: Number(cLeft.toFixed(1)),
    centroidRightHz: Number(cRight.toFixed(1)),
    centroidDeltaHz: Number((cRight - cLeft).toFixed(1)),
  };
}

export function renderPlaneGreenRGBA(plane, P, C) {
  const rgba = new Uint8ClampedArray(P * C * 4);
  for (let r = 0; r < P; r++) {
    // Flip to top-down display
    const srcRow = (P - 1 - r) * C;
    const dstRow = r * C;
    for (let c = 0; c < C; c++) {
      const v = Math.min(1, Math.max(0, plane[srcRow + c]));
      const o = (dstRow + c) * 4;
      rgba[o] = Math.round(Math.pow(v, 2.2) * 180);
      rgba[o + 1] = Math.round(v * 255);
      rgba[o + 2] = Math.round(Math.pow(v, 1.8) * 140);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

export function renderSeamDeltaRGBA(planeA, planeB, P, C) {
  const rgba = new Uint8ClampedArray(P * C * 4);
  for (let r = 0; r < P; r++) {
    const srcRow = (P - 1 - r) * C;
    const dstRow = r * C;
    for (let c = 0; c < C; c++) {
      const a = Math.min(1, Math.max(0, planeA[srcRow + c]));
      const b = Math.min(1, Math.max(0, planeB[srcRow + c]));
      const s11 = a * b;
      const s10 = a * (1 - b);
      const s01 = (1 - a) * b;
      const o = (dstRow + c) * 4;
      rgba[o] = Math.min(255, Math.round(s10 * 255 + s11 * 40 + s01 * 20));
      rgba[o + 1] = Math.min(255, Math.round(s11 * 235 + s01 * 205 + s10 * 95));
      rgba[o + 2] = Math.min(255, Math.round(s01 * 255 + s11 * 80 + s10 * 35));
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Fast phase-continuous additive synthesis for one [P, C] slot using coupled rotation recurrence.
 * Matches exact sin(2π f t + φ_k) to ~1e-12 while running ~10x faster than Math.sin per sample.
 */
export function renderSlotAudio(plane, P, C, freqsHz, cfg) {
  const sr = Number(cfg.sr) || 48000;
  const dur = Number(cfg.slotDurationS) || 2.0;
  const n = Math.round(dur * sr);
  const out = new Float64Array(n);
  if (n <= 0 || P <= 0 || C <= 0) return out;

  const phases = new Float64Array(P);
  if (cfg.phaseMode === "zero") {
    // zeros
  } else if (cfg.phaseMode === "random") {
    // Deterministic LCG PRNG
    let seed = 1337;
    for (let k = 0; k < P; k++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      phases[k] = (seed / 4294967296) * 2 * Math.PI;
    }
  } else {
    // Schroeder minimum-crest phase law (ideal for dense negative breathing frames!)
    for (let k = 0; k < P; k++) {
      phases[k] = (Math.PI * k * (k - 1)) / Math.max(1, P);
    }
  }

  const colScale = C / n; // maps sample index -> control column index
  const cMax = C - 1;

  for (let p = 0; p < P; p++) {
    const rowOff = p * C;
    // Skip completely silent partials
    let active = false;
    for (let c = 0; c < C; c++) {
      if (plane[rowOff + c] > 1e-4) { active = true; break; }
    }
    if (!active) continue;

    const w = (2 * Math.PI * freqsHz[p]) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let u = Math.cos(phases[p]);
    let v = Math.sin(phases[p]);

    for (let i = 0; i < n; i++) {
      const cf = i * colScale;
      const c0 = cf | 0;
      const c1 = c0 < cMax ? c0 + 1 : cMax;
      const frac = cf - c0;
      const amp = plane[rowOff + c0] * (1 - frac) + plane[rowOff + c1] * frac;
      out[i] += amp * v;

      const nu = cw * u - sw * v;
      const nv = sw * u + cw * v;
      u = nu;
      v = nv;
      if ((i & 4095) === 4095) {
        const inv = 1.0 / Math.hypot(u, v);
        u *= inv;
        v *= inv;
      }
    }
  }

  // Raised-cosine slot boundary fade (anti-click + clean dark slot divider)
  const fadeN = Math.floor(sr * ((Number(cfg.slotGapMs) || 18.0) / 1000.0));
  if (fadeN > 0 && fadeN * 2 < n) {
    for (let i = 0; i < fadeN; i++) {
      const ramp = 0.5 * (1.0 - Math.cos((Math.PI * i) / fadeN));
      out[i] *= ramp;
      out[n - 1 - i] *= ramp;
    }
  }
  return out;
}

export function renderTimelineAudio(planes, P, C, freqsHz, cfg, onProgress = null) {
  const slots = [];
  for (let i = 0; i < planes.length; i++) {
    slots.push(renderSlotAudio(planes[i], P, C, freqsHz, cfg));
    if (onProgress) onProgress((i + 1) / planes.length);
  }
  const totalLen = slots.reduce((a, s) => a + s.length, 0);
  const audio = new Float64Array(totalLen);
  let pos = 0;
  let peak = 0;
  for (const s of slots) {
    audio.set(s, pos);
    pos += s.length;
    for (let i = 0; i < s.length; i++) {
      const a = Math.abs(s[i]);
      if (a > peak) peak = a;
    }
  }
  const scale = peak > 1e-9 ? 0.89 / peak : 1.0;
  for (let i = 0; i < totalLen; i++) audio[i] *= scale;

  const slotRmsDb = slots.map((seg) => {
    let ss = 0;
    for (let i = 0; i < seg.length; i++) {
      const v = seg[i] * scale;
      ss += v * v;
    }
    const rms = Math.sqrt(ss / Math.max(1, seg.length));
    return Number((20 * Math.log10(Math.max(rms, 1e-6))).toFixed(2));
  });

  return { audio, slotRmsDb };
}

/**
 * Pure-JS RIFF/WAVE Mono Encoder supporting 16-bit PCM, 24-bit PCM, and 32-bit IEEE Float.
 */
export function encodeWavMono(samples, sr, bitDepth = 24) {
  const n = samples.length;
  const bd = Number(bitDepth) || 24;
  const srI = Number(sr) || 48000;

  if (bd === 32) {
    // 32-bit IEEE Float (wFormatTag = 3 + fact chunk)
    const dataBytes = n * 4;
    const buf = new ArrayBuffer(12 + 24 + 12 + 8 + dataBytes);
    const dv = new DataView(buf);
    writeAscii(dv, 0, "RIFF");
    dv.setUint32(4, buf.byteLength - 8, true);
    writeAscii(dv, 8, "WAVE");
    writeAscii(dv, 12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 3, true); // IEEE float
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, srI, true);
    dv.setUint32(28, srI * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 32, true);
    writeAscii(dv, 36, "fact");
    dv.setUint32(40, 4, true);
    dv.setUint32(44, n, true);
    writeAscii(dv, 48, "data");
    dv.setUint32(52, dataBytes, true);
    let o = 56;
    for (let i = 0; i < n; i++, o += 4) {
      dv.setFloat32(o, Math.max(-1, Math.min(1, samples[i])), true);
    }
    return new Uint8Array(buf);
  }

  if (bd === 24) {
    const dataBytes = n * 3;
    const pad = dataBytes % 2;
    const buf = new ArrayBuffer(44 + dataBytes + pad);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    writeAscii(dv, 0, "RIFF");
    dv.setUint32(4, buf.byteLength - 8, true);
    writeAscii(dv, 8, "WAVE");
    writeAscii(dv, 12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true);
    dv.setUint32(24, srI, true);
    dv.setUint32(28, srI * 3, true);
    dv.setUint16(32, 3, true);
    dv.setUint16(34, 24, true);
    writeAscii(dv, 36, "data");
    dv.setUint32(40, dataBytes, true);
    let o = 44;
    for (let i = 0; i < n; i++, o += 3) {
      const s = Math.max(-8388608, Math.min(8388607, Math.round(samples[i] * 8388607.0)));
      u8[o] = s & 0xFF;
      u8[o + 1] = (s >> 8) & 0xFF;
      u8[o + 2] = (s >> 16) & 0xFF;
    }
    return u8;
  }

  // 16-bit PCM
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  writeAscii(dv, 0, "RIFF");
  dv.setUint32(4, buf.byteLength - 8, true);
  writeAscii(dv, 8, "WAVE");
  writeAscii(dv, 12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, srI, true);
  dv.setUint32(28, srI * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeAscii(dv, 36, "data");
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767.0))), true);
  }
  return new Uint8Array(buf);
}

function writeAscii(dv, offset, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
}

// --- Fast Radix-2 Cooley-Tukey FFT & Green STFT Spectrogram Renderer ---
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let uRe = 1, uIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tRe = re[b] * uRe - im[b] * uIm;
        const tIm = re[b] * uIm + im[b] * uRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nu = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = nu;
      }
    }
  }
}

export function renderStftSpectrogramRGBA(audio, cfg, outW = 1200, outH = 340, dbFloor = -78.0) {
  const sr = Number(cfg.sr) || 48000;
  const fft = Number(cfg.fftSize) || 4096;
  const nBins = (fft >> 1) + 1;
  const fMin = Math.max(20, Number(cfg.fMinHz) || 120);
  const fMax = Math.min(sr * 0.5, Number(cfg.fMaxHz) || 18500);
  const isLog = cfg.freqScale === "log";

  const win = new Float64Array(fft);
  let winSum = 0;
  for (let i = 0; i < fft; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fft);
    winSum += win[i];
  }
  const normScale = 2.0 / Math.max(1e-9, winSum);

  // Sample exact `outW` evenly spaced STFT frames across the audio timeline (exact clip-slice alignment)
  const nFrames = Math.max(16, Math.round(outW));
  const mags = new Float32Array(nFrames * outH);

  // Precompute vertical bin mapping for each output row (top-down -> high Hz at row 0)
  const binIdx0 = new Int32Array(outH);
  const binIdx1 = new Int32Array(outH);
  const binFrac = new Float32Array(outH);
  const binHz = (sr * 0.5) / (nBins - 1);
  for (let y = 0; y < outH; y++) {
    const u = 1.0 - y / Math.max(1, outH - 1); // 1 at top (fMax), 0 at bottom (fMin)
    const hz = isLog ? fMin * Math.pow(fMax / fMin, u) : fMin + u * (fMax - fMin);
    const fi = Math.max(0, Math.min(nBins - 1, hz / binHz));
    const b0 = Math.floor(fi);
    binIdx0[y] = b0;
    binIdx1[y] = Math.min(nBins - 1, b0 + 1);
    binFrac[y] = fi - b0;
  }

  const re = new Float64Array(fft);
  const im = new Float64Array(fft);
  let peakMag = 1e-12;

  const span = Math.max(0, audio.length - fft);
  for (let f = 0; f < nFrames; f++) {
    const start = nFrames > 1 ? Math.floor((f / (nFrames - 1)) * span) : 0;
    for (let i = 0; i < fft; i++) {
      re[i] = (start + i < audio.length ? audio[start + i] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const colOff = f * outH;
    for (let y = 0; y < outH; y++) {
      const b0 = binIdx0[y], b1 = binIdx1[y], fr = binFrac[y];
      const m0 = Math.hypot(re[b0], im[b0]) * normScale;
      const m1 = Math.hypot(re[b1], im[b1]) * normScale;
      const m = m0 * (1 - fr) + m1 * fr;
      mags[colOff + y] = m;
      if (m > peakMag) peakMag = m;
    }
  }

  const rgba = new Uint8ClampedArray(nFrames * outH * 4);
  for (let f = 0; f < nFrames; f++) {
    const colOff = f * outH;
    for (let y = 0; y < outH; y++) {
      const m = mags[colOff + y];
      const db = 20 * Math.log10(Math.max(m / peakMag, 1e-9));
      const v = Math.min(1, Math.max(0, (db - dbFloor) / (-dbFloor)));
      const o = (y * nFrames + f) * 4;
      rgba[o] = Math.round(Math.pow(v, 2.2) * 180);
      rgba[o + 1] = Math.round(v * 255);
      rgba[o + 2] = Math.round(Math.pow(v, 1.8) * 140);
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width: nFrames, height: outH };
}
