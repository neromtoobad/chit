// The judges' tour: one engine, three products, each shown with checks that run live in this
// tab. Nothing here is a recording; every tick below is computed when the page loads.

import { checklog, h, zec, type StepView } from './cert';
import { nodeOnThisOrigin, sourceName } from './chain';
import { specimen } from './specimen';
import * as zpd from './zpd';
import { burnInfo, wall } from './burnbook';
import { crewTile, type CrewKey } from './crew';

type Shell = (...kids: Node[]) => void;

// ---------- Bech32m, just enough to re-sign a tampered payload ----------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const M = 0x2bc830a3;

function polymod(values: number[]) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

const expand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convert(data: number[], from: number, to: number, pad: boolean) {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}

function decode(s: string) {
  const at = s.lastIndexOf('1');
  const words = [...s.slice(at + 1, -6)].map((c) => CHARSET.indexOf(c));
  return { hrp: s.slice(0, at), bytes: convert(words, 5, 8, false) };
}

function encode(hrp: string, bytes: number[]) {
  const words = convert(bytes, 8, 5, true);
  const mod = polymod([...expand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ M;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => CHARSET[w]).join('')}`;
}

/** Re-encodes a chit after `edit` changes its payload, with a valid checksum. */
function forge(chit: string, edit: (b: number[]) => void) {
  const { hrp, bytes } = decode(chit);
  edit(bytes);
  return encode(hrp, bytes);
}

// Payload layout: version, flags, action (u16 LE), txid (32), key.
const FLAGS = 1;
const ACTION = 2;
const KEY = 36;

// ---------- the page ----------

const card = (n: string, who: CrewKey, title: string, lede: string, ...kids: (Node | null)[]) =>
  h('section', { class: 'tour-card' }, h('div', { class: 'tour-num' }, crewTile(who), h('span', {}, n)), h('div', { class: 'tour-body' }, h('h2', {}, title), h('p', { class: 'muted' }, lede), ...kids));

const wait = (label: string) => checklog(label, [{ id: 'wait', label: 'Running…', ok: null }]);

export async function tourView(shell: Shell) {
  const proveLog = wait('Verify · specimen chit');
  const attackLog = wait('Attacks · each must fail');
  const ledgerLog = wait('Ledger · five payouts');
  const burnLog = wait('Burn Book · black hole');
  const hostLog = wait('This page · data source');
  const total = h('span', { class: 'tour-total' });

  shell(
    h(
      'div',
      { class: 'tour' },
      h('p', { class: 'eyebrow' }, 'For judges · the 90-second tour'),
      h('h1', {}, 'One engine. ', h('em', {}, 'Three products.')),
      h(
        'p',
        { class: 'lede' },
        'chit-core is a Rust verifier for single-output disclosures of Orchard and Ironwood payments (ZIP 311, extended). It is compiled three ways: WebAssembly for this site, a CLI, and an HTTP server. Every check on this page is running in your tab right now.',
      ),
      card(
        '01',
        'notary',
        'Prove: one payment, nothing else',
        'A chit opens exactly one output of one transaction. Below, the specimen chit is verified step by step. Then it is tampered with five ways, and every tampered copy has to be rejected.',
        h('div', { class: 'tour-pair' }, proveLog, attackLog),
        h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/check' }, 'Check your own chit'), h('a', { class: 'btn small ghost', href: '#/request' }, 'Pay & prove an invoice')),
      ),
      card(
        '02',
        'ledger',
        'Publish: payouts and posts anyone can audit',
        'A ledger page proves many payments and their total without opening the payer’s wallet. The Burn Book is a public wall of ZEC burned to an address that provably nobody can spend from.',
        h('div', { class: 'tour-pair' }, ledgerLog, burnLog),
        h('div', { class: 'row' }, total, h('a', { class: 'btn small', id: 'tour-ledger', href: '#/ledger' }, 'Open the ledger'), h('a', { class: 'btn small', href: '#/burn' }, 'Open the Burn Book'), h('a', { class: 'btn small ghost', href: '#/burn/proof' }, 'Black-hole proof')),
      ),
      card(
        '03',
        'node',
        'Self-host: no explorer, no third party',
        'The same engine ships as a server. Point it at your own Zebra node and serve this site from it: the page then talks only to your node, and no one else learns which transactions you check.',
        h('div', { class: 'tour-pair' }, hostLog, h('pre', { class: 'code block' }, h('code', {}, 'docker build -t chit .\ndocker run -p 8787:8787 chit \\\n  --rpc http://user:pass@zebra:8232\n\n# then open localhost:8787, or:\ncurl localhost:8787/v1/verify/zout1…'))),
        h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#/dev' }, 'Developer kit'), h('a', { class: 'btn small ghost', href: 'https://github.com/neromtoobad/chit/blob/main/cli/openapi.json', target: '_blank', rel: 'noreferrer' }, 'OpenAPI ↗')),
      ),
      h(
        'section',
        { class: 'tour-honest' },
        h('h2', {}, 'What is real, what is a specimen'),
        h(
          'table',
          {},
          row('Verifier, CLI, server, WASM, npm package', 'Real. 27 tests including 7 property tests, CI on every push.'),
          row('Specimen transaction', 'A real, fully proven v6 Ironwood transaction, but funded from nothing, so it is not on chain. Always labelled SPECIMEN.'),
          row('Mainnet', 'Any mainnet chit verifies against the chain (Blockchair or your node). Burn Book shows live mainnet burns as soon as one exists, and only then.'),
          row('Black-hole address', 'Real. Derived in your browser from a public string; its spend key is a discrete log nobody knows.'),
          row('ZIP 311 extension', 'Spec text and test vectors are in the repository. An upstream amendment to zcash/zips is drafted.'),
        ),
        h(
          'div',
          { class: 'row' },
          h('a', { class: 'btn small', href: 'https://github.com/neromtoobad/chit', target: '_blank', rel: 'noreferrer' }, 'Source ↗'),
          h('a', { class: 'btn small', href: 'https://github.com/neromtoobad/chit/blob/main/docs/zip-0311-orchard-ironwood.md', target: '_blank', rel: 'noreferrer' }, 'Spec ↗'),
          h('a', { class: 'btn small', href: 'https://github.com/neromtoobad/chit/blob/main/SECURITY.md', target: '_blank', rel: 'noreferrer' }, 'Threat model ↗'),
        ),
      ),
    ),
  );

  const spec = await specimen();
  const chit = spec.chits[0];

  // 01 · Prove
  const t0 = performance.now();
  const r = await zpd.verify(spec.tx, chit);
  const ms = Math.round(performance.now() - t0);
  const actions = Number(r.steps.find((s) => s.id === 'action')?.label.match(/\((\d+) actions\)/)?.[1] ?? 0);
  proveLog.replaceWith(checklog(`Verify · ${ms} ms`, r.steps, actions ? [{ id: 'sealed', label: `The other ${actions - 1} outputs of this transaction stay sealed`, ok: r.valid }] : []));

  const other = (await fetch(new URL(`${import.meta.env.BASE_URL}specimen/burns.json`, import.meta.url), { credentials: 'omit' }).then((x) => x.json())).txs[0].tx as string;
  const flipped = chit.slice(0, 20) + (chit[20] === 'q' ? 'p' : 'q') + chit.slice(21);
  const attacks: [string, () => Promise<boolean>][] = [
    ['One character edited: the checksum catches it', async () => zpd.inspect(flipped).then(() => false, () => true)],
    ['Key bytes altered, checksum re-signed: nothing opens', async () => !(await zpd.verify(spec.tx, forge(chit, (b) => (b[KEY] ^= 1)))).valid],
    ['Pointed at the next output: its note stays sealed', async () => !(await zpd.verify(spec.tx, forge(chit, (b) => (b[ACTION] += 1)))).valid],
    ['Relabelled as an Orchard output: rejected', async () => !(await zpd.verify(spec.tx, forge(chit, (b) => (b[FLAGS] = (b[FLAGS] & ~3) | 1)))).valid],
    ['Replayed against another transaction: rejected', async () => !(await zpd.verify(other, chit)).valid],
  ];
  const results: StepView[] = [];
  for (const [label, run] of attacks) results.push({ id: label, label, ok: await run().catch(() => true) });
  attackLog.replaceWith(checklog('Attacks · each must fail', results));

  // 02 · Publish
  const rows = await Promise.all(spec.chits.map((c) => zpd.verify(spec.tx, c)));
  const sum = rows.reduce((a, x) => a + (x.verified?.value_zat ?? 0), 0);
  ledgerLog.replaceWith(
    checklog('Ledger · five payouts', [
      ...rows.map((x, i): StepView => ({ id: `p${i}`, label: x.verified ? `Payout ${i + 1}: ${(x.verified.value_zat / 1e8).toLocaleString('en-US')} ZEC, memo “${x.verified.memo.value.slice(0, 28)}”` : `Payout ${i + 1}: ${x.error}`, ok: x.valid })),
      { id: 'dup', label: 'No output counted twice', ok: new Set(rows.map((x) => `${x.verified?.txid}:${x.verified?.action}`)).size === rows.length },
    ]),
  );
  total.replaceChildren(h('span', { class: 'kicker' }, 'Total, proven'), zec(sum, 'amount sm'));
  const lk = document.getElementById('tour-ledger') as HTMLAnchorElement | null;
  if (lk) lk.href = `#/l/${spec.chits.join(',')}~${encodeURIComponent('Specimen prize payouts')}`;

  const info = await burnInfo();
  const w = await wall().catch(() => null);
  burnLog.replaceWith(
    checklog('Burn Book · black hole', [
      { id: 'ak', label: `ak re-derived here from "${info.domain}": ${info.ak.slice(0, 12)}…`, ok: /^[0-9a-f]{64}$/.test(info.ak) },
      { id: 'addr', label: `Address ${info.address.slice(0, 10)}…${info.address.slice(-6)} built from that key`, ok: info.address.startsWith('u1') },
      { id: 'ufvk', label: 'Viewing key is public: every post is readable by anyone', ok: info.ufvk.startsWith('uview1') },
      w
        ? w.specimen
          ? { id: 'live', label: 'Mainnet burns: none yet, so the wall shows labelled specimens', ok: null }
          : { id: 'live', label: `${w.count} mainnet burns decrypted from the chain, ${(w.burned / 1e8).toLocaleString('en-US')} ZEC`, ok: true }
        : { id: 'live', label: 'Could not reach the chain from here', ok: null },
    ]),
  );

  // 03 · Self-host
  const own = await nodeOnThisOrigin();
  const name = await sourceName();
  const csp = await fetch(location.pathname, { credentials: 'omit', cache: 'no-store' })
    .then((x) => x.headers.get('content-security-policy') ?? '')
    .catch(() => '');
  const connect = csp.match(/connect-src ([^;]+)/)?.[1].trim();
  hostLog.replaceWith(
    checklog('This page · data source', [
      { id: 'keys', label: 'Keys and chits stay in this tab: routes live in the URL fragment', ok: true },
      connect ? { id: 'csp', label: `Content Security Policy read from this response: connect-src ${connect}`, ok: true } : { id: 'csp', label: 'No Content Security Policy on this server (a dev build?)', ok: null },
      own ? { id: 'src', label: 'Served by chit serve: transactions come from your own node', ok: true } : { id: 'src', label: `Transactions come from ${name}, which sees the txid. Self-host to remove it.`, ok: null },
    ]),
  );
}

const row = (k: string, v: string) => h('tr', {}, h('th', {}, k), h('td', {}, v));
