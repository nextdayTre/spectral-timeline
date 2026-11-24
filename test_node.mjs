#!/usr/bin/env node
// Zero-dependency Node verification suite for Spectral Timeline (GitHub Pages engine)

import assert from "node:assert/strict";
import {
  SECP256K1_P,
  buildSecp256k1BreathingCards,
  buildShapeMorphSequence,
  renderUniformPixelBoxRGBA,
  secp256k1PairHex,
  secp256k1ScalarMul,
} from "./js/glyph_grid.js";
import {
  buildFreqGrid,
  computeSeamDelta,
  defaultConfig,
  encodeWavMono,
  renderStftSpectrogramRGBA,
  renderTimelineAudio,
  rgbaToConditionedPlane,
} from "./js/dsp.js";

// 1. Official secp256k1 test vectors
{
  const expected = [
    [1n, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"],
    [2n, "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"],
    [3n, "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"],
  ];
  for (const [k, expKg] of expected) {
    const [x, y] = secp256k1ScalarMul(k);
    const onCurve = ((y * y - (x * x * x + 7n)) % SECP256K1_P + SECP256K1_P) % SECP256K1_P;
    assert.equal(onCurve, 0n, `Point ${k}*G not on secp256k1`);
    const { kHex, kgHex } = secp256k1PairHex(k);
    assert.equal(kHex.length, 64);
    assert.equal(kgHex, expKg);
  }
  console.log("[PASS] secp256k1 BigInt vectors (1G, 2G, 3G exact + on-curve)");
}

// 2. Uniform pixel-box geometry & RX11 lower-band silence
{
  const { cards } = buildSecp256k1BreathingCards({ kRaw: "1", count: 2, alignMode: "66_header" });
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => c.polarity), ["pos", "neg", "pos", "neg"]);
  for (const c of cards) {
    assert.equal(c.grid.rows, 3);
    assert.equal(c.grid.cols, 22);
    assert.equal(c.grid.cellW, cards[0].grid.cellW);
    assert.equal(c.grid.cellH, cards[0].grid.cellH);
  }

  const lower = renderUniformPixelBoxRGBA({ text: "0123456789ABCDEF".repeat(4), cols: 16, bandMode: "rx11_lower" });
  assert.equal(lower.rows, 4);
  assert.equal(lower.cols, 16);
  const topRows = Math.floor(lower.height * 0.45);
  let topMax = 0;
  for (let i = 0; i < topRows * lower.width * 4; i += 4) {
    topMax = Math.max(topMax, lower.rgba[i], lower.rgba[i + 1], lower.rgba[i + 2]);
  }
  assert.equal(topMax, 0, "Upper band must be silent black in rx11_lower");
  console.log(`[PASS] uniform pixel-boxes (66-slot=3x22 ${cards[0].grid.cellW}x${cards[0].grid.cellH}px; rx11_lower silent top)`);
}

// 3. Exact 4-state Endomorphic Seam Delta & XNOR stroboscope identity
{
  const P = 40, C = 30;
  const mask = new Float32Array(P * C);
  for (let r = 10; r < 25; r++) {
    for (let c = 8; c < 20; c++) mask[r * C + c] = 1.0;
  }
  const inv = new Float32Array(P * C);
  for (let i = 0; i < mask.length; i++) inv[i] = 1.0 - mask[i];
  const freqs = new Float64Array(P);
  for (let i = 0; i < P; i++) freqs[i] = 500 + (i / (P - 1)) * 3500;

  const dInv = computeSeamDelta(mask, inv, P, C, freqs, { title: "K", polarity: "pos" }, { title: "K_inv", polarity: "neg" }, 0);
  const total = dInv.sustainedOn + dInv.quenched + dInv.ignited + dInv.sustainedOff;
  assert.ok(Math.abs(total - 1.0) < 1e-4, `Partition sum=${total}`);
  assert.equal(dInv.isInvertedSeam, true);
  assert.equal(dInv.sustainedOn, 0);
  assert.equal(dInv.sustainedOff, 0);
  assert.ok(Math.abs(dInv.rectifiedFlux - 1.0) < 1e-4, `rectFlux=${dInv.rectifiedFlux}`);

  const dSame = computeSeamDelta(mask, mask, P, C, freqs, { title: "K", polarity: "pos" }, { title: "K", polarity: "pos" }, 0);
  assert.equal(dSame.rectifiedFlux, 0);
  console.log(`[PASS] 4-state Endomorphic Seam Delta XNOR identity (rectFlux=${dInv.rectifiedFlux}, dispR=${dInv.dispersionRatio})`);
}

// 4. Additive synthesis breathing RMS contrast + STFT + 16/24/32f RIFF WAV headers
{
  const cfg = { ...defaultConfig(), slotDurationS: 0.5, partials: 120, pps: 80, sr: 48000, bitDepth: 24, fftSize: 2048 };
  const freqs = buildFreqGrid(cfg);
  const { cards } = buildSecp256k1BreathingCards({ kRaw: "1", count: 1, alignMode: "66_header" });
  const p0 = rgbaToConditionedPlane(cards[0].grid.rgba, cards[0].grid.width, cards[0].grid.height, cfg, "pos", "raw", true);
  const p1 = rgbaToConditionedPlane(cards[1].grid.rgba, cards[1].grid.width, cards[1].grid.height, cfg, "neg", "raw", true);

  const t0 = performance.now();
  const { audio, slotRmsDb } = renderTimelineAudio([p0.plane, p1.plane], p0.P, p0.C, freqs, cfg);
  const ms = performance.now() - t0;

  assert.equal(audio.length, 48000);
  assert.ok(slotRmsDb[1] > slotRmsDb[0] + 1.5, `Expected neg RMS > pos RMS, got ${slotRmsDb}`);

  const spec = renderStftSpectrogramRGBA(audio, cfg, 320, 120);
  assert.equal(spec.rgba.length, spec.width * spec.height * 4);

  // Verify 16-bit PCM, 24-bit PCM, and 32-bit IEEE float RIFF WAV headers
  for (const [bd, expTag] of [[16, 1], [24, 1], [32, 3]]) {
    const wav = encodeWavMono(audio, 48000, bd);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riff = String.fromCharCode(wav[0], wav[1], wav[2], wav[3]);
    const wave = String.fromCharCode(wav[8], wav[9], wav[10], wav[11]);
    assert.equal(riff, "RIFF");
    assert.equal(wave, "WAVE");
    assert.equal(dv.getUint16(20, true), expTag);
    assert.equal(dv.getUint32(24, true), 48000);
    assert.equal(dv.getUint16(34, true), bd);
  }
  console.log(`[PASS] Schroeder additive synth + breathing contrast (pos=${slotRmsDb[0]} dB vs neg=${slotRmsDb[1]} dB, ${ms.toFixed(0)} ms) + 16b/24b/32f WAV`);
}

// 5. BPM-synced Polar Shape Morph Animation (Triangle -> Circle -> Triangle -> Square) + exact STFT slicing
{
  const seq = buildShapeMorphSequence({ bpm: 120, beatsPerFrame: 0.5, framesPerLeg: 3, style: "outline", breathing: true });
  assert.equal(seq.slotDurationS, 0.25);
  assert.equal(seq.frames.length, 12);
  assert.equal(seq.fftSize, 1024);
  for (let i = 0; i < seq.frames.length; i++) {
    assert.equal(seq.frames[i].polarity, i % 2 === 0 ? "pos" : "neg");
  }

  const animCfg = {
    ...defaultConfig(),
    slotDurationS: seq.slotDurationS,
    fftSize: seq.fftSize,
    slotGapMs: seq.slotGapMs,
    pps: seq.pps,
    fMinHz: 320,
    fMaxHz: 7800,
    partials: 120,
    sr: 48000,
    bitDepth: 24,
  };
  const freqs = buildFreqGrid(animCfg);
  const planes = seq.frames.map((fr) =>
    rgbaToConditionedPlane(fr.grid.rgba, fr.grid.width, fr.grid.height, animCfg, fr.polarity, "raw", true)
  );
  const t0 = performance.now();
  const { audio, slotRmsDb } = renderTimelineAudio(
    planes.map((p) => p.plane),
    planes[0].P,
    planes[0].C,
    freqs,
    animCfg
  );
  const ms = performance.now() - t0;

  const frameW = 96;
  const spec = renderStftSpectrogramRGBA(audio, animCfg, frameW * seq.frames.length, 160);
  assert.equal(spec.width, frameW * seq.frames.length, "STFT width must match exact numClips * frameW");

  const posAvg = slotRmsDb.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / 6;
  const negAvg = slotRmsDb.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / 6;
  assert.ok(negAvg > posAvg + 1.5, `Expected breathing contrast across 12 morph frames: pos=${posAvg}, neg=${negAvg}`);
  console.log(
    `[PASS] BPM shape morph video-as-audio (12 frames @ 120 BPM / 0.25s, pos=${posAvg.toFixed(1)} dB vs neg=${negAvg.toFixed(1)} dB, ${ms.toFixed(0)} ms, STFT=${spec.width}x${spec.height})`
  );
}

console.log("\nALL SPECTRAL TIMELINE BROWSER-ENGINE SELF-TESTS PASSED.");
