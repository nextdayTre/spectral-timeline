// Official-protocol binary WebSocket client for Fragment Audio Server (grz0zrg/fas v2.x)
// Exact packet byte layouts verified against grz0zrg/fsynth/client/js/worker/fas.js
// and grz0zrg/fas/src/{constants.h, types.h, oscillators.c, note.c}.

export const FAS_SYNTH_METHODS = [
  { id: 0,  name: "Additive (Osc Bank)" },
  { id: 1,  name: "Spectral (afSTFT)" },
  { id: 3,  name: "FM Synthesis" },
  { id: 4,  name: "Subtractive (PolyBLEP)" },
  { id: 6,  name: "Wavetable" },
  { id: 7,  name: "Bandpass" },
  { id: 8,  name: "Formant" },
  { id: 9,  name: "Phase Distortion" },
  { id: 10, name: "String Resonator" },
  { id: 11, name: "Modal Synthesis" },
];

export const FAS_VOID = 15;

// --- Exact Binary Packet Encoders (Little-Endian, 8-byte aligned headers) ---

export function buildBankSettingsPacket({ h = 512, octaves = 10, floatData = false, baseFreq = 16.35 } = {}) {
  const buf = new ArrayBuffer(32); // 8 hdr + 4 h + 4 oct + 4 dtype + 4 pad + 8 baseFreq
  const u8 = new Uint8Array(buf, 0, 1);
  const u32 = new Uint32Array(buf, 8, 3);
  const f64 = new Float64Array(buf, 24, 1);
  u8[0] = 0; // BANK_SETTINGS
  u32[0] = Math.max(16, Math.min(2048, Number(h) || 512));
  u32[1] = Math.max(1, Math.min(12, Number(octaves) || 10));
  u32[2] = floatData ? 1 : 0;
  f64[0] = Math.max(8.0, Number(baseFreq) || 16.35);
  return buf;
}

export function buildSynthSettingsPacket(target, value) {
  // target: 0 = fps, 1 = gain
  const buf = new ArrayBuffer(24);
  new Uint8Array(buf, 0, 1)[0] = 2; // SYNTH_SETTINGS
  new Uint8Array(buf, 8, 1)[0] = target & 0xFF;
  new Float64Array(buf, 16, 1)[0] = Number(value);
  return buf;
}

export function buildChannelSettingsPacket(chn, target, value) {
  // target: 0 = muted, 1 = output_chn
  const buf = new ArrayBuffer(24);
  new Uint8Array(buf, 0, 1)[0] = 3; // CHN_SETTINGS
  const u32 = new Uint32Array(buf, 8, 2);
  u32[0] = chn >>> 0;
  u32[1] = target >>> 0;
  new Float64Array(buf, 16, 1)[0] = Number(value);
  return buf;
}

export function buildActionPacket(actionType) {
  // 4 = PAUSE, 5 = PLAY/RESUME
  const buf = new ArrayBuffer(8);
  const u8 = new Uint8Array(buf, 0, 2);
  u8[0] = 5; // ACTION
  u8[1] = actionType & 0xFF;
  return buf;
}

export function buildInstrumentSettingsPacket(instrument, target, value) {
  // target: 0 = synth_type (0..15), 1 = mute, 2 = output_channel, 3..7 = p0..p4
  const buf = new ArrayBuffer(24);
  new Uint8Array(buf, 0, 1)[0] = 6; // INSTRUMENT_SETTINGS
  const u32 = new Uint32Array(buf, 8, 2);
  u32[0] = instrument >>> 0;
  u32[1] = target >>> 0;
  new Float64Array(buf, 16, 1)[0] = Number(value);
  return buf;
}

/**
 * Pack 1-pixel-wide vertical slice RGBA (bottom-up: index 0 = baseFreq, index h-1 = maxFreq)
 * into a FAS FRAME_DATA packet (packet_id = 1, instruments = 1).
 * `sliceBytes` must be Uint8Array of length h * 4 (for 8-bit) or Float32Array of length h * 4 (for float).
 */
export function buildFrameDataPacket(sliceData, floatData = false) {
  const byteLen = sliceData.byteLength;
  const buf = new ArrayBuffer(16 + byteLen);
  new Uint8Array(buf, 0, 1)[0] = 1; // FRAME_DATA
  new Uint32Array(buf, 8, 1)[0] = 1; // 1 instrument slice
  if (floatData) {
    new Float32Array(buf, 16, sliceData.length).set(sliceData);
  } else {
    new Uint8Array(buf, 16, sliceData.length).set(sliceData);
  }
  return buf;
}

export function parseStreamInfosPacket(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 16) return null;
  const i32 = new Int32Array(arrayBuffer, 0, 2);
  const f64 = new Float64Array(arrayBuffer, 8, 1);
  if (i32[0] !== 0) return null;
  return { load: i32[1], latencyMs: f64[0] };
}

/**
 * Live WebSocket client & 60fps vertical-slice streamer for Fragment Audio Server.
 */
export class FasClient {
  constructor({ onStatus = null, onTelemetry = null, onError = null } = {}) {
    this.ws = null;
    this.address = "127.0.0.1:3003";
    this.connected = false;
    this.onStatus = onStatus;
    this.onTelemetry = onTelemetry;
    this.onError = onError;

    this.bank = { h: 512, octaves: 10, baseFreq: 16.35, floatData: false };
    this.synth = { fps: 60, gain: 0.12, method: 0 };

    // Live playback timer
    this._timer = null;
    this._zeroSlice = new Uint8Array(this.bank.h * 4);
  }

  connect(address = "127.0.0.1:3003") {
    this.disconnect();
    this.address = String(address || "127.0.0.1:3003").replace(/^wss?:\/\//i, "").trim();
    const url = `ws://${this.address}`;
    try {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.syncSettings();
        if (this.onStatus) this.onStatus(true, `Connected to FAS (${this.address})`);
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          const info = parseStreamInfosPacket(ev.data);
          if (info && this.onTelemetry) this.onTelemetry(info);
        }
      };

      ws.onerror = () => {
        if (this.onError) this.onError(`Could not reach FAS at ${url} — is fas.exe running?`);
      };

      ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopStream(false);
        if (this.onStatus) {
          this.onStatus(false, wasConnected ? "FAS disconnected" : `FAS offline (${this.address})`);
        }
      };
    } catch (err) {
      if (this.onError) this.onError(err?.message || String(err));
    }
  }

  disconnect() {
    this.stopStream(true);
    if (this.ws) {
      try { this.ws.close(1000); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }

  _send(buf) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(buf);
      return true;
    }
    return false;
  }

  syncSettings(bankPatch = null, synthPatch = null) {
    if (bankPatch) this.bank = { ...this.bank, ...bankPatch };
    if (synthPatch) this.synth = { ...this.synth, ...synthPatch };
    this._zeroSlice = new Uint8Array(this.bank.h * 4);

    if (!this.connected) return;
    this._send(buildBankSettingsPacket(this.bank));
    this._send(buildSynthSettingsPacket(0, this.synth.fps));
    this._send(buildSynthSettingsPacket(1, this.synth.gain));
    this._send(buildChannelSettingsPacket(0, 0, 0)); // ch0 unmuted
    this._send(buildChannelSettingsPacket(0, 1, 0)); // ch0 -> out 0
    this._send(buildInstrumentSettingsPacket(0, 0, this.synth.method));
    this._send(buildInstrumentSettingsPacket(0, 1, 0)); // unmuted
    this._send(buildInstrumentSettingsPacket(0, 2, 0)); // output channel 0
    this._send(buildInstrumentSettingsPacket(1, 0, FAS_VOID)); // end of active instruments
    this._send(buildActionPacket(5)); // RESUME / PLAY
  }

  setGain(gain) {
    this.synth.gain = Math.max(0, Math.min(1, Number(gain) || 0.1));
    this._send(buildSynthSettingsPacket(1, this.synth.gain));
  }

  setSynthMethod(methodId) {
    this.synth.method = Number(methodId) || 0;
    this._send(buildInstrumentSettingsPacket(0, 0, this.synth.method));
  }

  sendSlice(sliceBytes) {
    return this._send(buildFrameDataPacket(sliceBytes, false));
  }

  sendSilence() {
    this._send(buildFrameDataPacket(this._zeroSlice, false));
    this._send(buildFrameDataPacket(this._zeroSlice, false));
  }

  /**
   * Stream vertical RGBA slices from a callback `getSliceAt(timeSec) -> Uint8Array(h*4)`
   * synchronized to wall-clock time at `fps`.
   */
  startStream({ durationS, startOffsetS = 0, loop = true, getSliceAt, onTick = null, onEnded = null }) {
    this.stopStream(false);
    if (!this.connected || durationS <= 0) return false;
    this._send(buildActionPacket(5)); // PLAY

    const fps = Math.max(15, Math.min(120, Number(this.synth.fps) || 60));
    const intervalMs = 1000 / fps;
    const tStartWall = performance.now();
    let offset = Math.max(0, startOffsetS);

    const tick = () => {
      if (!this.connected) {
        this.stopStream(false);
        return;
      }
      const elapsed = (performance.now() - tStartWall) / 1000;
      let pos = offset + elapsed;
      if (pos >= durationS) {
        if (loop) {
          pos = pos % durationS;
        } else {
          this.stopStream(true);
          if (onEnded) onEnded();
          return;
        }
      }
      const slice = getSliceAt(pos);
      if (slice) this.sendSlice(slice);
      if (onTick) onTick(pos);
    };

    tick();
    this._timer = setInterval(tick, intervalMs);
    return true;
  }

  stopStream(flushSilence = true) {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (flushSilence && this.connected) {
      this.sendSilence();
    }
  }
}
