// The certificate: one disclosed output, drawn like a security document. Its guilloche
// engraving and pixel sigil are generated from the txid and output index, so every chit
// looks different and the same chit always looks the same.

import type { Memo, Verified } from './zpd';

export type Seal =
  | { kind: 'valid'; source: 'chain' | 'mempool' | 'pasted' | 'specimen' }
  | { kind: 'paid' }
  | { kind: 'short' }
  | { kind: 'wrong' }
  | { kind: 'memo' }
  | { kind: 'void' }
  | { kind: 'preview' };

export interface CertMeta {
  height?: number | null;
  time?: string | null;
  confirmations?: number | null;
  chit?: string;
  specimen?: boolean;
}

type Kid = Node | string | null | false | undefined;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null && kid !== false && kid !== undefined) el.append(kid);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

/** A small deterministic PRNG seeded from a hex string. */
function rng(seed: string) {
  let a = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 0x85ebca6b) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Layered hypotrochoids and wave bands, like banknote engraving. */
export function guilloche(seed: string, w = 560, hgt = 640): SVGSVGElement {
  const r = rng(seed);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'guilloche');
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string, cls: string, width: number) => {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    p.setAttribute('stroke-width', String(width));
    svg.append(p);
  };
  const rosette = (cx: number, cy: number, scale: number, cls: string) => {
    const R = 80 + Math.floor(r() * 40);
    const rr = 17 + Math.floor(r() * 22);
    const d = 30 + r() * 40;
    const turns = (Math.PI * 2 * rr) / gcd(R, rr);
    let p = '';
    for (let t = 0; t <= turns + 0.01; t += 0.018) {
      const x = (R - rr) * Math.cos(t) + d * Math.cos(((R - rr) / rr) * t);
      const y = (R - rr) * Math.sin(t) - d * Math.sin(((R - rr) / rr) * t);
      p += `${p ? 'L' : 'M'}${(cx + x * scale).toFixed(1)},${(cy + y * scale).toFixed(1)}`;
    }
    path(p, cls, 0.45);
  };
  rosette(w * 0.74, hgt * 0.36, 1.5, 'g1');
  rosette(w * 0.74, hgt * 0.36, 1.25, 'g2');
  rosette(w * 0.2, hgt * 0.86, 1.05, 'g1');
  const phase = r() * 6;
  for (let i = 0; i < 16; i++) {
    let p = '';
    for (let x = 0; x <= w; x += 4) {
      const y = hgt * 0.53 + i * 6 + Math.sin(x / (18 + r() * 0.4) + i * 0.55 + phase) * 6;
      p += `${x ? 'L' : 'M'}${x},${y.toFixed(1)}`;
    }
    path(p, 'g3', 0.35);
  }
  return svg;
}

/** A mirrored pixel identity, in the spirit of the zkSNARKs 26×26 portraits. */
export function sigil(seed: string, size = 13): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c.className = 'sigil';
  const ctx = c.getContext('2d')!;
  const r = rng(seed + ':sigil');
  const half = Math.ceil(size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < half; x++) {
      const v = r();
      if (v < 0.42) {
        ctx.fillStyle = v < 0.08 ? '#1aa865' : '#17201b';
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(size - 1 - x, y, 1, 1);
      }
    }
  }
  c.setAttribute('aria-hidden', 'true');
  return c;
}

export function zec(zat: number, cls = 'amount'): HTMLElement {
  const whole = Math.floor(zat / 1e8).toLocaleString('en-US');
  const frac = String(zat % 1e8).padStart(8, '0');
  const sig = frac.replace(/0+$/, '');
  return h('span', { class: cls }, whole, h('span', { class: 'frac' }, '.' + (sig.length < 2 ? frac.slice(0, 2) : sig)), h('span', { class: 'unit' }, 'ZEC'));
}

export function short(s: string, head = 10, tail = 8) {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

export function memoNode(m: Memo): Node {
  if (m.kind === 'empty') return h('span', { class: 'muted' }, 'No memo');
  if (m.kind === 'text') return h('span', { class: 'memo' }, m.value);
  return h('span', { class: 'muted' }, `binary · ${short(m.value, 16, 8)}`);
}

export async function copy(text: string, btn: HTMLElement) {
  await navigator.clipboard.writeText(text);
  const was = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = was), 1400);
}

function sealNode(seal: Seal): HTMLElement | null {
  const s = (cls: string, top: string, big: string, bottom: string) =>
    h('div', { class: `seal ${cls}`, role: 'img', 'aria-label': `${big} ${top} ${bottom}`.trim() }, h('span', {}, top), h('b', {}, big), h('span', {}, bottom));
  switch (seal.kind) {
    case 'valid':
      return seal.source === 'chain'
        ? s('ok', 'On chain', 'Valid', '· mainnet ·')
        : seal.source === 'mempool'
          ? s('warn', 'Not mined', 'Valid', 'yet · recheck')
        : seal.source === 'specimen'
          ? s('spec', 'Specimen', 'Valid', 'not on chain')
          : s('ok', 'Pasted tx', 'Valid', 'check it’s mined');
    case 'paid':
      return s('ok', 'Invoice', 'Paid', 'in full');
    case 'short':
      return s('warn', 'Invoice', 'Short', 'underpaid');
    case 'wrong':
      return s('bad', 'Invoice', 'Wrong', 'recipient');
    case 'memo':
      return s('warn', 'Invoice', 'Memo', 'mismatch');
    case 'void':
      return s('bad', 'Does not', 'Void', 'check out');
    case 'preview':
      return null;
  }
}

/** Serial number shown on the certificate: derived, not secret. */
function serial(v: Verified) {
  return `No. ${String(v.action).padStart(4, '0')}-${v.txid.slice(0, 4).toUpperCase()}`;
}

export function certificate(v: Verified, seal: Seal, meta: CertMeta = {}): HTMLElement {
  const seed = `${v.txid}:${v.action}`;
  const who = v.direction === 'outgoing' ? 'Paid to' : 'Received at';
  // Which keys open the note, not who made the chit: the payer knows esk as well.
  const made = v.direction === 'outgoing' ? 'Outgoing cipher key (ock)' : 'Note keys (pk_d ‖ esk)';
  const copyBtn = h('button', { class: 'tiny', type: 'button', onclick: (e: Event) => copy(v.recipient, e.currentTarget as HTMLElement) }, 'Copy');
  const mined = meta.height
    ? `block ${meta.height.toLocaleString('en-US')}${meta.confirmations ? ` · ${meta.confirmations.toLocaleString('en-US')} conf.` : ''}`
    : meta.specimen || (seal.kind === 'valid' && seal.source === 'specimen')
      ? 'specimen · never mined'
      : 'not checked against a node';
  return h(
    'article',
    { class: `cert ${meta.specimen || (seal.kind === 'valid' && seal.source === 'specimen') ? 'is-specimen' : ''} ${seal.kind === 'void' ? 'is-void' : ''}` },
    h(
      'div',
      { class: 'doc' },
      guilloche(seed),
      h('div', { class: 'doc-head' }, h('span', {}, 'Shielded payment certificate'), h('span', {}, serial(v))),
      h('div', { class: 'doc-amount' }, zec(v.value_zat)),
      h('div', { class: 'doc-sub' }, `${v.pool === 'ironwood' ? 'Ironwood' : 'Orchard'} pool · ${v.network === 'main' ? 'mainnet' : 'testnet'} · ${mined}`),
      h(
        'dl',
        { class: 'doc-fields' },
        h('dt', {}, who),
        h('dd', {}, h('span', { title: v.recipient }, short(v.recipient, 14, 10)), copyBtn),
        h('dt', {}, 'Memo'),
        h('dd', {}, memoNode(v.memo)),
        h('dt', {}, 'Transaction'),
        h('dd', {}, short(v.txid, 12, 8), h('span', { class: 'muted' }, ` · output ${v.action}`)),
        meta.time ? h('dt', {}, 'Mined at') : null,
        meta.time ? h('dd', {}, meta.time) : null,
        h('dt', {}, 'Opened with'),
        h('dd', {}, made),
      ),
      h('div', { class: 'micro', 'aria-hidden': 'true' }, 'ONE OUTPUT · NO VIEWING KEY · NO OTHER PAYMENT · '.repeat(12)),
      sigil(seed),
      h('div', { class: 'doc-foot' }, h('span', {}, meta.chit ? short(meta.chit, 22, 6) : ''), h('span', {}, 'Proves what this output holds, not who shows it')),
    ),
    sealNode(seal),
  );
}

/** The live log of checks shown beside a certificate. */
export interface StepView {
  id: string;
  label: string;
  ok: boolean | null;
}

export function checklog(title: string, steps: StepView[], extra: StepView[] = []): HTMLElement {
  const all = [...steps, ...extra];
  const passed = all.filter((s) => s.ok === true).length;
  const counted = all.filter((s) => s.ok !== null).length;
  const list = h('ol', { class: 'checks' });
  all.forEach((s, i) => {
    const li = h('li', { class: s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'skip', style: `--i:${i}` }, h('i', {}, s.ok === true ? '✓' : s.ok === false ? '✕' : '–'), h('span', {}, s.label));
    list.append(li);
  });
  return h('aside', { class: 'log' }, h('div', { class: 'log-head' }, h('span', {}, title), h('span', {}, `${passed}/${counted}`)), list);
}
