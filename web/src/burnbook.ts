// Burn Book: say anything, burn ZEC to say it, nobody knows who.
//
// A post is a shielded payment to the Burn Book address, a Unified Address whose spend
// key nobody holds (its ak is a hash-to-curve point; see core/src/burn.rs). The message is
// the encrypted memo. The address's full viewing key is public, so every reader decrypts
// and checks every post in their own browser; the burner stays anonymous.
//
// Memo grammar (UTF-8 text, at most 512 bytes):
//   re:<ref> text            a reply to the post <ref>
//   +<ref> text              a boost: more ZEC behind the post <ref>
//   poll:Question|A|B[|C|D]  a poll; people vote by burning
//   vote:<ref>:<k> [note]    a vote for option k (0-based) of the poll <ref>
//   seal:…                   a time-locked prediction (see seal-codec.mjs)
//   anything else            a post
// where <ref> is the first 10 hex characters of a txid, a dot, and the output index.
// Any of these may end with a mask signature line (see masks.ts).

import qrcode from 'qrcode-generator';
import { ChainError, fetchTx } from './chain';
import { certificate, checklog, copy, h, short, sigil, zec } from './cert';
import { parseZec, zecString } from './request';
import * as zpd from './zpd';
import { isSealed, opensAt, seal, unseal } from './seal-codec.mjs';
import { dropMask, importMask, maskName, myMask, newMask, sign, SIG_BYTES, verifySigned } from './masks';
import { downloadCard, tweetIntent } from './sharecard';
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
  kind: 'post' | 'reply' | 'boost' | 'sealed' | 'poll' | 'vote';
  target: string | null;
  /** Public key of the signing mask, if the memo carries a valid signature. */
  mask: string | null;
  /** For votes: the option index. */
  option: number | null;
  /** For polls: the question and options. */
  poll: { question: string; options: string[] } | null;
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
  /** For polls: ZEC burned and votes per option. */
  tally: { zat: number; votes: number }[] | null;
}

const load = zpd.load;

export async function burnInfo(): Promise<BurnInfo> {
  await load();
  return JSON.parse(wasm.burn_info('main'));
}

const MEMO_LIMIT = 512;

type Parsed = Pick<Burn, 'kind' | 'target' | 'text' | 'mask' | 'option' | 'poll'>;

function parseMemo(memo: string): Parsed {
  const { body: text, mask } = verifySigned(memo);
  const base = { mask, option: null, poll: null, target: null };
  if (isSealed(text)) return { ...base, kind: 'sealed', text };
  const re = text.match(/^re:([0-9a-f]{10}\.\d{1,3})\s?([\s\S]*)$/);
  if (re) return { ...base, kind: 'reply', target: re[1], text: re[2] };
  const boost = text.match(/^\+([0-9a-f]{10}\.\d{1,3})\s?([\s\S]*)$/);
  if (boost) return { ...base, kind: 'boost', target: boost[1], text: boost[2] };
  const vote = text.match(/^vote:([0-9a-f]{10}\.\d{1,3}):(\d)\s?([\s\S]*)$/);
  if (vote) return { ...base, kind: 'vote', target: vote[1], option: Number(vote[2]), text: vote[3] };
  const poll = text.match(/^poll:([^|\n]{1,200})((?:\|[^|\n]{1,60}){2,4})$/);
  if (poll) return { ...base, kind: 'poll', text: poll[1], poll: { question: poll[1], options: poll[2].slice(1).split('|') } };
  return { ...base, kind: 'post', text };
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

export interface MaskStat {
  pub: string;
  burned: number;
  count: number;
}

export interface Wall {
  posts: Post[];
  masks: MaskStat[];
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
  const top = (b: Burn) => b.kind === 'post' || b.kind === 'sealed' || b.kind === 'poll' || !b.target || !byId.has(b.target);
  for (const b of all) if (top(b)) posts.set(b.id, { ...b, boosted: 0, total: b.value, replies: [], boosts: [], tally: b.poll ? b.poll.options.map(() => ({ zat: 0, votes: 0 })) : null });
  for (const b of all) {
    const p = b.target ? posts.get(b.target) : undefined;
    if (!p || b.id === p.id) continue;
    if (b.kind === 'reply') p.replies.push(b);
    if (b.kind === 'boost') {
      p.boosts.push(b);
      p.boosted += b.value;
      p.total += b.value;
    }
    if (b.kind === 'vote' && p.tally && b.option !== null && b.option < p.tally.length) {
      p.tally[b.option].zat += b.value;
      p.tally[b.option].votes += 1;
      p.total += b.value;
    }
  }
  const masks = new Map<string, MaskStat>();
  for (const b of all) {
    if (!b.mask) continue;
    const m = masks.get(b.mask) ?? { pub: b.mask, burned: 0, count: 0 };
    m.burned += b.value;
    m.count += 1;
    masks.set(b.mask, m);
  }
  const realBurns = live;
  return {
    posts: [...posts.values()],
    masks: [...masks.values()].sort((a, b) => b.burned - a.burned),
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

function pollBody(post: Post, voting: boolean): HTMLElement {
  const tally = post.tally ?? [];
  const sum = tally.reduce((a, t) => a + t.zat, 0);
  return h(
    'div',
    { class: 'poll' },
    h('p', { class: 'ash-text' }, post.poll!.question),
    ...post.poll!.options.map((opt, k) => {
      const t = tally[k] ?? { zat: 0, votes: 0 };
      const pct = sum ? Math.round((t.zat / sum) * 100) : 0;
      return h(
        voting ? 'a' : 'div',
        { class: 'poll-opt', ...(voting ? { href: `#/burn/new/vote:${post.id}:${k}` } : {}) },
        h('span', { class: 'poll-bar', style: `width:${pct}%` }),
        h('span', { class: 'poll-label' }, opt),
        h('span', { class: 'poll-num' }, `${pct}% · ${zecString(t.zat)} ZEC · ${t.votes} vote${t.votes === 1 ? '' : 's'}`),
      );
    }),
    h('p', { class: 'hint' }, voting ? 'Vote by burning ZEC on an option. Weighted by ZEC destroyed; every voter is anonymous.' : `${tally.reduce((a, t) => a + t.votes, 0)} votes · weighted by ZEC burned`),
  );
}

function ember(post: Post, onOpen: () => void, rank?: number, voting = false): HTMLElement {
  const card = h(
    'article',
    { class: `ash${post.specimen ? ' is-specimen' : ''}`, tabindex: '0', onclick: onOpen, onkeydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && onOpen() },
    h(
      'div',
      { class: 'ash-head' },
      rank ? h('span', { class: 'rank' }, `#${rank}`) : null,
      h('span', { class: 'ash-sigil' }, sigil(post.mask ?? `${post.txid}:${post.action}`)),
      h('span', { class: 'who' }, post.mask ? h('a', { class: 'mask-name', href: `#/burn/masks`, onclick: (e: Event) => e.stopPropagation() }, `🎭 ${maskName(post.mask)}`) : h('span', { class: 'kicker' }, 'anonymous'), h('span', { class: 'kicker' }, post.specimen ? 'Specimen · not on chain' : post.height ? `Block ${post.height.toLocaleString('en-US')}` : 'Pending')),
      post.kind !== 'post' ? h('span', { class: 'tag' }, post.kind) : null,
    ),
    post.kind === 'sealed' ? sealedText(post) : post.kind === 'poll' ? pollBody(post, voting) : h('p', { class: 'ash-text' }, post.text || h('span', { class: 'muted' }, '(no message)')),
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

export async function wallView(shell: Shell, tab: 'top' | 'new' | 'sealed' | 'polls') {
  const grid = h('div', { class: 'wall' }, h('p', { class: 'muted' }, 'Reading the ashes…'));
  const counter = h('div', { class: 'burn-stats' });
  shell(
    h(
      'section',
      { class: 'burn-hero' },
      h('div', {}, h('p', { class: 'eyebrow ember' }, 'Burn Book · Zcash'), h('h1', {}, 'Say anything.', h('br'), h('em', { class: 'ember' }, 'Burn ZEC to say it.'), h('br'), 'Nobody knows who.'), h('p', { class: 'lede' }, 'Every post is a shielded payment to an address nobody can ever spend from. The message rides in the encrypted memo; the key to read it is public, the key to spend it does not exist. Burn more, rise higher. It cannot be deleted, faked, or traced to you.'), h('div', { class: 'row' }, h('a', { class: 'btn fire', href: '#/burn/new' }, 'Write in the book'), h('a', { class: 'btn', href: '#/burn/new/poll' }, 'Start a poll'), h('a', { class: 'btn', href: '#/burn/proof' }, 'Prove the black hole'))),
      counter,
    ),
    h('nav', { class: 'tabs' }, h('a', { href: '#/burn', class: tab === 'top' ? 'on' : '' }, 'Most burned'), h('a', { href: '#/burn/new-posts', class: tab === 'new' ? 'on' : '' }, 'Newest'), h('a', { href: '#/burn/called-it', class: tab === 'sealed' ? 'on' : '' }, '🔒 Called it'), h('a', { href: '#/burn/polls', class: tab === 'polls' ? 'on' : '' }, '🗳 Polls'), h('a', { href: '#/burn/masks' }, '🎭 Masks'), h('a', { href: '#/burn/claim' }, 'Claim a burn')),
    grid,
  );
  try {
    const w = await wall();
    counter.replaceChildren(
      h('div', {}, h('span', { class: 'kicker' }, 'ZEC burned on mainnet'), zec(w.burned, 'amount lg')),
      h('div', { class: 'stat-row' }, h('div', {}, h('b', {}, String(w.count)), h('span', {}, 'burns')), h('div', {}, h('b', {}, zecString(w.biggest)), h('span', {}, 'biggest'))),
    );
    if (w.specimen) counter.append(h('p', { class: 'hint' }, 'No mainnet burns claimed yet. Below is the specimen wall: real proven transactions, never mined, not counted. Be the first real one.'));
    const posts = [...w.posts].filter((p) => (tab === 'sealed' ? p.kind === 'sealed' : tab === 'polls' ? p.kind === 'poll' : p.kind !== 'vote'));
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
  const loose = (b: Burn): Post => ({ ...b, boosted: 0, total: b.value, replies: [], boosts: [], tally: b.poll ? b.poll.options.map(() => ({ zat: 0, votes: 0 })) : null });
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
  const shareLink = post.specimen ? location.href : `${location.origin}${location.pathname}#/burn/tx/${post.txid}.${post.action}`;
  const card = {
    text: post.kind === 'poll' ? `${post.text}\n${post.poll!.options.map((o, k) => `${['A', 'B', 'C', 'D'][k]}. ${o}`).join('   ')}` : post.kind === 'sealed' ? '🔒 A sealed prediction. Nobody can read it until its time comes.' : post.text || '(boost)',
    zat: post.total,
    mask: post.mask ? maskName(post.mask) : null,
    seed: post.mask ?? `${post.txid}:${post.action}`,
    specimen: post.specimen,
    kicker: post.kind === 'poll' ? 'anonymous poll' : post.kind === 'sealed' ? 'called it' : 'anonymous post',
  };
  const thread = h(
    'section',
    { class: 'thread' },
    h('h3', {}, `${post.replies.length} repl${post.replies.length === 1 ? 'y' : 'ies'} · ${post.boosts.length} boost${post.boosts.length === 1 ? '' : 's'}`),
    ...post.boosts.map((b) => h('div', { class: 'reply boost' }, h('span', { class: 'flame' }, '🔥 +', zec(b.value, 'amount sm')), h('span', {}, b.text || 'boosted'))),
    ...post.replies.map((b) => h('div', { class: 'reply' }, h('span', { class: 'flame' }, '🔥 ', zec(b.value, 'amount sm')), h('span', {}, b.text))),
    h('div', { class: 'row' }, h('a', { class: 'btn fire small', href: `#/burn/new/+${post.id}` }, 'Boost this'), h('a', { class: 'btn small', href: `#/burn/new/re:${post.id}` }, 'Reply'), h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(shareLink, e.currentTarget as HTMLElement) }, 'Copy link')),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => downloadCard(card, `burnbook-${post.id}.png`) }, '⬇ Share card'),
      h('a', { class: 'btn small', href: tweetIntent(post.kind === 'poll' ? `Anonymous poll, votes weighted by ZEC burned: “${post.text}”` : `Someone burned ${zecString(post.total)} ZEC to say this. Nobody knows who.`, shareLink), target: '_blank', rel: 'noreferrer' }, 'Post on X ↗'),
    ),
  );
  body.replaceChildren(
    h('div', {}, ember(post, () => {}, undefined, post.kind === 'poll'), thread, v ? h('details', { class: 'offline' }, h('summary', {}, 'The underlying certificate'), certificate(v, { kind: 'valid', source: post.specimen ? 'specimen' : 'chain' }, { height: post.height, chit: post.chit, specimen: post.specimen })) : null),
    h('div', { class: 'side' }, checklog('Verified in your browser', steps)),
  );
}

export async function composeView(shell: Shell, preset: string) {
  const info = await burnInfo();
  const target = preset.match(/^(re:|\+)([0-9a-f]{10}\.\d{1,3})$/);
  const vote = preset.match(/^vote:([0-9a-f]{10}\.\d{1,3}):(\d)$/);
  type Mode = 'post' | 'reply' | 'boost' | 'poll' | 'vote';
  const mode: Mode = vote ? 'vote' : preset === 'poll' ? 'poll' : target ? (target[1] === '+' ? 'boost' : 'reply') : 'post';
  const prefix = target ? `${target[1]}${target[2]} ` : vote ? `vote:${vote[1]}:${vote[2]} ` : '';
  let voteLabel = '';
  if (vote) {
    const p = (await wall()).posts.find((x) => x.id === vote[1]);
    voteLabel = p?.poll?.options[Number(vote[2])] ?? `option ${Number(vote[2]) + 1}`;
  }
  const text = h('textarea', { rows: mode === 'poll' ? '2' : '5', placeholder: { post: 'Say it. It will outlive you.', reply: 'Answer, anonymously.', boost: 'Optional: why you are boosting', vote: 'Optional: a note with your vote', poll: 'The question' }[mode], maxlength: '500' });
  const options = [0, 1, 2, 3].map((k) => h('input', { placeholder: k < 2 ? `Option ${'ABCD'[k]}` : `Option ${'ABCD'[k]} (optional)`, maxlength: '60' }));
  const optWrap = h('div', { class: mode === 'poll' ? 'poll-inputs' : 'hidden' }, ...options);
  const amount = h('input', { value: mode === 'boost' || mode === 'vote' ? '0.01' : '0.001', inputmode: 'decimal' });
  const count = h('span', { class: 'hint' });
  const sealBox = h('input', { type: 'checkbox' });
  const sealAt = h('input', { type: 'datetime-local', value: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16) });
  const sealWrap = h('div', { class: mode === 'post' ? 'seal-opt' : 'hidden' }, h('label', { class: 'inline' }, sealBox, '🔒 Seal it: nobody can read it until'), sealAt, h('p', { class: 'hint' }, 'Time-lock encrypted to a drand round. It shows as sealed on the wall, opens by itself at that time, and the burn’s block proves you said it first.'));
  const mask = myMask();
  const signBox = h('input', { type: 'checkbox', ...(mask ? { checked: true } : { disabled: true }) });
  const signWrap = h('div', { class: 'seal-opt' }, h('label', { class: 'inline' }, signBox, mask ? `🎭 Sign as ${maskName(mask.pub)}` : '🎭 Sign with a mask (you have none yet)'), h('p', { class: 'hint' }, mask ? 'Adds a signature only your browser can make: the post counts toward your mask’s reputation, and still nothing links it to your wallet.' : h('span', {}, h('a', { href: '#/burn/masks' }, 'Create a mask'), ' to build a pseudonymous reputation. Optional: unsigned posts are fully anonymous.')));
  const out = h('div');
  const body = () => (mode === 'poll' ? `poll:${text.value.trim().replace(/[|\n]/g, ' ')}|${options.map((o) => o.value.trim().replace(/[|\n]/g, ' ')).filter(Boolean).join('|')}` : prefix + text.value.trim());
  const bytes = () => {
    const n = new TextEncoder().encode(body()).length;
    const sealed = sealBox.checked ? 5 + Math.ceil((197 + n) / 3) * 4 : n;
    return sealed + (signBox.checked ? SIG_BYTES : 0);
  };
  const upd = () => (count.textContent = `${bytes()}/${MEMO_LIMIT} bytes in the memo${sealBox.checked ? ' · sealed' : ''}${signBox.checked ? ' · signed' : ''}`);
  for (const el of [text, ...options]) el.addEventListener('input', upd);
  sealBox.addEventListener('change', upd);
  signBox.addEventListener('change', upd);
  upd();
  const err = (m: string) => out.replaceChildren(h('div', { class: 'error' }, h('b', {}, m)));
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
            if (!zat || zat < 100_000) return err('Burn at least 0.001 ZEC.');
            if ((mode === 'post' || mode === 'reply' || mode === 'poll') && !text.value.trim()) return err(mode === 'poll' ? 'Ask a question.' : 'Write something to burn.');
            if (mode === 'poll' && options.filter((o) => o.value.trim()).length < 2) return err('A poll needs at least two options.');
            if (bytes() > MEMO_LIMIT) return err('Too long for a Zcash memo (512 bytes).');
            let memo = body();
            if (sealBox.checked) {
              const when = new Date(sealAt.value + 'Z');
              if (!(when.getTime() > Date.now() + 60_000)) return err('Pick a time in the future to open it.');
              out.replaceChildren(h('p', { class: 'muted' }, 'Sealing with drand…'));
              try {
                memo = await seal(text.value.trim(), when);
              } catch (er) {
                return err(`Could not reach drand to seal it: ${er instanceof Error ? er.message : er}`);
              }
            }
            if (signBox.checked && mask) memo = sign(memo, mask);
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
        h('p', { class: 'eyebrow ember' }, { post: 'Write in the book', reply: `Reply to ${target?.[2]}`, boost: `Boost ${target?.[2]}`, poll: 'Start a poll', vote: `Vote in ${vote?.[1]}` }[mode]),
        h('h1', {}, { post: 'What is worth burning for?', reply: 'Answer, anonymously', boost: 'Put fire behind it', poll: 'Ask the void', vote: `Burn for “${voteLabel}”` }[mode]),
        h('p', { class: 'muted' }, mode === 'poll' ? 'A poll where every vote is a burn: results are weighted by ZEC destroyed, and nobody knows who voted. Starting it costs a burn too.' : 'Your message goes in the encrypted memo of a payment to an address nobody can spend from. Everyone can read it. Nobody can tell it was you, as long as you burn from a shielded balance.'),
        h('label', {}, { post: 'Message', reply: 'Reply', boost: 'Note (optional)', poll: 'Question', vote: 'Note (optional)' }[mode]),
        text,
        optWrap,
        count,
        sealWrap,
        signWrap,
        h('label', {}, mode === 'vote' ? 'ZEC to burn on this option' : 'ZEC to burn'),
        amount,
        h('p', { class: 'hint' }, 'Gone forever. Posts rank by total ZEC burned, including boosts and votes from others.'),
        h('div', { class: 'row' }, h('button', { class: 'btn fire', type: 'submit' }, 'Make the burn')),
      ),
      out,
    ),
  );
}

export async function masksView(shell: Shell) {
  const mine = h('div', { class: 'panel slim' });
  const board = h('div', { class: 'mask-board' }, h('p', { class: 'muted' }, 'Counting…'));
  const paint = () => {
    const m = myMask();
    const secretBox = h('code', { class: 'code hidden' });
    const importIn = h('input', { placeholder: 'Paste a mask key to restore it', spellcheck: 'false' });
    mine.replaceChildren(
      h('h3', {}, 'Your mask'),
      m
        ? h('div', { class: 'mask-me' }, h('span', { class: 'ash-sigil big' }, sigil(m.pub)), h('div', {}, h('b', {}, `🎭 ${maskName(m.pub)}`), h('p', { class: 'hint' }, 'Lives only in this browser. Sign burns with it to build a reputation nobody can fake or trace to your wallet.')))
        : h('p', { class: 'hint' }, 'No mask in this browser. A mask is an Ed25519 key that never leaves this device; it signs your burns so they add up to one pseudonymous reputation. Your wallet stays unlinked.'),
      h(
        'div',
        { class: 'row' },
        m
          ? h('button', { class: 'btn small', type: 'button', onclick: () => { secretBox.textContent = m.secret; secretBox.classList.toggle('hidden'); } }, 'Show key to back up')
          : h('button', { class: 'btn fire small', type: 'button', onclick: () => { newMask(); paint(); } }, 'Create my mask'),
        m ? h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Forget this mask? Without a backup it is gone forever.')) { dropMask(); paint(); } } }, 'Forget') : null,
      ),
      secretBox,
    );
    if (!m) mine.append(h('div', { class: 'row tight' }, importIn, h('button', { class: 'btn small', type: 'button', onclick: () => { try { importMask(importIn.value); paint(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); } } }, 'Restore')));
  };
  paint();
  shell(
    h(
      'div',
      { class: 'wide' },
      h('a', { class: 'link', href: '#/burn' }, '← Burn Book'),
      h('p', { class: 'eyebrow ember' }, 'Masks'),
      h('h1', {}, 'Reputation without a face.'),
      h('p', { class: 'muted lede' }, 'Sign your burns with a mask and they add up: a pseudonym whose every post and every ZEC burned is provably its own. Anyone can verify the signatures. Nobody can link a mask to a wallet, or a wallet to a mask.'),
      mine,
      h('h2', {}, 'Most burned masks'),
      board,
    ),
  );
  const w = await wall();
  board.replaceChildren(
    ...(w.masks.length
      ? w.masks.map((m, i) => h('div', { class: 'mask-row' }, h('span', { class: 'rank' }, `#${i + 1}`), h('span', { class: 'ash-sigil' }, sigil(m.pub)), h('b', {}, `🎭 ${maskName(m.pub)}`), h('span', { class: 'muted small' }, `${m.count} burn${m.count === 1 ? '' : 's'}`), h('span', { class: 'flame' }, '🔥 ', zec(m.burned, 'amount sm'))))
      : [h('p', { class: 'muted' }, 'No signed burns yet.')]),
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

