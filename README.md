# Spectral Timeline

A **100% browser-native, Resolve-style image-to-spectrogram additive synthesizer** designed for GitHub Pages (zero CLI, zero backend, zero build step).

**Live App (GitHub Pages):** https://nextdayTre.github.io/spectral-timeline/

---

## Core Capabilities

* **Media Bay + Horizontal Timeline Strip:** Drag-and-drop `.png`/`.jpg` images into the Media Bay, drag cards straight onto the timeline (left/right half inserts before/after; hold `Shift` to drop as `− NEG`), and drag clips to reorder with **zero auto-synthesis lag**.
* **Endomorphic Polarity (`+ / −`) & Breathing Cycle:** Toggle any clip between **`+ POS`** (bright green ink on silent black) and **`− NEG`** (carved silent black inside a bright green spectral bed), or enable **`Breathing (+/−)`** to alternate polarity automatically across the entire timeline with Schroeder minimum-crest phase.
* **Uniform Pixel-Box & `secp256k1` `K / K·G` Generator:** Pure-JS `BigInt` secp256k1 scalar multiplication + deterministic 5×7 monospace pixel-box renderer (`66_header` 3×22 alignment for `00+K` vs. `02/03+x`, `64_payload` 4×16 alignment, and `RX11 Lower Band` framing).
* **Pre-Synthesis 4-State Endomorphic Seam Deltas:** Click any `Δ` seam chip between clips to inspect the color-coded 4-state transition map (`1→1 Carry`, `0→1 Ignite`, `1→0 Quench`, `0→0 Off`), Dispersion Ratio $R$, Signed/Rectified Flux (XNOR coincidence on inverted seams), and vertical $\Delta\text{Centroid}$ (Hz).
* **Lossless Master WAV Export (Web Worker):** Renders `16-bit PCM`, `24-bit PCM`, or `32-bit IEEE Float` mono RIFF WAV at `44.1 / 48 / 96 kHz` off the main thread, ready to drop straight into iZotope RX11, plus WebAudio click-to-scrub playback and JSON delta manifest export.

---

## Folder Map

```text
spectral-timeline/
├── index.html          # Main Resolve-style dark UI
├── style.css           # Stylesheet (Media Bay, Monitor, Timeline Strip, Dock)
├── js/
│   ├── glyph_grid.js   # Pure-JS BigInt secp256k1 + 5x7 uniform pixel-box renderer
│   ├── dsp.js          # Conditioning, +/− polarity, 4-state deltas, Schroeder additive synth, STFT, WAV encoder
│   ├── synth_worker.js # Non-blocking Web Worker for synthesis + STFT + WAV encoding
│   └── app.js          # UI controller (drag-and-drop, WebAudio playback, exports)
├── test_node.mjs       # Zero-dependency Node verification suite (`node test_node.mjs`)
└── .nojekyll           # Direct static serving on GitHub Pages
```

## Local Testing (Optional)

```bash
node test_node.mjs
```
To test locally over HTTP (needed for ES module Web Workers):
```bash
python -m http.server 8080
```
