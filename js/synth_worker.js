// Web Worker for non-blocking additive synthesis, STFT spectrogram, and RIFF WAV encoding.
import {
  buildFreqGrid,
  encodeWavMono,
  renderStftSpectrogramRGBA,
  renderTimelineAudio,
} from "./dsp.js";

self.onmessage = (ev) => {
  const { jobId, planes, P, C, cfg } = ev.data;
  try {
    const t0 = performance.now();
    const freqs = buildFreqGrid(cfg);
    const { audio, slotRmsDb } = renderTimelineAudio(planes, P, C, freqs, cfg, (frac) => {
      self.postMessage({ type: "progress", jobId, frac, stage: "Synthesizing partials" });
    });

    self.postMessage({ type: "progress", jobId, frac: 0.85, stage: "Encoding lossless WAV" });
    const masterWav = encodeWavMono(audio, cfg.sr, cfg.bitDepth);
    // Browser WebAudio decodeAudioData is universally happy with 16-bit PCM or Float32
    const playWav = cfg.bitDepth === 16 ? masterWav.slice() : encodeWavMono(audio, cfg.sr, 16);

    self.postMessage({ type: "progress", jobId, frac: 0.92, stage: "Rendering STFT spectrogram" });
    const nClips = Math.max(1, planes.length);
    const frameW = Math.max(64, Math.min(180, Math.floor(1920 / nClips)));
    const spec = renderStftSpectrogramRGBA(audio, cfg, frameW * nClips, 320, -78.0);
    const audioF32 = new Float32Array(audio);
    const elapsedMs = performance.now() - t0;

    self.postMessage(
      {
        type: "done",
        jobId,
        elapsedMs,
        slotRmsDb,
        masterWavBuf: masterWav.buffer,
        playWavBuf: playWav.buffer,
        audioF32Buf: audioF32.buffer,
        audioSr: cfg.sr,
        specRgbaBuf: spec.rgba.buffer,
        specW: spec.width,
        specH: spec.height,
        frameW,
        numClips: nClips,
      },
      [masterWav.buffer, playWav.buffer, audioF32.buffer, spec.rgba.buffer]
    );
  } catch (err) {
    self.postMessage({ type: "error", jobId, message: err?.message || String(err) });
  }
};
