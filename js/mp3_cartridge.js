// Dual-Layer APIC MP3 Synth-Cartridge Codec (100% Pure JS — Browser & Node).
//
// Packages a tiny playable MP3 (64–128 kbps via vendored lamejs) with a 512x512
// custom neon album cover (ID3v2.3 APIC + CHAP/CTOC) carrying the exact lossless
// expansion math in TWO redundant layers:
//   - Layer 1: PNG `tEXt` chunk "SpectralCartridge" (full JSON recipe, 256-bit K, text, FAS params)
//   - Layer 2: JPEG-resilient 8x8 macro-block binary strip (top 4 rows, CRC16-checked)
//              so even if a chat app strips PNG chunks and re-encodes cover art to JPEG,
//              the expansion math survives!

export const CARTRIDGE_TEXT_KEY = "SpectralCartridge";
export const CARTRIDGE_SCHEMA = "spectral-cartridge-v1";

export const COVER_SIZE = 512;
export const CELL_PX = 8;
export const GRID_COLS = COVER_SIZE / CELL_PX; // 64
export const GRID_ROWS = COVER_SIZE / CELL_PX; // 64
export const HEADER_ROWS = 4;                  // top 32px -> 64x4 macro-blocks

const RECIPE_TYPE_TO_ID = {
  shape_morph: 1,
  plasma_showreel: 2,
  secp256k1: 3,
  text_card: 4,
  custom_raster: 5,
};
const ID_TO_RECIPE_TYPE = {
  1: "shape_morph",
  2: "plasma_showreel",
  3: "secp256k1",
  4: "text_card",
  5: "custom_raster",
};
const SRC_TO_ID = { full: 0, event: 1, hybrid: 2 };
const ID_TO_SRC = { 0: "full", 1: "event", 2: "hybrid" };

// --- IEEE CRC32 (for PNG chunks & CRC16 header protection) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function crc16(bytes) {
  return crc32(bytes) & 0xFFFF;
}

// ---------------------------------------------------------------------------
// Layer 2: Compact 28-byte (224-bit) Binary Header for 8x8 Macro-Block Strip
// ---------------------------------------------------------------------------
export function packLayer2Header(recipe) {
  const buf = new ArrayBuffer(28);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  u8[0] = 0x53; // 'S'
  u8[1] = 0x43; // 'C'
  u8[2] = 1;    // version
  u8[3] = RECIPE_TYPE_TO_ID[recipe.type] || 5;

  const bpm = Math.max(40, Math.min(300, Number(recipe.bpm) || 120));
  const bpf = Math.max(0.12, Math.min(8.0, Number(recipe.beatsPerFrame) || 0.25));
  const countParam = Math.max(1, Math.min(65535, Number(recipe.framesPerLeg || recipe.totalFrames || recipe.count || 3)));

  dv.setUint16(4, Math.round(bpm * 10), true);
  dv.setUint16(6, Math.round(bpf * 100), true);
  dv.setUint16(8, countParam, true);

  const srcId = SRC_TO_ID[recipe.synthSource] ?? 0;
  const flags =
    (recipe.breathing ? 1 : 0) |
    (recipe.style === "solid" ? 2 : 0) |
    (recipe.alignMode === "64_payload" ? 4 : 0) |
    (recipe.bandMode === "rx11_lower" ? 8 : 0) |
    (recipe.chromaBlue ? 16 : 0) |
    ((srcId & 0x03) << 5);
  u8[10] = flags;
  u8[11] = Math.max(0, Math.min(100, Math.round((Number(recipe.trailDecay) || 0) * 100)));
  u8[12] = Math.max(0, Math.min(255, Number(recipe.fasMethod) || 0));
  u8[13] = Math.max(8, Math.min(255, Math.round((Number(recipe.fasHeight) || 512) / 8)));

  // Low 64 bits of secp256k1 scalar K (or 0 for non-secp)
  let kVal = 1n;
  try {
    const s = String(recipe.kRaw || "1").trim();
    if (/^0x/i.test(s)) kVal = BigInt(s);
    else if (/[a-fA-F]/.test(s) || s.length >= 16) kVal = BigInt("0x" + s);
    else if (/^\d+$/.test(s)) kVal = BigInt(s);
  } catch (_) {
    kVal = 1n;
  }
  dv.setBigUint64(14, kVal & 0xFFFFFFFFFFFFFFFFn, true);

  // Slot duration in ms (uint16 at bytes 22..23) + clip count (uint16 at bytes 24..25)
  const slotMs = Math.max(10, Math.min(65535, Math.round((Number(recipe.slotDurationS) || 0.25) * 1000)));
  dv.setUint16(22, slotMs, true);
  dv.setUint16(24, Math.max(1, Math.min(65535, Number(recipe.numClips) || 1)), true);

  const c16 = crc16(u8.subarray(0, 26));
  dv.setUint16(26, c16, true);
  return u8;
}

export function unpackLayer2Header(bytes) {
  if (!bytes || bytes.length < 28) return null;
  if (bytes[0] !== 0x53 || bytes[1] !== 0x43 || bytes[2] !== 1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 28);
  const expectedCrc = dv.getUint16(26, true);
  const actualCrc = crc16(bytes.subarray(0, 26));
  if (expectedCrc !== actualCrc) return null;

  const type = ID_TO_RECIPE_TYPE[bytes[3]] || "custom_raster";
  const bpm = dv.getUint16(4, true) / 10.0;
  const beatsPerFrame = dv.getUint16(6, true) / 100.0;
  const countParam = dv.getUint16(8, true);
  const flags = bytes[10];
  const trailDecay = bytes[11] / 100.0;
  const fasMethod = bytes[12];
  const fasHeight = bytes[13] * 8;
  const kLo = dv.getBigUint64(14, true);
  const slotDurationS = dv.getUint16(22, true) / 1000.0;
  const numClips = dv.getUint16(24, true);

  return {
    schema: CARTRIDGE_SCHEMA,
    type,
    bpm,
    beatsPerFrame,
    framesPerLeg: type === "shape_morph" ? countParam : 3,
    totalFrames: type === "plasma_showreel" ? countParam : 24,
    count: type === "secp256k1" ? countParam : 1,
    breathing: Boolean(flags & 1),
    style: (flags & 2) ? "solid" : "outline",
    alignMode: (flags & 4) ? "64_payload" : "66_header",
    bandMode: (flags & 8) ? "rx11_lower" : "full",
    chromaBlue: Boolean(flags & 16),
    synthSource: ID_TO_SRC[(flags >> 5) & 0x03] || "full",
    trailDecay,
    fasMethod,
    fasHeight,
    kRaw: kLo.toString(10),
    slotDurationS,
    numClips,
  };
}

/**
 * Render a 512x512 RGBA cover artwork with:
 *  - Top 4x64 macro-blocks (32px tall): sync checkerboard corners + CRC16-protected Layer 2 bits
 *  - Body 60x64 macro-blocks (480px tall): vibrant visual mosaic of timeline frames!
 */
export function renderCartridgeCoverRGBA(recipe, frameRgbaList = []) {
  const rgba = new Uint8ClampedArray(COVER_SIZE * COVER_SIZE * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 14; rgba[i + 1] = 17; rgba[i + 2] = 22; rgba[i + 3] = 255;
  }

  const paintBlock = (br, bc, R, G, B) => {
    const y0 = br * CELL_PX;
    const x0 = bc * CELL_PX;
    for (let dy = 0; dy < CELL_PX; dy++) {
      const rowOff = (y0 + dy) * COVER_SIZE;
      for (let dx = 0; dx < CELL_PX; dx++) {
        const o = (rowOff + x0 + dx) * 4;
        rgba[o] = R; rgba[o + 1] = G; rgba[o + 2] = B; rgba[o + 3] = 255;
      }
    }
  };

  // Sync checkerboards in top-left and top-right corners (2x2 blocks)
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const v = (r + c) % 2 === 0 ? 250 : 8;
      paintBlock(r, c, v, v, v);
      paintBlock(r, GRID_COLS - 2 + c, v, v, v);
    }
  }

  // Pack 28-byte Layer 2 header into 224 high-contrast black/white 8x8 macro-blocks (cols 3..60, rows 0..3)
  const hdrBytes = packLayer2Header(recipe);
  const bits = [];
  for (let i = 0; i < hdrBytes.length; i++) {
    for (let s = 7; s >= 0; s--) bits.push((hdrBytes[i] >> s) & 1);
  }
  let bIdx = 0;
  for (let r = 0; r < HEADER_ROWS; r++) {
    for (let c = 3; c < GRID_COLS - 3; c++) {
      if (bIdx < bits.length) {
        const v = bits[bIdx++] ? 245 : 12;
        paintBlock(r, c, v, v, v);
      } else {
        // Accent emerald delimiter blocks
        paintBlock(r, c, 28, 130, 80);
      }
    }
  }

  // Paint body (rows 32..511) with a crisp 2x2 or 3x3 mosaic of timeline frames
  const bodyTop = HEADER_ROWS * CELL_PX; // 32
  const bodyH = COVER_SIZE - bodyTop;    // 480
  if (frameRgbaList.length > 0) {
    const nTiles = frameRgbaList.length >= 9 ? 9 : (frameRgbaList.length >= 4 ? 4 : 1);
    const gridN = nTiles === 9 ? 3 : (nTiles === 4 ? 2 : 1);
    const tileW = Math.floor(COVER_SIZE / gridN);
    const tileH = Math.floor(bodyH / gridN);

    for (let t = 0; t < nTiles; t++) {
      const fIdx = Math.min(
        frameRgbaList.length - 1,
        Math.floor((t / Math.max(1, nTiles)) * frameRgbaList.length)
      );
      const src = frameRgbaList[fIdx];
      const tr = Math.floor(t / gridN);
      const tc = t % gridN;
      const dx0 = tc * tileW;
      const dy0 = bodyTop + tr * tileH;

      for (let y = 0; y < tileH; y++) {
        const sy = Math.min(src.height - 1, Math.floor((y / tileH) * src.height));
        const dstRow = (dy0 + y) * COVER_SIZE;
        for (let x = 0; x < tileW; x++) {
          const sx = Math.min(src.width - 1, Math.floor((x / tileW) * src.width));
          const so = (sy * src.width + sx) * 4;
          const doff = (dstRow + dx0 + x) * 4;
          // Crisp 1px border between mosaic tiles
          if (x === 0 || y === 0) {
            rgba[doff] = 36; rgba[doff + 1] = 48; rgba[doff + 2] = 60;
          } else {
            rgba[doff] = src.rgba[so];
            rgba[doff + 1] = src.rgba[so + 1];
            rgba[doff + 2] = src.rgba[so + 2];
          }
          rgba[doff + 3] = 255;
        }
      }
    }
  }
  return { rgba, width: COVER_SIZE, height: COVER_SIZE };
}

/**
 * Decode Layer 2 8x8 macro-block header from any cover RGBA (survives resize & JPEG compression!).
 */
export function decodeLayer2FromCoverRGBA(rgba, width, height) {
  const cellW = width / GRID_COLS;
  const cellH = height / GRID_ROWS;
  const sampleBlockLuma = (br, bc) => {
    // Average inner 50% of block to ignore JPEG block-edge ringing
    const x0 = Math.floor((bc + 0.25) * cellW);
    const x1 = Math.max(x0 + 1, Math.floor((bc + 0.75) * cellW));
    const y0 = Math.floor((br + 0.25) * cellH);
    const y1 = Math.max(y0 + 1, Math.floor((br + 0.75) * cellH));
    let sum = 0, cnt = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        sum += 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  };

  const bits = [];
  for (let r = 0; r < HEADER_ROWS; r++) {
    for (let c = 3; c < GRID_COLS - 3; c++) {
      if (bits.length >= 28 * 8) break;
      bits.push(sampleBlockLuma(r, c) > 128 ? 1 : 0);
    }
  }
  const bytes = new Uint8Array(28);
  for (let i = 0; i < 28; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i * 8 + b];
    bytes[i] = val;
  }
  return unpackLayer2Header(bytes);
}

// ---------------------------------------------------------------------------
// Layer 1: PNG `tEXt` Chunk Injector & Extractor (Zero Deps!)
// ---------------------------------------------------------------------------
const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makePngChunk(typeAscii, dataBytes) {
  const out = new Uint8Array(12 + dataBytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, dataBytes.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = typeAscii.charCodeAt(i);
  out.set(dataBytes, 8);
  const crcVal = crc32(out.subarray(4, 8 + dataBytes.length));
  dv.setUint32(8 + dataBytes.length, crcVal, false);
  return out;
}

export function injectPngTextChunk(pngBytes, key, text) {
  const enc = new TextEncoder();
  const kBytes = enc.encode(key);
  const vBytes = enc.encode(text);
  const payload = new Uint8Array(kBytes.length + 1 + vBytes.length);
  payload.set(kBytes, 0);
  payload[kBytes.length] = 0;
  payload.set(vBytes, kBytes.length + 1);
  const textChunk = makePngChunk("tEXt", payload);

  // Locate IEND chunk and insert tEXt right before it
  const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let pos = 8;
  while (pos + 12 <= pngBytes.length) {
    const len = dv.getUint32(pos, false);
    const type = String.fromCharCode(pngBytes[pos + 4], pngBytes[pos + 5], pngBytes[pos + 6], pngBytes[pos + 7]);
    if (type === "IEND") {
      const out = new Uint8Array(pngBytes.length + textChunk.length);
      out.set(pngBytes.subarray(0, pos), 0);
      out.set(textChunk, pos);
      out.set(pngBytes.subarray(pos), pos + textChunk.length);
      return out;
    }
    pos += 12 + len;
  }
  return pngBytes;
}

export function extractPngTextChunks(pngBytes) {
  const res = {};
  if (!pngBytes || pngBytes.length < 16) return res;
  for (let i = 0; i < 8; i++) if (pngBytes[i] !== PNG_SIG[i]) return res;
  const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  const dec = new TextDecoder("utf-8", { fatal: false });
  let pos = 8;
  while (pos + 12 <= pngBytes.length) {
    const len = dv.getUint32(pos, false);
    const type = String.fromCharCode(pngBytes[pos + 4], pngBytes[pos + 5], pngBytes[pos + 6], pngBytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > pngBytes.length) break;
    if (type === "tEXt") {
      const chunk = pngBytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const k = dec.decode(chunk.subarray(0, nul));
        const v = dec.decode(chunk.subarray(nul + 1));
        res[k] = v;
      }
    }
    if (type === "IEND") break;
    pos = dataEnd + 4;
  }
  return res;
}

// Pure-JS minimal uncompressed PNG encoder (used in Node tests or headless environments)
export function encodeUncompressedPng(rgba, width, height) {
  // Build raw filtered scanlines (filter byte 0 + RGB per row)
  const stride = 1 + width * 3;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const dst = y * stride;
    raw[dst] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const so = (y * width + x) * 4;
      raw[dst + 1 + x * 3] = rgba[so];
      raw[dst + 2 + x * 3] = rgba[so + 1];
      raw[dst + 3 + x * 3] = rgba[so + 2];
    }
  }
  // Wrap in valid zlib stored blocks (no external zlib needed!)
  const maxBlk = 65535;
  const nBlks = Math.ceil(raw.length / maxBlk);
  const zOut = new Uint8Array(2 + raw.length + nBlks * 5 + 4);
  zOut[0] = 0x78; zOut[1] = 0x01;
  let zPos = 2;
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  for (let blk = 0; blk < nBlks; blk++) {
    const start = blk * maxBlk;
    const len = Math.min(maxBlk, raw.length - start);
    const isLast = blk === nBlks - 1 ? 1 : 0;
    zOut[zPos++] = isLast;
    zOut[zPos++] = len & 0xFF;
    zOut[zPos++] = (len >> 8) & 0xFF;
    const nlen = (~len) & 0xFFFF;
    zOut[zPos++] = nlen & 0xFF;
    zOut[zPos++] = (nlen >> 8) & 0xFF;
    zOut.set(raw.subarray(start, start + len), zPos);
    zPos += len;
  }
  const adler = ((b << 16) | a) >>> 0;
  new DataView(zOut.buffer).setUint32(zPos, adler, false);

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, width, false);
  idv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const cIHDR = makePngChunk("IHDR", ihdr);
  const cIDAT = makePngChunk("IDAT", zOut);
  const cIEND = makePngChunk("IEND", new Uint8Array(0));

  const png = new Uint8Array(8 + cIHDR.length + cIDAT.length + cIEND.length);
  png.set(PNG_SIG, 0);
  png.set(cIHDR, 8);
  png.set(cIDAT, 8 + cIHDR.length);
  png.set(cIEND, 8 + cIHDR.length + cIDAT.length);
  return png;
}

// ---------------------------------------------------------------------------
// Pure-JS ID3v2.3 Writer & ID3v2.3/2.4 Reader (APIC + CHAP/CTOC + TIT2/TALB)
// ---------------------------------------------------------------------------
function encodeSyncsafe(val) {
  return new Uint8Array([(val >> 21) & 0x7F, (val >> 14) & 0x7F, (val >> 7) & 0x7F, val & 0x7F]);
}
function decodeSyncsafe(b, off = 0) {
  return (b[off] << 21) | (b[off + 1] << 14) | (b[off + 2] << 7) | b[off + 3];
}
function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7F;
  return out;
}
function concatU8(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function makeId3FrameV23(id, payload) {
  const hdr = new Uint8Array(10);
  hdr.set(asciiBytes(id), 0);
  new DataView(hdr.buffer).setUint32(4, payload.length, false);
  return concatU8([hdr, payload]);
}

function makeTextFrameV23(id, text) {
  return makeId3FrameV23(id, concatU8([new Uint8Array([0]), asciiBytes(text)]));
}

function makeApicFrameV23(pngBytes, desc = "SpectralCartridge") {
  const payload = concatU8([
    new Uint8Array([0]),
    asciiBytes("image/png"),
    new Uint8Array([0, 3]), // picture type 3 = Front Cover
    asciiBytes(desc),
    new Uint8Array([0]),
    pngBytes,
  ]);
  return makeId3FrameV23("APIC", payload);
}

export function attachId3v2ToMp3(mp3Bytes, { coverPngBytes, title = "Spectral Cartridge", album = "Spectral Timeline", chapters = [] } = {}) {
  // Strip existing ID3v2 tag if present
  let audioOff = 0;
  if (mp3Bytes.length >= 10 && mp3Bytes[0] === 0x49 && mp3Bytes[1] === 0x44 && mp3Bytes[2] === 0x33) {
    audioOff = 10 + decodeSyncsafe(mp3Bytes, 6);
  }
  const audio = mp3Bytes.subarray(audioOff);
  const frames = [
    makeTextFrameV23("TIT2", title),
    makeTextFrameV23("TALB", album),
  ];
  if (coverPngBytes) frames.push(makeApicFrameV23(coverPngBytes));

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const cid = asciiBytes(`chp${String(i).padStart(3, "0")}`);
    const times = new Uint8Array(16);
    const tdv = new DataView(times.buffer);
    tdv.setUint32(0, ch.startMs >>> 0, false);
    tdv.setUint32(4, ch.endMs >>> 0, false);
    tdv.setUint32(8, 0xFFFFFFFF, false);
    tdv.setUint32(12, 0xFFFFFFFF, false);
    const sub = makeTextFrameV23("TIT2", ch.title || `Frame ${i + 1}`);
    frames.push(makeId3FrameV23("CHAP", concatU8([cid, new Uint8Array([0]), times, sub])));
  }

  const body = concatU8(frames);
  const header = concatU8([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0]), encodeSyncsafe(body.length)]);
  return concatU8([header, body, audio]);
}

export function parseApicFromMp3(mp3Bytes) {
  if (!mp3Bytes || mp3Bytes.length < 10) return null;
  if (mp3Bytes[0] !== 0x49 || mp3Bytes[1] !== 0x44 || mp3Bytes[2] !== 0x33) return null;
  const verMajor = mp3Bytes[3];
  const tagSize = decodeSyncsafe(mp3Bytes, 6);
  const tagEnd = Math.min(mp3Bytes.length, 10 + tagSize);
  const dv = new DataView(mp3Bytes.buffer, mp3Bytes.byteOffset, mp3Bytes.byteLength);

  let pos = 10;
  let apic = null;
  let title = "";
  while (pos + 10 <= tagEnd) {
    if (mp3Bytes[pos] === 0 && mp3Bytes[pos + 1] === 0) break;
    const fid = String.fromCharCode(mp3Bytes[pos], mp3Bytes[pos + 1], mp3Bytes[pos + 2], mp3Bytes[pos + 3]);
    const fsize = verMajor === 4 ? decodeSyncsafe(mp3Bytes, pos + 4) : dv.getUint32(pos + 4, false);
    pos += 10;
    if (fsize <= 0 || pos + fsize > tagEnd) break;
    const body = mp3Bytes.subarray(pos, pos + fsize);
    if (fid === "TIT2" && body.length > 1) {
      title = new TextDecoder("latin1").decode(body.subarray(1)).replace(/\0/g, "");
    } else if (fid === "APIC" && body.length > 6 && !apic) {
      const enc = body[0];
      const mimeEnd = body.indexOf(0, 1);
      if (mimeEnd > 1 && mimeEnd + 2 < body.length) {
        const mime = new TextDecoder("latin1").decode(body.subarray(1, mimeEnd));
        const descStart = mimeEnd + 2;
        let imgStart = descStart;
        if (enc === 1 || enc === 2) {
          for (let k = descStart; k + 1 < body.length; k += 2) {
            if (body[k] === 0 && body[k + 1] === 0) { imgStart = k + 2; break; }
          }
        } else {
          const nul = body.indexOf(0, descStart);
          imgStart = nul !== -1 ? nul + 1 : descStart;
        }
        apic = { mime, bytes: body.slice(imgStart) };
      }
    }
    pos += fsize;
  }
  return apic ? { ...apic, title } : null;
}

/**
 * Encode mono float audio [-1..1] to real MPEG-1 Layer III MP3 bytes using vendored lamejs.
 */
export function encodeAudioToMp3(samplesFloat, sr, bitrateKbps = 96, lameGlobal = null) {
  const lame = lameGlobal || (typeof globalThis !== "undefined" ? globalThis.lamejs : null);
  if (!lame || !lame.Mp3Encoder) {
    throw new Error("lamejs encoder not loaded.");
  }
  const validSr = sr > 48000 ? 48000 : sr;
  const encoder = new lame.Mp3Encoder(1, validSr, Number(bitrateKbps) || 96);
  const pcm = new Int16Array(samplesFloat.length);
  for (let i = 0; i < samplesFloat.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samplesFloat[i] * 32767)));
  }
  const chunks = [];
  const blockSize = 1152;
  for (let i = 0; i < pcm.length; i += blockSize) {
    const mp3buf = encoder.encodeBuffer(pcm.subarray(i, i + blockSize));
    if (mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));
  return concatU8(chunks);
}
