/**
 * Minimal QR code encoder (byte mode, error correction level M, versions 1–10), written for CiRoom's
 * phone pairing so no third-party code is needed. Returns the module matrix (true = dark).
 * Verified by decoding the output with OpenCV's QR detector (see project-knowledge-archive §12).
 */

// Level M: [total codewords, EC codewords per block, g1 blocks, g1 data cw, g2 blocks, g2 data cw]
const M_TABLE: number[][] = [
  [], [26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0], [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) with the QR polynomial 0x11D
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gmul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

const bch = (value: number, poly: number, bits: number) => {
  let v = value << bits;
  const top = (n: number) => 31 - Math.clz32(n);
  while (v && top(v) >= top(poly)) v ^= poly << (top(v) - top(poly));
  return (value << bits) | v;
};

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  const dataCap = (v: number) => { const t = M_TABLE[v]; return t[2] * t[3] + t[4] * t[5]; };
  while (version <= 10 && Math.ceil((4 + 8 + bytes.length * 8) / 8) > dataCap(version)) version++;
  if (version > 10) throw new Error("Text too long for the QR encoder");
  const [total, ecLen, g1n, g1d, g2n, g2d] = M_TABLE[version];

  // Bit stream: mode 0100, 8-bit length (versions 1–9: 8 bits; 10: 16 bits), data, terminator, padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const capBits = dataCap(version) * 8;
  put(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataCap(version); pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add Reed-Solomon, interleave.
  const blocks: number[][] = [];
  let pos = 0;
  for (let i = 0; i < g1n + g2n; i++) { const n = i < g1n ? g1d : g2d; blocks.push(data.slice(pos, pos + n)); pos += n; }
  const ecs = blocks.map((b) => rsRemainder(b, ecLen));
  const codewords: number[] = [];
  for (let i = 0; i < Math.max(g1d, g2d); i++) blocks.forEach((b) => { if (i < b.length) codewords.push(b[i]); });
  for (let i = 0; i < ecLen; i++) ecs.forEach((e) => codewords.push(e[i]));
  if (codewords.length !== total) throw new Error("QR codeword mismatch");

  const size = 17 + 4 * version;
  const grid: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { if (r >= 0 && c >= 0 && r < size && c < size) { grid[r][c] = v; fixed[r][c] = true; } };

  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(r0 + r, c0 + c, dark);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[version];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // the always-dark module
  // Reserve format areas (written after the mask is chosen) and version areas.
  for (let i = 0; i < 9; i++) { set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);
  if (version >= 7) {
    const v = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >> i) & 1) === 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  // Place data bits in the zig-zag order.
  const stream: boolean[] = [];
  codewords.forEach((cw) => { for (let i = 7; i >= 0; i--) stream.push(((cw >> i) & 1) === 1); });
  let k = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!fixed[r][c]) { grid[r][c] = k < stream.length ? stream[k] : false; k++; }
      }
    }
    up = !up;
  }

  const build = (mask: number): boolean[][] => {
    const m = grid.map((row, r) => row.map((v, c) => (fixed[r][c] ? !!v : !!v !== MASKS[mask](r, c))));
    const f = bch((0 << 3) | mask, 0x537, 10) ^ 0x5412; // EC level M = 00
    const bit = (i: number) => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = true;
    return m;
  };

  const penalty = (m: boolean[][]) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = pass ? m[b][a] : m[a][b];
          const prev = pass ? m[b - 1][a] : m[a][b - 1];
          if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const rev = [...pat].reverse();
    for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) {
      for (const q of [pat, rev]) {
        if (q.every((v, i) => m[a][b + i] === v)) p += 40;
        if (q.every((v, i) => m[b + i][a] === v)) p += 40;
      }
    }
    const dark = m.flat().filter(Boolean).length;
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };

  let best = build(0);
  let bestScore = penalty(best);
  for (let mask = 1; mask < 8; mask++) {
    const m = build(mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}
