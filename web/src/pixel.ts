// Pixel identities: a 26×26 faceless bust drawn from a seed (a mask's public key, or a
// txid:action). The same seed always gives the same figure; nothing about it is secret.
// Faceless heads with square eyes and a right edge that dissolves into pixels are the
// visual language of zkSNARKs' shielded identities.

const N = 26;

const SKIN = ['#e8e4d8', '#c9b49a', '#9c7a5b', '#6b4e37', '#b8c4bd', '#8d9690', '#d9c7a7', '#4a3a2c'];
const CLOTH = ['#1f5c3d', '#2b2f36', '#3a2a5c', '#5c2a1f', '#1f3f5c', '#4a4a4a', '#5c4a1f', '#123b2a'];
const ACCENT = ['#7cf5a8', '#ff7a2f', '#8b7cff', '#ffd166', '#5ad1ff', '#ff5d8f'];

type Gear = 'hood' | 'beanie' | 'cap' | 'headset' | 'bare' | 'crown';
const GEAR: Gear[] = ['hood', 'beanie', 'cap', 'headset', 'bare', 'hood', 'beanie', 'crown'];

function bytes(seed: string): number[] {
  // FNV-style spread of the seed into 32 bytes; enough variety, fully deterministic.
  const out: number[] = [];
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < seed.length; j++) h = Math.imul(h ^ seed.charCodeAt(j) ^ (i * 131), 0x01000193) >>> 0;
    out.push(h & 0xff);
  }
  return out;
}

export interface Identity {
  grid: (string | null)[][];
  accent: string;
}

export function identity(seed: string): Identity {
  const b = bytes(seed);
  const skin = SKIN[b[0] % SKIN.length];
  const cloth = CLOTH[b[1] % CLOTH.length];
  const accent = ACCENT[b[2] % ACCENT.length];
  const gear = GEAR[b[3] % GEAR.length];
  const headW = 10 + (b[4] % 3) * 2; // 10, 12 or 14 wide
  const headTop = 5 + (b[5] % 2);
  const headH = 11;
  const eyeRow = headTop + 5 + (b[6] % 2);
  const g: (string | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  const set = (x: number, y: number, c: string) => x >= 0 && x < N && y >= 0 && y < N && (g[y][x] = c);
  const left = Math.floor((N - headW) / 2);

  // shoulders and torso
  for (let y = headTop + headH; y < N; y++) {
    const spread = Math.min(9, 3 + (y - headTop - headH) * 2);
    for (let x = left - spread; x < left + headW + spread; x++) set(x, y, cloth);
  }
  // neck
  for (let y = headTop + headH - 1; y < headTop + headH + 1; y++) for (let x = left + 3; x < left + headW - 3; x++) set(x, y, skin);
  // head, slightly rounded
  for (let y = headTop; y < headTop + headH; y++)
    for (let x = left; x < left + headW; x++) {
      const corner = (y === headTop || y === headTop + headH - 1) && (x === left || x === left + headW - 1);
      if (!corner) set(x, y, skin);
    }
  // gear
  if (gear === 'hood') {
    for (let y = headTop - 2; y < headTop + headH + 1; y++) {
      set(left - 2, y, cloth);
      set(left - 1, y, cloth);
      set(left + headW, y, cloth);
      set(left + headW + 1, y, cloth);
    }
    for (let x = left - 1; x < left + headW + 1; x++) {
      set(x, headTop - 2, cloth);
      set(x, headTop - 1, cloth);
      set(x, headTop, cloth);
    }
  } else if (gear === 'beanie') {
    for (let y = headTop - 3; y < headTop + 2; y++) for (let x = left - 1; x < left + headW + 1; x++) if (!(y === headTop - 3 && (x < left + 2 || x > left + headW - 3))) set(x, y, accent);
    for (let x = left - 1; x < left + headW + 1; x += 2) set(x, headTop + 1, cloth);
  } else if (gear === 'cap') {
    for (let y = headTop - 2; y < headTop + 1; y++) for (let x = left; x < left + headW; x++) set(x, y, accent);
    for (let x = left + headW - 2; x < left + headW + 4; x++) set(x, headTop + 1, accent);
  } else if (gear === 'headset') {
    for (let x = left - 1; x < left + headW + 1; x++) set(x, headTop - 1, '#2b2f36');
    for (let y = headTop + 3; y < headTop + 8; y++) {
      set(left - 2, y, '#2b2f36');
      set(left - 1, y, accent);
    }
    for (let y = headTop - 5; y < headTop - 1; y++) set(left + headW - 2, y, '#2b2f36');
    set(left + headW - 2, headTop - 6, accent);
  } else if (gear === 'crown') {
    for (let x = left + 1; x < left + headW - 1; x++) set(x, headTop - 1, '#ffd166');
    for (let x = left + 1; x < left + headW - 1; x += 3) {
      set(x, headTop - 2, '#ffd166');
      set(x, headTop - 3, '#ffd166');
    }
  }
  // eyes: two small square lights, the only feature
  const gap = 2 + (b[7] % 2);
  const mid = left + Math.floor(headW / 2);
  for (const ex of [mid - gap - 2, mid + gap]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) set(ex + dx, eyeRow + dy, '#ffffff');

  // the dissolve: the right side breaks into drifting pixels
  const edge = left + headW - 2 - (b[8] % 3);
  for (let y = 0; y < N; y++)
    for (let x = edge; x < N; x++) {
      if (!g[y][x]) continue;
      const r = bytes(`${seed}:${x}:${y}`)[0];
      const p = (x - edge) / (N - edge);
      if (r / 255 < p * 0.95) {
        const c = g[y][x];
        g[y][x] = null;
        const nx = x + 1 + (r % 4);
        if (r % 3 === 0) set(nx, y - (r % 2), c!); // some drift away instead of vanishing
      }
    }
  return { grid: g, accent };
}

/** Draws an identity on a canvas; CSS scales it with crisp pixels. */
export function portrait(seed: string, cls = 'pix'): HTMLCanvasElement {
  const { grid } = identity(seed);
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  c.className = cls;
  const ctx = c.getContext('2d')!;
  grid.forEach((row, y) =>
    row.forEach((col, x) => {
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  return c;
}
