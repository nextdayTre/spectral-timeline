// Deterministic Uniform Pixel-Box Bitmap Font & Pure-JS BigInt secp256k1 Generator
// Zero external dependencies. Runs identically in browsers (GitHub Pages) and Node.

export const SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
export const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
export const SECP256K1_GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
export const SECP256K1_GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m) {
  let res = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}

function modInv(a, m) {
  // Extended Euclidean algorithm (fast & exact for 256-bit primes)
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error("Non-invertible element mod p");
  return t < 0n ? t + m : t;
}

function ecAdd(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  let lam;
  if (x1 === x2) {
    if (mod(y1 + y2, SECP256K1_P) === 0n) return null;
    lam = mod(3n * x1 * x1 * modInv(2n * y1, SECP256K1_P), SECP256K1_P);
  } else {
    lam = mod((y2 - y1) * modInv(x2 - x1, SECP256K1_P), SECP256K1_P);
  }
  const x3 = mod(lam * lam - x1 - x2, SECP256K1_P);
  const y3 = mod(lam * (x1 - x3) - y1, SECP256K1_P);
  return [x3, y3];
}

export function secp256k1ScalarMul(kBig) {
  let k = mod(BigInt(kBig), SECP256K1_N);
  if (k <= 0n) throw new Error("Scalar K must be in [1, N-1]");
  let res = null;
  let addend = [SECP256K1_GX, SECP256K1_GY];
  while (k > 0n) {
    if (k & 1n) res = ecAdd(res, addend);
    addend = ecAdd(addend, addend);
    k >>= 1n;
  }
  return res;
}

export function parseScalarK(raw) {
  const s = String(raw ?? "").trim().replace(/[_\s]/g, "");
  if (!s) return 1n;
  let val;
  if (s.toLowerCase().startsWith("0x")) {
    val = BigInt(s);
  } else if (/[a-fA-F]/.test(s) || s.length >= 16) {
    val = BigInt("0x" + s);
  } else {
    val = BigInt(s);
  }
  val = mod(val, SECP256K1_N);
  if (val <= 0n) throw new Error("Scalar K must be non-zero modulo secp256k1 N.");
  return val;
}

export function secp256k1PairHex(kBig) {
  const k = mod(BigInt(kBig), SECP256K1_N);
  const [x, y] = secp256k1ScalarMul(k);
  const prefix = (y & 1n) === 0n ? "02" : "03";
  const kHex = k.toString(16).padStart(64, "0");
  const kgHex = prefix + x.toString(16).padStart(64, "0");
  return { kHex, kgHex, prefix, x, y };
}

// Crisp 5x7 Monospace Pixel Bitmap Font (Zero OS font drift!)
const FONT_5X7 = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "a": ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  "b": ["10000", "10000", "11110", "10001", "10001", "10001", "11110"],
  "c": ["00000", "00000", "01110", "10000", "10000", "10001", "01110"],
  "d": ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  "e": ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  "f": ["00110", "01001", "01000", "11100", "01000", "01000", "01000"],
  "g": ["00000", "01111", "10001", "10001", "01111", "00001", "01110"],
  "h": ["10000", "10000", "11110", "10001", "10001", "10001", "10001"],
  "i": ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  "j": ["00010", "00000", "00110", "00010", "00010", "10010", "01100"],
  "k": ["10000", "10000", "10010", "10100", "11000", "10100", "10010"],
  "l": ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  "m": ["00000", "00000", "11010", "10101", "10101", "10101", "10001"],
  "n": ["00000", "00000", "11110", "10001", "10001", "10001", "10001"],
  "o": ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  "p": ["00000", "11110", "10001", "10001", "11110", "10000", "10000"],
  "q": ["00000", "01111", "10001", "10001", "01111", "00001", "00001"],
  "r": ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  "s": ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  "t": ["01000", "01000", "11110", "01000", "01000", "01001", "00110"],
  "u": ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  "v": ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  "w": ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
  "x": ["00000", "00000", "10001", "01010", "00100", "01010", "10001"],
  "y": ["00000", "10001", "10001", "01111", "00001", "00010", "01100"],
  "z": ["00000", "00000", "11111", "00010", "00100", "01000", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "00000", "00100", "01000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "*": ["00000", "10101", "01110", "11111", "01110", "10101", "00000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
};

function glyphRows(ch) {
  return FONT_5X7[ch] || FONT_5X7[ch.toUpperCase()] || FONT_5X7[" "];
}

/**
 * Render text/hex into an exact uniform pixel-box RGBA Uint8ClampedArray (green on pure black).
 */
export function renderUniformPixelBoxRGBA({
  text = "0000000000000000",
  cols = null,
  width = 640,
  height = 360,
  bandMode = "full",
  uppercaseHex = true,
} = {}) {
  let raw = String(text ?? "").replace(/^\r?\n|\r?\n$/g, "");
  if (!raw) raw = "0000000000000000";
  if (uppercaseHex) raw = raw.toUpperCase();

  let lines;
  let nCols;
  if (raw.includes("\n")) {
    const split = raw.split(/\r?\n/).filter((ln) => ln.trim().length > 0);
    nCols = cols ? Math.max(1, Number(cols)) : Math.max(...split.map((l) => l.length));
    lines = split.map((l) => l.slice(0, nCols).padEnd(nCols, " "));
  } else {
    nCols = cols ? Math.max(1, Number(cols)) : Math.min(22, Math.max(8, raw.length));
    lines = [];
    for (let i = 0; i < raw.length; i += nCols) {
      lines.push(raw.slice(i, i + nCols).padEnd(nCols, " "));
    }
  }
  const nRows = Math.max(1, lines.length);

  const padX = Math.max(16, Math.floor(width / 24));
  const availW = Math.max(nCols * 7, width - 2 * padX);
  const cellW = Math.max(7, Math.floor(availW / nCols));
  const usedW = cellW * nCols;
  const x0 = Math.floor((width - usedW) / 2);

  const bandTop = bandMode === "rx11_lower" ? Math.round(height * 0.50) : Math.max(16, Math.floor(height / 14));
  const bandBot = bandMode === "rx11_lower" ? Math.round(height * 0.94) : height - bandTop;

  const availH = Math.max(nRows * 10, bandBot - bandTop);
  const cellH = Math.max(10, Math.floor(availH / nRows));
  const usedH = cellH * nRows;
  const y0 = bandTop + Math.floor((availH - usedH) / 2);

  const guardX = Math.max(1, Math.floor(cellW / 6));
  const guardY = Math.max(1, Math.floor(cellH / 6));
  const innerW = Math.max(5, cellW - 2 * guardX);
  const innerH = Math.max(7, cellH - 2 * guardY);

  const rgba = new Uint8ClampedArray(width * height * 4);
  // Set alpha=255 everywhere (RGB=0 -> silent black)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  const yMap = new Int32Array(innerH);
  const xMap = new Int32Array(innerW);
  for (let iy = 0; iy < innerH; iy++) yMap[iy] = Math.min(6, Math.floor((iy * 7) / innerH));
  for (let ix = 0; ix < innerW; ix++) xMap[ix] = Math.min(4, Math.floor((ix * 5) / innerW));

  for (let r = 0; r < nRows; r++) {
    const cy = y0 + r * cellH;
    const gy0 = cy + Math.floor((cellH - innerH) / 2);
    const line = lines[r];
    for (let c = 0; c < nCols; c++) {
      const cx = x0 + c * cellW;
      const gx0 = cx + Math.floor((cellW - innerW) / 2);
      const g = glyphRows(line[c]);
      for (let iy = 0; iy < innerH; iy++) {
        const gRow = g[yMap[iy]];
        const py = gy0 + iy;
        if (py < 0 || py >= height) continue;
        const rowOff = py * width;
        for (let ix = 0; ix < innerW; ix++) {
          if (gRow[xMap[ix]] === "1") {
            const px = gx0 + ix;
            if (px < 0 || px >= width) continue;
            const o = (rowOff + px) * 4;
            rgba[o] = 115;
            rgba[o + 1] = 255;
            rgba[o + 2] = 105;
          }
        }
      }
    }
  }

  return { rgba, width, height, rows: nRows, cols: nCols, cellW, cellH, lines };
}

export function buildSecp256k1BreathingCards({
  kRaw = "1",
  count = 1,
  alignMode = "66_header",
  bandMode = "full",
  width = 640,
  height = 360,
} = {}) {
  const kStart = parseScalarK(kRaw);
  const nPairs = Math.max(1, Math.min(16, Number(count) || 1));
  const cards = [];

  for (let step = 0; step < nPairs; step++) {
    let k = mod(kStart + BigInt(step), SECP256K1_N);
    if (k === 0n) k = 1n;
    const { kHex, kgHex, prefix } = secp256k1PairHex(k);
    const kShort = k < 0x1000000n ? k.toString(16) : `${kHex.slice(0, 8)}..${kHex.slice(-4)}`;

    const is64 = alignMode === "64_payload";
    const cols = is64 ? 16 : 22;
    const strK = is64 ? kHex : "00" + kHex;
    const strKG = is64 ? kgHex.slice(2) : kgHex;
    const labelK = is64 ? `K_${kShort}.png` : `K_${kShort}_66.png`;
    const labelKG = is64 ? `KG_${prefix}_${kShort}.png` : `KG_${prefix}_${kShort}_66.png`;

    const gridK = renderUniformPixelBoxRGBA({ text: strK, cols, width, height, bandMode });
    const gridKG = renderUniformPixelBoxRGBA({ text: strKG, cols, width, height, bandMode });

    cards.push({ filename: labelK, polarity: "pos", hexPayload: strK, kHex, kgHex, grid: gridK });
    cards.push({ filename: labelKG, polarity: "neg", hexPayload: strKG, kHex, kgHex, grid: gridKG });
  }
  return { kStartHex: kStart.toString(16).padStart(64, "0"), cards };
}

/**
 * Generate a crisp geometric benchmark image (shapes & diagonal bars) as RGBA.
 */
export function renderGeometricTestRGBA(width = 640, height = 360) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  const setPx = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const o = (y * width + x) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
  };

  // Concentric diamond + harmonic bars + circle
  const cx = Math.floor(width * 0.28), cy = Math.floor(height * 0.5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (Math.abs(dist - 95) < 4 || Math.abs(dist - 55) < 3) {
        setPx(x, y, 120, 255, 110);
      }
      const manh = Math.abs(x - Math.floor(width * 0.72)) + Math.abs(y - cy);
      if (Math.abs(manh - 100) < 4 || Math.abs(manh - 52) < 3) {
        setPx(x, y, 120, 255, 110);
      }
    }
  }
  // Horizontal resonance guide bars
  for (let bar = 0; bar < 5; bar++) {
    const y = Math.floor(height * (0.2 + bar * 0.15));
    for (let x = Math.floor(width * 0.45); x < Math.floor(width * 0.56); x++) {
      for (let dy = -2; dy <= 2; dy++) setPx(x, y + dy, 120, 255, 110);
    }
  }
  return { rgba, width, height };
}
