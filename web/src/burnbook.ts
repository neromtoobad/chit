// Burn Book: say anything, burn ZEC to say it, nobody knows who.
//
// A post is a shielded payment to the Burn Book address, a Unified Address whose spend
// key nobody holds (its ak is a hash-to-curve point; see core/src/burn.rs). The message is
// the encrypted memo. The address's full viewing key is public, so every reader decrypts
// and checks every post in their own browser; the burner stays anonymous.
//
// Memo grammar (UTF-8 text, at most 512 bytes):
//   re:<ref> text      a reply to the post <ref>
//   +<ref> text        a boost: more ZEC behind the post <ref>
//   anything else      a post
// where <ref> is the first 10 hex characters of a txid, a dot, and the output index.

import qrcode from 'qrcode-generator';
import { ChainError, fetchTx } from './chain';
import { certificate, checklog, copy, h, short, sigil, zec } from './cert';
import { parseZec, zecString } from './request';
import * as zpd from './zpd';
import { isSealed, opensAt, seal, unseal } from './seal-codec.mjs';
import * as wasm from '../pkg/chit_wasm.js';

export interface BurnInfo {
  address: string;
  ufvk: string;
  domain: string;
  ak: string;
  nk: string;
  rivk: string;
}

export interface Burn {
  id: string; // txid10.action
  txid: string;
  action: number;
  value: number;
  text: string;
  kind: 'post' | 'reply' | 'boost' | 'sealed';
  target: string | null;
  chit: string;
  height: number | null;
  time: string | null;
  specimen: boolean;
}

export interface Post extends Burn {
  boosted: number; // value of boosts pointing here
  total: number;
  replies: Burn[];
  boosts: Burn[];
}

const load = zpd.load;

export async function burnInfo(): Promise<BurnInfo> {
  await load();
  return JSON.parse(wasm.burn_info('main'));
}

const MEMO_LIMIT = 512;

function parseMemo(text: string): Pick<Burn, 'kind' | 'target' | 'text'> {
  if (isSealed(text)) return { kind: 'sealed', target: null, text };
  const re = text.match(/^re:([0-9a-f]{10}\.\d{1,3})\s?([\s\S]*)$/);
  if (re) return { kind: 'reply', target: re[1], text: re[2] };
  const boost = text.match(/^\+([0-9a-f]{10}\.\d{1,3})\s?([\s\S]*)$/);
  if (boost) return { kind: 'boost', target: boost[1], text: boost[2] };
  return { kind: 'post', target: null, text };
}

/** Decrypts every burn in a raw transaction with the public Burn Book key. */
export async function burnsIn(hex: string, meta: { height: number | null; time: string | null; specimen: boolean }): Promise<Burn[]> {
  await load();
  const r = JSON.parse(wasm.burns(hex, 'main')) as { txid: string; burns: zpd.Found[] };
  return r.burns.map((f) => {
    const raw = f.memo.kind === 'text' ? f.memo.value : '';
    return { id: `${r.txid.slice(0, 10)}.${f.action}`, txid: r.txid, action: f.action, value: f.value_zat, chit: f.disclosure, ...parseMemo(raw), ...meta };
  });
}

// ---------- the index: which transactions hold burns ----------

const CLAIMS = 'chit.burnbook.claims';
const claimed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(CLAIMS) ?? '[]');
  } catch {
    return [];
  }
};
const remember = (txid: string) => {
  try {
    localStorage.setItem(CLAIMS, JSON.stringify([...new Set([txid, ...claimed()])].slice(0, 200)));
  } catch {
    /* storage unavailable: the claim still shows for this visit */
  }
};

async function indexTxids(): Promise<string[]> {
  // The public index: txids anyone has claimed. The server only lists txids; every post
  // is fetched and decrypted here, so it cannot invent or alter one.
  const url = new URL(`${import.meta.env.BASE_URL}burns/index.json`, import.meta.url);
  const list: string[] = await fetch(url, { credentials: 'omit', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : { txids: [] }))
    .then((j) => j.txids ?? [])
    .catch(() => []);
  return [...new Set([...list, ...claimed()])];
}

export interface Wall {
  posts: Post[];
  burned: number; // mainnet only
  count: number;
  biggest: number;
  specimen: boolean;
}

let wallCache: Promise<Wall> | null = null;

export function wall(fresh = false): Promise<Wall> {
  if (fresh) wallCache = null;
  return (wallCache ??= buildWall());
}

async function buildWall(): Promise<Wall> {
  const live: Burn[] = [];
  const txids = await indexTxids();
  await Promise.all(
    txids.map(async (txid) => {
      try {
        const tx = await fetchTx('main', txid);
        if (!tx.height) return; // only mined burns count
        live.push(...(await burnsIn(tx.hex, { height: tx.height, time: tx.time, specimen: false })));
      } catch {
        /* unfetchable or not a burn: skip */
      }
    }),
  );
  const all = [...live];
  let specimen = false;
  if (!live.length) {
    // Nothing on mainnet yet: show the clearly labelled specimen so the wall is legible.
    const spec = await fetch(new URL(`${import.meta.env.BASE_URL}specimen/burns.json`, import.meta.url), { credentials: 'omit' }).then((r) => r.json());
    for (const t of spec.txs) all.push(...(await burnsIn(t.tx, { height: null, time: null, specimen: true })));
    specimen = true;
  }
  const byId = new Map(all.map((b) => [b.id, b]));
  const posts = new Map<string, Post>();
  for (const b of all) if (b.kind === 'post' || b.kind === 'sealed' || !b.target || !byId.has(b.target)) posts.set(b.id, { ...b, boosted: 0, total: b.value, replies: [], boosts: [] });
  for (const b of all) {
    const p = b.target ? posts.get(b.target) : undefined;
    if (!p || b.id === p.id) continue;
    if (b.kind === 'reply') p.replies.push(b);
    if (b.kind === 'boost') {
      p.boosts.push(b);
      p.boosted += b.value;
      p.total += b.value;
    }
  }
  const realBurns = live;
  return {
    posts: [...posts.values()],
    burned: realBurns.reduce((a, b) => a + b.value, 0),
    count: realBurns.length,
    biggest: realBurns.reduce((a, b) => Math.max(a, b.value), 0),
    specimen,
  };
}

export async function claim(txid: string): Promise<Burn[]> {
  const tx = await fetchTx('main', txid.trim().toLowerCase());
  const found = await burnsIn(tx.hex, { height: tx.height, time: tx.time, specimen: false });
  if (!found.length) throw new Error('That transaction has no output to the Burn Book address.');
  if (!tx.height) throw new Error('Found your burn, but it is not mined yet. Try again in a minute.');
  remember(txid.trim().toLowerCase());
  wallCache = null;
  return found;
}

// ---------- sealed predictions ----------

const fmtWhen = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

function until(d: Date) {
  const ms = d.getTime() - Date.now();
  const days = Math.floor(ms / 864e5);
  const hours = Math.floor((ms % 864e5) / 36e5);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${Math.max(1, Math.floor((ms % 36e5) / 6e4))}m`;
}

/** A sealed post: a countdown until its drand round, then the revealed text. */
function sealedText(post: Burn): HTMLElement {
  const el = h('div', { class: 'sealed' }, h('p', { class: 'ash-text muted' }, '🔒 Sealed prediction'));
  (async () => {
    try {
      const at = await opensAt(post.text);
      if (at.getTime() > Date.now()) {
        el.replaceChildren(h('p', { class: 'ash-text sealed-lock' }, '🔒 Sealed until ', h('b', {}, fmtWhen(at))), h('p', { class: 'hint' }, `Opens in ${until(at)}. Nobody can read it before then: not the author, not us. It is time-lock encrypted to a future drand round.`));
        return;
      }
      const text = await unseal(post.text);
      el.replaceChildren(h('span', { class: 'tag called' }, '✓ Called it'), h('p', { class: 'ash-text' }, text), h('p', { class: 'hint' }, `Sealed ${post.height ? `in block ${post.height.toLocaleString('en-US')}` : 'in a specimen transaction'}, opened ${fmtWhen(at)} by the drand beacon.`));
    } catch (e) {
      el.replaceChildren(h('p', { class: 'ash-text muted' }, '🔒 Sealed (could not reach drand to check)'), h('p', { class: 'hint' }, e instanceof Error ? e.message : String(e)));
    }
  })();
  return el;
}

// ---------- views ----------

type Shell = (...kids: Node[]) => void;

function ember(post: Post, onOpen: () => void, rank?: number): HTMLElement {
  const card = h(
    'article',
    { class: `ash${post.specimen ? ' is-specimen' : ''}`, tabindex: '0', onclick: onOpen, onkeydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && onOpen() },
    h('div', { class: 'ash-head' }, rank ? h('span', { class: 'rank' }, `#${rank}`) : null, h('span', { class: 'ash-sigil' }, sigil(`${post.txid}:${post.action}`)), h('span', { class: 'kicker' }, post.specimen ? 'Specimen · not on chain' : post.height ? `Block ${post.height.toLocaleString('en-US')}` : 'Pending'), post.kind !== 'post' ? h('span', { class: 'tag' }, post.kind) : null),
    post.kind === 'sealed' ? sealedText(post) : h('p', { class: 'ash-text' }, post.text || h('span', { class: 'muted' }, '(no message)')),
    h(
      'div',
      { class: 'ash-foot' },
      h('span', { class: 'flame' }, '🔥 ', zec(post.total, 'amount sm')),
      post.boosted ? h('span', { class: 'muted small' }, `${zecString(post.value)} + ${zecString(post.boosted)} in boosts`) : null,
      h('span', { class: 'muted small' }, `${post.replies.length} repl${post.replies.length === 1 ? 'y' : 'ies'}`),
    ),
  );
  return card;
}

export async function wallView(shell: Shell, tab: 'top' | 'new' | 'sealed') {
  const grid = h('div', { class: 'wall' }, h('p', { class: 'muted' }, 'Reading the ashes…'));
  const counter = h('div', { class: 'burn-stats' });
  shell(
    h(
      'section',
      { class: 'burn-hero' },
      h('div', {}, h('p', { class: 'eyebrow ember' }, 'Burn Book · Zcash'), h('h1', {}, 'Say anything.', h('br'), h('em', { class: 'ember' }, 'Burn ZEC to say it.'), h('br'), 'Nobody knows who.'), h('p', { class: 'lede' }, 'Every post is a shielded payment to an address nobody can ever spend from. The message rides in the encrypted memo; the key to read it is public, the key to spend it does not exist. Burn more, rise higher. It cannot be deleted, faked, or traced to you.'), h('div', { class: 'row' }, h('a', { class: 'btn fire', href: '#/burn/new' }, 'Write in the book'), h('a', { class: 'btn', href: '#/burn/proof' }, 'Prove the black hole'))),
      counter,
    ),
    h('nav', { class: 'tabs' }, h('a', { href: '#/burn', class: tab === 'top' ? 'on' : '' }, 'Most burned'), h('a', { href: '#/burn/new-posts', class: tab === 'new' ? 'on' : '' }, 'Newest'), h('a', { href: '#/burn/called-it', class: tab === 'sealed' ? 'on' : '' }, '🔒 Called it'), h('a', { href: '#/burn/claim' }, 'Claim a burn')),
    grid,
  );
  try {
    const w = await wall();
    counter.replaceChildren(
      h('div', {}, h('span', { class: 'kicker' }, 'ZEC burned on mainnet'), zec(w.burned, 'amount lg')),
      h('div', { class: 'stat-row' }, h('div', {}, h('b', {}, String(w.count)), h('span', {}, 'burns')), h('div', {}, h('b', {}, zecString(w.biggest)), h('span', {}, 'biggest'))),
    );
    if (w.specimen) counter.append(h('p', { class: 'hint' }, 'No mainnet burns claimed yet. Below is the specimen wall: real proven transactions, never mined, not counted. Be the first real one.'));
    const posts = [...w.posts].filter((p) => (tab === 'sealed' ? p.kind === 'sealed' : p.kind === 'post' || p.kind === 'sealed' || !w.posts.some((q) => q.id === p.target)));
    posts.sort(tab === 'top' ? (a, b) => b.total - a.total : (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.id.localeCompare(a.id));
    grid.replaceChildren(...posts.map((p, i) => ember(p, () => (location.hash = `#/burn/p/${p.id}`), tab === 'top' ? i + 1 : undefined)));
  } catch (e) {
    grid.replaceChildren(h('p', { class: 'muted' }, `Could not read the wall: ${e instanceof Error ? e.message : e}`));
  }
}

export async function postView(shell: Shell, id: string) {
  const body = h('div', { class: 'pair' }, h('p', { class: 'muted' }, 'Opening…'));
  shell(h('div', { class: 'wide' }, h('a', { class: 'link', href: '#/burn' }, '← Burn Book'), body));
  const w = await wall();
  const loose = (b: Burn): Post => ({ ...b, boosted: 0, total: b.value, replies: [], boosts: [] });
  let post: Post | undefined;
  const full = id.match(/^([0-9a-f]{64})\.(\d{1,3})$/);
  if (full) {
    // A shareable link carries the whole txid, so it opens straight from the chain,
    // whether or not the burn is listed on the public wall yet.
    const listed = w.posts.find((p) => p.txid === full[1] && p.action === Number(full[2]));
    if (listed) post = listed;
    else {
      try {
        const tx = await fetchTx('main', full[1]);
        const b = (await burnsIn(tx.hex, { height: tx.height, time: tx.time, specimen: false })).find((x) => x.action === Number(full[2]));
        if (b) post = loose(b);
      } catch (e) {
        return body.replaceChildren(h('p', { class: 'muted' }, e instanceof Error ? e.message : String(e)));
      }
    }
  } else {
    post = w.posts.find((p) => p.id === id) ?? w.posts.flatMap((p) => [...p.replies, ...p.boosts].map(loose)).find((p) => p.id === id);
  }
  if (!post) return body.replaceChildren(h('p', { class: 'muted' }, 'No such burn. It may not be mined yet, or the link is wrong.'));
  // Each post is a payee-side chit made with the public key, so it gets the full check log.
  let report: zpd.Report | null = null;
  try {
    const hex = post.specimen
      ? (await fetch(new URL(`${import.meta.env.BASE_URL}specimen/burns.json`, import.meta.url)).then((r) => r.json())).txs.find((t: { txid: string }) => t.txid === post.txid).tx
      : (await fetchTx('main', post.txid)).hex;
    report = await zpd.verify(hex, post.chit);
  } catch (e) {
    if (!(e instanceof ChainError)) throw e;
  }
  const v = report?.verified;
  const info = await burnInfo();
  const steps = [
    ...(report?.steps ?? []),
    { id: 'blackhole', label: 'Recipient is the Burn Book address (no spend key exists)', ok: v ? await zpd.sameReceiver(v.recipient, info.address, 'main') : null },
    { id: 'mined', label: post.specimen ? 'Specimen: never mined, by design' : `Mined in block ${post.height?.toLocaleString('en-US')}`, ok: post.specimen ? null : !!post.height },
  ];
  const thread = h(
    'section',
    { class: 'thread' },
    h('h3', {}, `${post.replies.length} repl${post.replies.length === 1 ? 'y' : 'ies'} · ${post.boosts.length} boost${post.boosts.length === 1 ? '' : 's'}`),
    ...post.boosts.map((b) => h('div', { class: 'reply boost' }, h('span', { class: 'flame' }, '🔥 +', zec(b.value, 'amount sm')), h('span', {}, b.text || 'boosted'))),
    ...post.replies.map((b) => h('div', { class: 'reply' }, h('span', { class: 'flame' }, '🔥 ', zec(b.value, 'amount sm')), h('span', {}, b.text))),
    h('div', { class: 'row' }, h('a', { class: 'btn fire small', href: `#/burn/new/+${post.id}` }, 'Boost this'), h('a', { class: 'btn small', href: `#/burn/new/re:${post.id}` }, 'Reply'), h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(location.href, e.currentTarget as HTMLElement) }, 'Copy link')),
  );
  body.replaceChildren(
    h('div', {}, ember(post, () => {}), thread, v ? h('details', { class: 'offline' }, h('summary', {}, 'The underlying certificate'), certificate(v, { kind: 'valid', source: post.specimen ? 'specimen' : 'chain' }, { height: post.height, chit: post.chit, specimen: post.specimen })) : null),
    h('div', { class: 'side' }, checklog('Verified in your browser', steps)),
  );
}

export async function composeView(shell: Shell, preset: string) {
  const info = await burnInfo();
  const target = preset.match(/^(re:|\+)([0-9a-f]{10}\.\d{1,3})$/);
  const mode: 'post' | 'reply' | 'boost' = target ? (target[1] === '+' ? 'boost' : 'reply') : 'post';
  const prefix = target ? `${target[1]}${target[2]}${mode === 'reply' ? ' ' : ' '}` : '';
  const text = h('textarea', { rows: '5', placeholder: mode === 'boost' ? 'Optional: why you are boosting' : 'Say it. It will outlive you.', maxlength: '500' });
  const amount = h('input', { value: mode === 'boost' ? '0.01' : '0.001', inputmode: 'decimal' });
  const count = h('span', { class: 'hint' });
  const sealBox = h('input', { type: 'checkbox' });
  const sealAt = h('input', { type: 'datetime-local', value: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16) });
  const sealWrap = h('div', { class: mode === 'post' ? 'seal-opt' : 'hidden' }, h('label', { class: 'inline' }, sealBox, '🔒 Seal it: nobody can read it until'), sealAt, h('p', { class: 'hint' }, 'Time-lock encrypted to a drand round. It shows as sealed on the wall, opens by itself at that time, and the burn’s block proves you said it first. Up to about 180 characters.'));
  const out = h('div');
  const bytes = () => {
    const n = new TextEncoder().encode(prefix + text.value).length;
    return sealBox.checked ? 5 + Math.ceil((197 + n) / 3) * 4 : n;
  };
  const upd = () => (count.textContent = `${bytes()}/${MEMO_LIMIT} bytes in the memo${sealBox.checked ? ' (sealed)' : ''}`);
  sealBox.addEventListener('change', upd);
  text.addEventListener('input', upd);
  upd();
  shell(
    h(
      'div',
      { class: 'narrow' },
      h(
        'form',
        {
          class: 'panel',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const zat = parseZec(amount.value);
            let memo = prefix + text.value.trim();
            if (!zat || zat < 100_000) return out.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Burn at least 0.001 ZEC.')));
            if (mode !== 'boost' && !text.value.trim()) return out.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Write something to burn.')));
            if (bytes() > MEMO_LIMIT) return out.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Too long for a Zcash memo (512 bytes).')));
            if (sealBox.checked) {
              const when = new Date(sealAt.value + 'Z');
              if (!(when.getTime() > Date.now() + 60_000)) return out.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Pick a time in the future to open it.')));
              out.replaceChildren(h('p', { class: 'muted' }, 'Sealing with drand…'));
              try {
                memo = await seal(text.value.trim(), when);
              } catch (err) {
                return out.replaceChildren(h('div', { class: 'error' }, h('b', {}, 'Could not reach drand to seal it.'), h('p', {}, err instanceof Error ? err.message : String(err))));
              }
            }
            const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(memo))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const uri = `zcash:${info.address}?amount=${zecString(zat)}&memo=${b64}`;
            const q = qrcode(0, 'L');
            q.addData(uri);
            q.make();
            const box = h('div', { class: 'qr lg' });
            box.innerHTML = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
            out.replaceChildren(
              h(
                'section',
                { class: 'share' },
                box,
                h('div', { class: 'grow' }, h('h3', {}, `Burn ${zecString(zat)} ZEC`), h('p', { class: 'muted small' }, 'Scan with Zodl (or any ZIP 321 wallet) and send from your shielded balance. The amount and message are filled in. Once it is mined, claim it so the wall can find it.'), h('div', { class: 'row' }, h('a', { class: 'btn fire', href: uri }, 'Burn in wallet'), h('button', { class: 'btn small', type: 'button', onclick: (ev: Event) => copy(uri, ev.currentTarget as HTMLElement) }, 'Copy payment URI'), h('a', { class: 'btn small', href: '#/burn/claim' }, 'I burned it → claim'))),
              ),
            );
          },
        },
        h('p', { class: 'eyebrow ember' }, mode === 'post' ? 'Write in the book' : mode === 'boost' ? `Boost ${target![2]}` : `Reply to ${target![2]}`),
        h('h1', {}, mode === 'post' ? 'What is worth burning for?' : mode === 'boost' ? 'Put fire behind it' : 'Answer, anonymously'),
        h('p', { class: 'muted' }, 'Your message goes in the encrypted memo of a payment to an address nobody can spend from. Everyone can read it. Nobody can tell it was you, as long as you burn from a shielded balance.'),
        h('label', {}, mode === 'boost' ? 'Note (optional)' : 'Message'),
        text,
        count,
        sealWrap,
        h('label', {}, 'ZEC to burn'),
        amount,
        h('p', { class: 'hint' }, 'Gone forever. Posts rank by total ZEC burned, including boosts from others.'),
        h('div', { class: 'row' }, h('button', { class: 'btn fire', type: 'submit' }, 'Make the burn')),
      ),
      out,
    ),
  );
}

export function claimView(shell: Shell) {
  const input = h('input', { placeholder: 'Transaction ID of your burn', spellcheck: 'false' });
  const out = h('div');
  shell(
    h(
      'div',
      { class: 'narrow' },
      h(
        'form',
        {
          class: 'panel',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            out.replaceChildren(h('p', { class: 'muted' }, 'Looking for your burn…'));
            try {
              const found = await claim(input.value);
              out.replaceChildren(
                h(
                  'div',
                  { class: 'ok-box' },
                  h('b', {}, `Verified: ${found.length} burn${found.length > 1 ? 's' : ''}, mined and paid to the black hole.`),
                  ...found.map((b) => {
                    const link = `${location.origin}${location.pathname}#/burn/tx/${b.txid}.${b.action}`;
                    return h('p', {}, h('a', { href: `#/burn/tx/${b.txid}.${b.action}` }, `🔥 ${zecString(b.value)} ZEC · “${short(b.kind === 'sealed' ? '🔒 sealed prediction' : b.text || '(boost)', 40, 0)}”`), ' ', h('button', { class: 'btn tiny', type: 'button', onclick: (ev: Event) => copy(link, ev.currentTarget as HTMLElement) }, 'Copy share link'));
                  }),
                  h('p', { class: 'hint' }, 'The share link works for anyone right now: it reads your burn straight from the chain. It shows on this device’s wall already; the public wall lists burns once they are added to the index, which the maintainers do by hand during the hackathon. Send the txid to @neromtoobad to be listed.'),
                ),
              );
            } catch (err) {
              out.replaceChildren(h('div', { class: 'error' }, h('b', {}, err instanceof Error ? err.message : String(err))));
            }
          },
        },
        h('p', { class: 'eyebrow ember' }, 'Claim a burn'),
        h('h1', {}, 'Put your burn on the wall'),
        h('p', { class: 'muted' }, 'Paste the transaction ID from your wallet. This page fetches it, decrypts it with the public Burn Book key, and checks it is mined. A txid reveals nothing about who sent it.'),
        input,
        h('div', { class: 'row' }, h('button', { class: 'btn fire', type: 'submit' }, 'Find my burn')),
        out,
      ),
    ),
  );
}

export async function proofView(shell: Shell) {
  const info = await burnInfo();
  const row = (k: string, v: string) => h('div', { class: 'proof-row' }, h('span', { class: 'kicker' }, k), h('code', { class: 'code' }, v));
  shell(
    h(
      'div',
      { class: 'narrow' },
      h('p', { class: 'eyebrow ember' }, 'Proof of the black hole'),
      h('h1', {}, 'Nobody can spend from this address. Not even us.'),
      h('p', { class: 'muted' }, 'Spending a shielded note needs a signature from the spend authorizing key ask, where ak = [ask]·G. The Burn Book key was never made from an ask: its ak is a point hashed onto the Pallas curve from a public string. Knowing ask would mean solving a discrete logarithm for a point nobody chose: the same assumption that protects every Zcash wallet.'),
      row('Address', info.address),
      row('Derivation', `ak = ±GroupHash^Pallas("${info.domain}", "ak")  (y made positive, as Orchard requires)\nnk = ToBase(BLAKE2b-512("ChitBurnBook__nk", "nk"))\nrivk = ToScalar(BLAKE2b-512("ChitBurnBook_rvk", "rivk"))`),
      row('ak (re-derived in your browser just now)', info.ak),
      row('nk', info.nk),
      row('rivk', info.rivk),
      row('Public viewing key: load it into any wallet to watch every burn', info.ufvk),
      h('p', { class: 'hint' }, 'The derivation runs here, in WebAssembly, from the strings above; the code is core/src/burn.rs in the repository, with a test that recomputes ak independently. The viewing key being public is deliberate: it is what makes every post readable and checkable by everyone.'),
      h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(info.address, e.currentTarget as HTMLElement) }, 'Copy address'), h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(info.ufvk, e.currentTarget as HTMLElement) }, 'Copy viewing key'), h('a', { class: 'btn small', href: 'https://github.com/neromtoobad/chit/blob/main/core/src/burn.rs', target: '_blank', rel: 'noreferrer' }, 'Read the code ↗')),
    ),
  );
}

