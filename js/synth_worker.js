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
    const spec = renderStftSpectrogramRGBA(audio, cfg, 1280, 360, -78.0);
    const elapsedMs = performance.now() - t0;

    self.postMessage(
      {
        type: "done",
        jobId,
        elapsedMs,
        slotRmsDb,
        masterWavBuf: masterWav.buffer,
        playWavBuf: playWav.buffer,
        specRgbaBuf: spec.rgba.buffer,
        specW: spec.width,
        specH: spec.height,
      },
      [masterWav.buffer, playWav.buffer, spec.rgba.buffer]
    );
  } catch (err) {
    self.postMessage({ type: "error", jobId, message: err?.message || String(err) });
  }
};
