// The crew: five pixel identities, one per product, drawn in the language of zkSNARKs'
// shielded identities. They are not decoration: each one stands for what its page does, and
// the Notary's pose is always the real state of the check on screen.

import { h } from './cert';
import * as zpd from './zpd';

const art = (f: string) => `${import.meta.env.BASE_URL}art/${f}`;

export type CrewKey = 'notary' | 'courier' | 'ledger' | 'burner' | 'node';

export const CREW: Record<CrewKey, { name: string; job: string; href: string; cta: string; line: string }> = {
  notary: { name: 'The Notary', job: 'Prove', href: '#/make', cta: 'Make a chit', line: 'Turns one output of your transaction into a certificate. Your viewing key never leaves the tab.' },
  courier: { name: 'The Courier', job: 'Pay & prove', href: '#/request', cta: 'Send a request', line: 'Carries a ZIP 321 request to your customer and checks the chit that comes back: recipient, amount, reference.' },
  ledger: { name: 'The Ledger Keeper', job: 'Publish payouts', href: '#/ledger', cta: 'Build a ledger', line: 'Keeps one public page of payouts and the total, every line checked against the chain, the wallet unopened.' },
  burner: { name: 'The Burner', job: 'Burn Book', href: '#/burn', cta: 'Open the book', line: 'Burns ZEC into an address nobody can spend from, so anyone can say anything and nobody knows who.' },
  node: { name: 'The Node Operator', job: 'Self-host', href: '#/dev', cta: 'Developer kit', line: 'Runs chit serve beside your own Zebra node, so no explorer ever sees what you check.' },
};

/** A crew member on a little CRT screen. */
export function crewTile(key: CrewKey, cls = 'crt-tile') {
  return h('span', { class: `${cls} c-${key}` }, h('img', { src: art(`char-${key}.png`), alt: CREW[key].name, width: '160', height: '160', loading: 'lazy', decoding: 'async' }));
}

/** Small portrait for page eyebrows. */
export const crewBadge = (key: CrewKey) => crewTile(key, 'crew-badge');

export type NotaryState = 'scan' | 'verified' | 'void' | 'sealed';

const HUD: Record<NotaryState, string> = { scan: 'SCANNING', verified: 'VERIFIED', void: 'VOID', sealed: 'SEALED' };

/** The Notary on a monitor, posed by the real state of a check. */
export function notaryScreen(state: NotaryState, note?: string) {
  return h(
    'figure',
    { class: `notary-screen s-${state}`, role: 'img', 'aria-label': `Notary: ${HUD[state].toLowerCase()}${note ? `, ${note}` : ''}` },
    h('span', { class: 'ns-corner tl' }),
    h('span', { class: 'ns-corner tr' }),
    h('span', { class: 'ns-corner bl' }),
    h('span', { class: 'ns-corner br' }),
    h('img', { src: art(`pose-${state}.png`), alt: '', width: '240', height: '240', decoding: 'async' }),
    h('figcaption', {}, h('span', {}, 'SIGNALS'), h('span', {}, `[ ${HUD[state]} ]`)),
    note ? h('p', { class: 'ns-note' }, note) : null,
  );
}

/** Boot sequence, once per tab. Its last line is the real time the Zcash crates took to load. */
export function boot() {
  let seen = false;
  try {
    seen = sessionStorage.getItem('chit.booted') === '1';
    sessionStorage.setItem('chit.booted', '1');
  } catch {
    /* no storage: boot every time */
  }
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const log = h('pre', { class: 'boot-log' });
  const screen = h('div', { class: 'boot', role: 'status', onclick: () => done() }, h('div', { class: 'boot-inner' }, h('img', { class: 'boot-mark', src: '/mark.svg', alt: '', width: '60', height: '64' }), log, h('span', { class: 'boot-skip' }, 'click to skip')));
  document.body.append(screen);
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    screen.classList.add('off');
    setTimeout(() => screen.remove(), 450);
  };
  const say = (line: string) => (log.textContent += `${line}\n`);
  const t0 = performance.now();
  const lines = ['> WAKING NODE…', '> NO ACCOUNT. NO SERVER. NO COOKIES.', '> LOADING ORCHARD + ZCASH_NOTE_ENCRYPTION (WASM)…'];
  lines.forEach((l, i) => setTimeout(() => !closed && say(l), 140 + i * 260));
  zpd.load().then(() => {
    const ms = Math.round(performance.now() - t0);
    setTimeout(() => {
      if (closed) return;
      say(`> CRATES READY IN ${ms} MS`);
      say('> SIGNALS [ OK ]');
      setTimeout(done, 520);
    }, Math.max(0, 140 + lines.length * 260 - ms));
  }, done);
  setTimeout(done, 4000);
}
