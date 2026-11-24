# Spectral Timeline (Powered by Fragment Audio Server)

A **Resolve-style image-to-spectrogram timeline frontend** built for **GitHub Pages**, streaming real-time vertical RGBA slices directly to the native C11 **[Fragment Audio Server (`grz0zrg/fas`)](https://github.com/grz0zrg/fas)** over `ws://127.0.0.1:3003` — with Endomorphic `+ / −` Breathing polarity, `secp256k1` `K / K·G` uniform pixel-box cards, BPM-synced `Tri → Cir → Tri → Sq` morph animation, 4-state Seam Deltas, and one-click stitched PNG strip / offline WAV export.

**Live App (GitHub Pages):** https://nextdaytre.github.io/spectral-timeline/

---

## Showreel & Synth-Cartridge `.mp3` Sharing

* **1-Click `★ Showreel Demos` (Top Bar):**
  1. **Shape Morph (`120 BPM · 24f`):** `Tri → Cir → Tri → Sq` breathing morph at 8 fps with Event-Cam & phosphor trails.
  2. **Plasma Sphere + Aura + Cut (`24f`):** 100% original procedural expanding cyan energy sphere + flickering golden aura + beat-16 hard cut (demonstrates stereo Event-Cam `+ON / −OFF`, `Chroma → FAS Blue` timbre split, and automatic `★CUT` detection).
  3. **`secp256k1` `K / K·G` Breathing:** Uniform `3×22` pixel-box scalar-multiplication chain.
* **Dual-Layer `APIC` MP3 Cartridge (`Export / Strip / WAV` Tab):**
  * Click **`Export Cartridge (.mp3)`** to encode a tiny shareable MP3 (`64–128 kbps`, pure-JS via vendored `lamejs`) whose `512×512` `APIC` cover art embeds the exact lossless expansion math in **Layer 1 (PNG `tEXt`)** and **Layer 2 (JPEG-resilient `8×8` macro-block strip with CRC16)**.
  * Drop any Cartridge `.mp3` back onto the page to re-expand it into crisp 512-oscillator video + audio and toggle **`A: Blurry MP3`** vs. **`B: Expanded`** live!

## Quick Start with Fragment Audio Server (`fas.exe`)

1. Download **`fas-2.0.2-x86_64-win.zip`** from https://github.com/grz0zrg/fas/releases/tag/v2.0.2 and extract into `fas_bin/` (or run `start_fas.bat` in your local clone).
2. Start FAS:
   ```cmd
   start_fas.bat
   ```
   *(Optional: pass `--render my_recording` to record FAS's native audio output directly to disk.)*
3. Open **https://nextdaytre.github.io/spectral-timeline/** and click **`Connect FAS`** in the top bar (works directly from HTTPS GitHub Pages to loopback `ws://127.0.0.1:3003`!).
4. Arrange clips in the Media Bay / Timeline, toggle **`Breathing (+/−)`**, switch **`FAS Synth Method`** live (`Additive`, `Spectral afSTFT`, `FM`, `Subtractive`, `Formant`, `Modal`, `Wavetable`), and press **`Space`** to play!

---

## Folder Map

```text
spectral-timeline/
├── index.html          # Main Resolve-style dark UI with FAS top bar & live telemetry
├── style.css           # Stylesheet
├── start_fas.bat       # One-click local launcher for Fragment Audio Server (fas.exe)
├── js/
│   ├── fas_client.js   # Exact grz0zrg/fas v2.0.2 binary WebSocket protocol client & 60fps slicer
│   ├── glyph_grid.js   # Pure-JS BigInt secp256k1 + 5x7 uniform pixel-box + Polar-SDF shape morph
│   ├── dsp.js          # Conditioning, +/− polarity, 4-state Seam Deltas, & optional offline WAV fallback
│   ├── synth_worker.js # Optional offline WAV Web Worker
│   └── app.js          # Resolve-style UI controller & live FAS streamer
├── test_node.mjs       # Zero-dep Node test suite (`node test_node.mjs`)
└── .nojekyll           # Direct static serving on GitHub Pages
```
