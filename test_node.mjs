#!/usr/bin/env node
// Zero-dependency Node verification suite for Spectral Timeline (GitHub Pages engine)

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  FAS_VOID,
  buildActionPacket,
  buildBankSettingsPacket,
  buildChannelSettingsPacket,
  buildFrameDataPacket,
  buildInstrumentSettingsPacket,
  buildSynthSettingsPacket,
  parseStreamInfosPacket,
} from "./js/fas_client.js";
import {
  SECP256K1_P,
  buildPlasmaShowreelSequence,
  buildSecp256k1BreathingCards,
  buildShapeMorphSequence,
  renderUniformPixelBoxRGBA,
  secp256k1PairHex,
  secp256k1ScalarMul,
} from "./js/glyph_grid.js";
import {
  CARTRIDGE_SCHEMA,
  CARTRIDGE_TEXT_KEY,
  attachId3v2ToMp3,
  decodeLayer2FromCoverRGBA,
  encodeAudioToMp3,
  encodeUncompressedPng,
  extractPngTextChunks,
  injectPngTextChunk,
  parseApicFromMp3,
  renderCartridgeCoverRGBA,
} from "./js/mp3_cartridge.js";
import {
  buildFreqGrid,
  computeEventCameraSequence,
  computeSeamDelta,
  defaultConfig,
  encodeWavMono,
  renderEventOnOffRGBA,
  renderStftSpectrogramRGBA,
  renderTimelineAudio,
  rgbaToChromaWarmthPlane,
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

// 6. Exact Fragment Audio Server (grz0zrg/fas v2.0.2) binary WebSocket packet layouts
{
  const bank = buildBankSettingsPacket({ h: 512, octaves: 10, floatData: false, baseFreq: 16.35 });
  assert.equal(bank.byteLength, 32);
  assert.equal(new Uint8Array(bank, 0, 1)[0], 0);
  assert.deepEqual(Array.from(new Uint32Array(bank, 8, 3)), [512, 10, 0]);
  assert.equal(new Float64Array(bank, 24, 1)[0], 16.35);

  const synth = buildSynthSettingsPacket(0, 60);
  assert.equal(synth.byteLength, 24);
  assert.equal(new Uint8Array(synth, 0, 1)[0], 2);
  assert.equal(new Uint8Array(synth, 8, 1)[0], 0);
  assert.equal(new Float64Array(synth, 16, 1)[0], 60);

  const chn = buildChannelSettingsPacket(0, 1, 0);
  assert.equal(chn.byteLength, 24);
  assert.equal(new Uint8Array(chn, 0, 1)[0], 3);

  const instr = buildInstrumentSettingsPacket(1, 0, FAS_VOID);
  assert.equal(instr.byteLength, 24);
  assert.equal(new Uint8Array(instr, 0, 1)[0], 6);
  assert.equal(new Float64Array(instr, 16, 1)[0], 15);

  const act = buildActionPacket(5);
  assert.equal(act.byteLength, 8);
  assert.deepEqual(Array.from(new Uint8Array(act, 0, 2)), [5, 5]);

  const slice = new Uint8Array(512 * 4);
  slice[0] = 255; slice[1] = 255; slice[3] = 255;
  const frame = buildFrameDataPacket(slice, false);
  assert.equal(frame.byteLength, 16 + 512 * 4);
  assert.equal(new Uint8Array(frame, 0, 1)[0], 1);
  assert.equal(new Uint32Array(frame, 8, 1)[0], 1);
  assert.equal(new Uint8Array(frame, 16, 4)[0], 255);

  const telBuf = new ArrayBuffer(16);
  new Int32Array(telBuf, 0, 2).set([0, 27]);
  new Float64Array(telBuf, 8, 1)[0] = 4.25;
  const tel = parseStreamInfosPacket(telBuf);
  assert.deepEqual(tel, { load: 27, latencyMs: 4.25 });
  console.log("[PASS] Fragment Audio Server (grz0zrg/fas) binary protocol packets (IDs 0,1,2,3,5,6 + telemetry)");
}

// 7. Event-Camera Motion + Phosphor Decay Trail + Chromatic Warmth (Gold Aura vs Cyan Spirit Bomb)
{
  const P = 16, C = 16;
  const f0 = new Float32Array(P * C);
  const f1 = new Float32Array(P * C);
  const f2 = new Float32Array(P * C);
  // Static pixel (must drop to 0 in Event-Cam!) + moving pixel + hard cut
  f0[0] = 0.8; f1[0] = 0.8; f2[0] = 0.8; // static background
  f0[5] = 1.0; f1[6] = 1.0;              // moves from idx 5 -> 6 (-OFF at 5, +ON at 6)
  f2.fill(0.95); f2[0] = 0.8;            // hard scene cut on frame 2

  const ev = computeEventCameraSequence([f0, f1, f2], P, C, { threshold: 0.05, gain: 1.5, decay: 0.5 });
  assert.equal(ev.onPlanes[1][0], 0, "Static pixel must be silent in Event-Cam +ON");
  assert.equal(ev.offPlanes[1][0], 0, "Static pixel must be silent in Event-Cam -OFF");
  assert.ok(ev.onPlanes[1][6] > 0.9, "Advancing edge must fire +ON");
  assert.ok(ev.offPlanes[1][5] > 0.9, "Receding edge must fire -OFF");
  assert.ok(ev.offPlanes[2][5] > 0.4, "Phosphor decay trail must persist on frame 2");
  assert.ok(ev.frameMotionScores[2] > ev.frameMotionScores[1] * 5, "Scene cut must produce peak motion spike");

  const evRgba = renderEventOnOffRGBA(ev.onPlanes[1], ev.offPlanes[1], P, C);
  assert.equal(evRgba.length, P * C * 4);

  // Chroma warmth: electric yellow/gold (255, 220, 30) vs cyan (40, 220, 255)
  const goldRgba = new Uint8ClampedArray(4 * 4 * 4);
  const cyanRgba = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < goldRgba.length; i += 4) {
    goldRgba[i] = 255; goldRgba[i + 1] = 220; goldRgba[i + 2] = 30; goldRgba[i + 3] = 255;
    cyanRgba[i] = 40;  cyanRgba[i + 1] = 220; cyanRgba[i + 2] = 255; cyanRgba[i + 3] = 255;
  }
  const wGold = rgbaToChromaWarmthPlane(goldRgba, 4, 4, 4, 4)[0];
  const wCyan = rgbaToChromaWarmthPlane(cyanRgba, 4, 4, 4, 4)[0];
  assert.ok(wGold > 0.8 && wCyan < 0.25, `Expected gold (${wGold}) >> cyan (${wCyan})`);
  console.log(`[PASS] Event-Cam (+ON/-OFF + phosphor trail + scene cut) & Chroma warmth (gold=${wGold.toFixed(2)} vs cyan=${wCyan.toFixed(2)})`);
}

// 8. Procedural Plasma Sphere + Golden Aura + Hard Cut Showreel
{
  const show = buildPlasmaShowreelSequence({ bpm: 120, beatsPerFrame: 0.25, totalFrames: 24, breathing: true });
  assert.equal(show.frames.length, 24);
  assert.equal(show.cutFrame, 16);
  const cfg = { ...defaultConfig(), partials: 48, pps: 192, slotDurationS: 0.25, featherMs: 0 };
  const demods = show.frames.map((fr) =>
    rgbaToConditionedPlane(fr.grid.rgba, fr.grid.width, fr.grid.height, cfg, "pos", "raw", true).plane
  );
  const ev = computeEventCameraSequence(demods, 48, 48, { threshold: 0.04, gain: 1.8, decay: 0.45 });
  // Strongest scene-cut delta should land right on cutFrame (16)!
  let bestIdx = 1, bestVal = 0;
  for (let i = 1; i < ev.frameMotionScores.length; i++) {
    if (ev.frameMotionScores[i] > bestVal) { bestVal = ev.frameMotionScores[i]; bestIdx = i; }
  }
  assert.equal(bestIdx, show.cutFrame, `Expected peak cut at frame ${show.cutFrame}, got ${bestIdx}`);
  console.log(`[PASS] Procedural Plasma Showreel (24f @ 120 BPM, peak cut locked at #${bestIdx + 1}, Δ=${bestVal.toFixed(3)})`);
}

// 9. Full End-to-End MP3 Synth-Cartridge Round-Trip (lamejs + ID3v2 APIC + Layer 1 PNG tEXt + Layer 2 8x8 Stress!)
{
  const lameCtx = {};
  vm.runInNewContext(fs.readFileSync("./js/vendor/lame.min.js", "utf8"), lameCtx);

  const recipe = {
    schema: CARTRIDGE_SCHEMA,
    type: "shape_morph",
    bpm: 120,
    beatsPerFrame: 0.25,
    framesPerLeg: 6,
    style: "outline",
    breathing: true,
    synthSource: "hybrid",
    trailDecay: 0.45,
    chromaBlue: true,
    fasMethod: 1,
    fasHeight: 512,
    slotDurationS: 0.125,
    numClips: 24,
  };

  // Encode 0.5s test audio to real 96 kbps MP3
  const pcm = new Float32Array(24000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const rawMp3 = encodeAudioToMp3(pcm, 48000, 96, lameCtx.lamejs);
  assert.ok(rawMp3.length > 2000 && rawMp3[0] === 0xFF);

  // Build 512x512 dual-layer cover PNG + Layer 1 tEXt + ID3v2.3 APIC + CHAP
  const cov = renderCartridgeCoverRGBA(recipe, []);
  const rawPng = encodeUncompressedPng(cov.rgba, cov.width, cov.height);
  const taggedPng = injectPngTextChunk(rawPng, CARTRIDGE_TEXT_KEY, JSON.stringify(recipe));
  const cartMp3 = attachId3v2ToMp3(rawMp3, {
    coverPngBytes: taggedPng,
    title: "Shape Morph Cartridge",
    chapters: [{ startMs: 0, endMs: 125, title: "01_Tri" }],
  });
  assert.equal(String.fromCharCode(cartMp3[0], cartMp3[1], cartMp3[2]), "ID3");

  // Parse APIC back out of .mp3
  const apic = parseApicFromMp3(cartMp3);
  assert.ok(apic && apic.mime === "image/png");

  // Layer 1 check: bit-exact JSON round-trip
  const texts = extractPngTextChunks(apic.bytes);
  const dec1 = JSON.parse(texts[CARTRIDGE_TEXT_KEY]);
  assert.equal(dec1.type, "shape_morph");
  assert.equal(dec1.bpm, 120);
  assert.equal(dec1.framesPerLeg, 6);
  assert.equal(dec1.synthSource, "hybrid");

  // Layer 2 check: simulate JPEG-like compression noise (+-28 luma noise + resize to 500x500)
  const stressedW = 500, stressedH = 500;
  const stressed = new Uint8ClampedArray(stressedW * stressedH * 4);
  for (let y = 0; y < stressedH; y++) {
    const sy = Math.floor((y / stressedH) * cov.height);
    for (let x = 0; x < stressedW; x++) {
      const sx = Math.floor((x / stressedW) * cov.width);
      const so = (sy * cov.width + sx) * 4;
      const doff = (y * stressedW + x) * 4;
      const noise = ((x * 37 + y * 17) % 57) - 28;
      stressed[doff] = Math.max(0, Math.min(255, cov.rgba[so] + noise));
      stressed[doff + 1] = Math.max(0, Math.min(255, cov.rgba[so + 1] + noise));
      stressed[doff + 2] = Math.max(0, Math.min(255, cov.rgba[so + 2] + noise));
      stressed[doff + 3] = 255;
    }
  }
  const dec2 = decodeLayer2FromCoverRGBA(stressed, stressedW, stressedH);
  assert.ok(dec2 !== null, "Layer 2 CRC16 decode must survive 500x500 noisy stress!");
  assert.equal(dec2.type, "shape_morph");
  assert.equal(dec2.bpm, 120);
  assert.equal(dec2.beatsPerFrame, 0.25);
  assert.equal(dec2.framesPerLeg, 6);
  assert.equal(dec2.synthSource, "hybrid");
  assert.equal(dec2.trailDecay, 0.45);
  assert.equal(dec2.fasMethod, 1);
  assert.equal(dec2.fasHeight, 512);
  console.log(`[PASS] MP3 Synth-Cartridge round-trip (${(rawMp3.length / 1024).toFixed(1)} KB MP3 · Layer 1 PNG tEXt OK · Layer 2 500x500 noisy stress CRC16 OK)`);
}

console.log("\nALL SPECTRAL TIMELINE BROWSER-ENGINE SELF-TESTS PASSED.");
