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

// ---------------------------------------------------------------------------
// Polar SDF Shape Morph Animation (Triangle -> Circle -> Triangle -> Square)
// Designed as a BPM-synced "video-as-audio" & neuromorphic event-camera litmus test.
// ---------------------------------------------------------------------------
function polarRadius(shape, theta) {
  if (shape === "circle") return 0.78;
  if (shape === "triangle") {
    // Regular 3-gon pointing straight up (apex at theta = -PI/2)
    const sector = (2 * Math.PI) / 3;
    let a = (theta + Math.PI / 2) % sector;
    if (a < 0) a += sector;
    const d = a - sector / 2;
    return Math.cos(Math.PI / 3) / Math.max(0.15, Math.cos(d)) * 1.12;
  }
  if (shape === "square") {
    // Axis-aligned regular 4-gon (flat top/bottom/sides)
    const sector = Math.PI / 2;
    let a = (theta + Math.PI / 4) % sector;
    if (a < 0) a += sector;
    const d = a - sector / 2;
    return Math.cos(Math.PI / 4) / Math.max(0.2, Math.cos(d)) * 0.96;
  }
  return 0.78;
}

/**
 * Render one morphed shape frame (smoothstep between shapeA and shapeB at t in [0, 1]).
 * `style`: "outline" (crisp sonar/event contour) | "solid" (filled silhouette for max RMS breath).
 */
export function renderShapeMorphFrameRGBA({
  shapeA = "triangle",
  shapeB = "circle",
  t = 0.0,
  style = "outline",
  width = 480,
  height = 360,
} = {}) {
  const s = Math.max(0, Math.min(1, Number(t) || 0));
  const ease = s * s * (3 - 2 * s); // smoothstep ease-in/out
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  const cx = width * 0.5;
  const cy = height * 0.52;
  const baseR = Math.min(width, height) * 0.40;
  const strokeHalf = style === "outline" ? 0.085 : 0.0;

  for (let y = 0; y < height; y++) {
    const dy = (y - cy) / baseR;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / baseR;
      const dist = Math.hypot(dx, dy);
      const theta = Math.atan2(dy, dx);
      const rTarget = (1 - ease) * polarRadius(shapeA, theta) + ease * polarRadius(shapeB, theta);

      let intensity = 0.0;
      if (style === "solid") {
        // Anti-aliased solid interior
        const edge = rTarget - dist;
        if (edge > 0.03) intensity = 1.0;
        else if (edge > -0.03) intensity = (edge + 0.03) / 0.06;
      } else {
        // Crisp glowing sonar contour + faint harmonic center dot for optical anchor
        const dLine = Math.abs(dist - rTarget);
        if (dLine < strokeHalf) {
          intensity = 1.0;
        } else if (dLine < strokeHalf + 0.045) {
          intensity = 1.0 - (dLine - strokeHalf) / 0.045;
        }
        if (dist < 0.06) intensity = Math.max(intensity, 0.85);
      }

      if (intensity > 0.01) {
        const o = (rowOff + x) * 4;
        rgba[o] = Math.round(intensity * 115);
        rgba[o + 1] = Math.round(intensity * 255);
        rgba[o + 2] = Math.round(intensity * 105);
      }
    }
  }
  return { rgba, width, height };
}

/**
 * Build a BPM-synced "Triangle -> Circle -> Triangle -> Square -> (loop)" morph animation.
 */
export function buildShapeMorphSequence({
  bpm = 120,
  beatsPerFrame = 0.5,
  framesPerLeg = 3,
  style = "outline",
  breathing = true,
  width = 480,
  height = 360,
} = {}) {
  const bpmClamped = Math.max(40, Math.min(240, Number(bpm) || 120));
  const bpf = Math.max(0.25, Math.min(4.0, Number(beatsPerFrame) || 0.5));
  const fpl = Math.max(2, Math.min(8, Math.round(Number(framesPerLeg) || 3)));
  const slotDurationS = Number(((60.0 / bpmClamped) * bpf).toFixed(4));

  const legs = [
    ["triangle", "circle", "Tri→Cir"],
    ["circle", "triangle", "Cir→Tri"],
    ["triangle", "square", "Tri→Sq"],
    ["square", "triangle", "Sq→Tri"],
  ];

  const frames = [];
  let idx = 0;
  for (const [a, b, tag] of legs) {
    for (let step = 0; step < fpl; step++) {
      const t = step / fpl;
      const grid = renderShapeMorphFrameRGBA({ shapeA: a, shapeB: b, t, style, width, height });
      const polarity = breathing ? (idx % 2 === 0 ? "pos" : "neg") : "pos";
      const pct = Math.round(t * 100);
      const name = `${String(idx + 1).padStart(2, "0")}_${tag}_${pct}.png`;
      frames.push({ index: idx, filename: name, shapeA: a, shapeB: b, t, polarity, grid });
      idx++;
    }
  }

  // Pick crisp STFT & boundary fade parameters matched to BPM frame duration
  const fftSize = slotDurationS < 0.35 ? 1024 : (slotDurationS < 1.0 ? 2048 : 4096);
  const slotGapMs = slotDurationS < 0.35 ? 6.0 : (slotDurationS < 0.8 ? 10.0 : 18.0);
  const pps = slotDurationS < 0.35 ? 160 : 120;

  return {
    bpm: bpmClamped,
    beatsPerFrame: bpf,
    slotDurationS,
    fftSize,
    slotGapMs,
    pps,
    frames,
  };
}

// ---------------------------------------------------------------------------
// 100% Original Procedural Showreel: "Plasma Sphere + Golden Aura + Impact Cut"
// Reproduces the exact Event-Cam + Chromatic Blue + Scene-Cut physics with 0 KB assets!
// ---------------------------------------------------------------------------
export function buildPlasmaShowreelSequence({
  bpm = 120,
  beatsPerFrame = 0.25,
  totalFrames = 24,
  breathing = true,
  width = 320,
  height = 180,
} = {}) {
  const bpmClamped = Math.max(60, Math.min(200, Number(bpm) || 120));
  const bpf = Math.max(0.25, Math.min(2.0, Number(beatsPerFrame) || 0.25));
  const nFrames = Math.max(12, Math.min(48, Math.round(Number(totalFrames) || 24)));
  const cutFrame = Math.floor(nFrames * 0.67); // e.g., frame 16 of 24 -> crisp beat-aligned scene cut!
  const slotDurationS = Number(((60.0 / bpmClamped) * bpf).toFixed(4));

  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

    const isCutPhase = f >= cutFrame;
    const u = isCutPhase ? (f - cutFrame) / Math.max(1, nFrames - cutFrame) : f / Math.max(1, cutFrame);

    if (!isCutPhase) {
      // Act 1: Expanding Cyan Plasma Sphere (bottom-left) + Flickering Golden Aura (top-right)
      const scx = width * 0.16;
      const scy = height * 0.88;
      const sphereR = height * (0.48 + 0.56 * u);

      const acx = width * (0.74 - 0.04 * u);
      const acy = height * (0.28 + 0.04 * Math.sin(f * 1.1));
      const auraBaseR = height * (0.14 + 0.03 * Math.sin(f * 2.3));

      for (let y = 0; y < height; y++) {
        const rowOff = y * width;
        const skyShade = 0.10 + 0.14 * (y / height);
        for (let x = 0; x < width; x++) {
          let r = 8, g = Math.round(skyShade * 70), b = Math.round(skyShade * 185);

          // Expanding Cyan Energy Sphere with pulsing concentric shock rings
          const ds = Math.hypot(x - scx, y - scy);
          if (ds < sphereR + 14) {
            const rim = Math.exp(-Math.pow((ds - sphereR) / 5.5, 2));
            const inner = ds < sphereR ? (0.52 + 0.35 * (ds / sphereR)) : 0;
            const ring = ds < sphereR ? 0.16 * Math.pow(0.5 + 0.5 * Math.sin(ds * 0.19 - f * 0.7), 3) : 0;
            const glow = Math.min(1.0, inner + rim * 0.95 + ring);
            r = Math.min(255, Math.round(r + glow * 115));
            g = Math.min(255, Math.round(g + glow * 238));
            b = Math.min(255, Math.round(b + glow * 255));
          }

          // Spiky Flickering Golden Plasma Aura (upper-right -> high Hz + warm Chroma Blue!)
          const ax = x - acx, ay = y - acy;
          const da = Math.hypot(ax, ay);
          if (da < auraBaseR * 2.2) {
            const ang = Math.atan2(ay, ax);
            const spikes =
              1.0 +
              0.32 * Math.sin(ang * 11 + f * 2.1) +
              0.22 * Math.cos(ang * 17 - f * 3.4);
            const rEdge = auraBaseR * spikes;
            if (da < rEdge) {
              const core = da < auraBaseR * 0.32 ? 0.25 : 1.0; // dark core silhouette inside aura!
              const edgeFade = Math.min(1.0, (rEdge - da) / 8.0);
              const inten = edgeFade * core;
              r = Math.min(255, Math.round(r * (1 - inten) + 255 * inten));
              g = Math.min(255, Math.round(g * (1 - inten) + 225 * inten));
              b = Math.min(255, Math.round(b * (1 - inten) + 35 * inten));
            }
          }

          const o = (rowOff + x) * 4;
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
        }
      }
    } else {
      // Act 2 (Hard Scene Cut!): Crimson/Pink Horizon Shockwave + Bracing Silhouette on Rocky Peaks
      const pulse = 0.5 + 0.5 * Math.sin((f - cutFrame) * 1.4);
      for (let y = 0; y < height; y++) {
        const rowOff = y * width;
        const ny = y / height;
        for (let x = 0; x < width; x++) {
          const nx = x / width;
          // Jagged rocky horizon silhouette
          const hillY = 0.62 - 0.16 * Math.pow(Math.sin(nx * 5.2 + 0.4), 2) - 0.08 * Math.cos(nx * 13.0);
          let r = 14, g = 16, b = 32;
          if (ny > hillY) {
            r = 55; g = 115; b = 75;
          } else {
            // Shockwave horizon glow expanding upward
            const wave = Math.exp(-Math.pow((ny - (0.55 - 0.35 * u)) / 0.12, 2));
            r = Math.min(255, Math.round(r + wave * 240));
            g = Math.min(255, Math.round(g + wave * 95));
            b = Math.min(255, Math.round(b + wave * 175));
          }

          // Center-left kinetic pink/white bracing figure pulsing with impact
          const fx = (nx - 0.32) / 0.11;
          const fy = (ny - (0.54 - 0.04 * pulse)) / 0.24;
          const figDist = Math.hypot(fx, fy);
          if (figDist < 1.0) {
            const rim = figDist > 0.72 ? 1.0 : 0.85;
            r = Math.round(255 * rim);
            g = Math.round((130 + 60 * pulse) * rim);
            b = Math.round(175 * rim);
          }

          const o = (rowOff + x) * 4;
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
        }
      }
    }

    const polarity = breathing ? (f % 2 === 0 ? "pos" : "neg") : "pos";
    const tag = isCutPhase ? "Cut_Impact" : "Plasma_Aura";
    frames.push({
      index: f,
      filename: `${String(f + 1).padStart(2, "0")}_${tag}.png`,
      polarity,
      grid: { rgba, width, height },
    });
  }

  return {
    bpm: bpmClamped,
    beatsPerFrame: bpf,
    slotDurationS,
    cutFrame,
    frames,
  };
}

