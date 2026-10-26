import '@fontsource/gloock';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './style.css';
import qrcode from 'qrcode-generator';
import { ChainError, explorerUrl, fetchStats, fetchTx, type Network, type TxData } from './chain';
import { certificate, checklog, copy, h, memoNode, short, zec, type Seal, type StepView } from './cert';
import { checkInvoice, decodeRequest, encodeRequest, memoFor, parseZec, zecString, zip321, type PayRequest } from './request';
import { specimen } from './specimen';
import * as zpd from './zpd';
import * as burnbook from './burnbook';

const app = document.getElementById('app')!;

// Every route lives in the URL fragment, which browsers never send to a server: a shared
// chit, request or ledger link reveals nothing to whoever hosts this page.
type Route =
  | { view: 'home' }
  | { view: 'make' }
  | { view: 'check' }
  | { view: 'verify'; chit: string; request: PayRequest | null }
  | { view: 'newRequest' }
  | { view: 'request'; request: PayRequest; raw: string }
  | { view: 'newLedger' }
  | { view: 'ledger'; chits: string[]; title: string; hide: boolean }
  | { view: 'dev' }
  | { view: 'burn'; tab: 'top' | 'new' | 'sealed' }
  | { view: 'burnNew'; preset: string }
  | { view: 'burnPost'; id: string }
  | { view: 'burnClaim' }
  | { view: 'burnProof' };

function route(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const [head, a, b, c] = parts;
  if (head === 'burn') {
    if (a === 'new') return { view: 'burnNew', preset: b ?? '' };
    if ((a === 'p' || a === 'tx') && b) return { view: 'burnPost', id: b };
    if (a === 'claim') return { view: 'burnClaim' };
    if (a === 'proof') return { view: 'burnProof' };
    return { view: 'burn', tab: a === 'new-posts' ? 'new' : a === 'called-it' ? 'sealed' : 'top' };
  }
  if (head === 'make') return { view: 'make' };
  if (head === 'check') return { view: 'check' };
  if (head === 'dev') return { view: 'dev' };
  if (head === 'request') return { view: 'newRequest' };
  if (head === 'ledger') return { view: 'newLedger' };
  if (head === 'v' && a) return { view: 'verify', chit: a, request: b === 'r' && c ? decodeRequest(c) : null };
  if (head === 'r' && a) {
    const request = decodeRequest(a);
    if (request) return { view: 'request', request, raw: a };
  }
  if (head === 'l' && a) {
    const [list, title = '', flags = ''] = a.split('~');
    return { view: 'ledger', chits: list.split(',').filter(Boolean), title, hide: flags.includes('h') };
  }
  return { view: 'home' };
}

const base = () => `${location.origin}${location.pathname}`;
const chitLink = (chit: string, req?: string) => `${base()}#/v/${chit}${req ? `/r/${req}` : ''}`;
const ledgerLink = (chits: string[], title: string, hide: boolean) =>
  `${base()}#/l/${chits.join(',')}${title || hide ? '~' + encodeURIComponent(title) : ''}${hide ? '~h' : ''}`;

function shell(...kids: Node[]) {
  const r = route().view;
  const tab = (href: string, label: string, on: boolean) => h('a', { href, class: on ? 'on' : '' }, label);
  app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#/' }, h('i', {}), 'Chit'),
      h(
        'nav',
        {},
        tab('#/burn', 'Burn Book', r.startsWith('burn')),
        tab('#/make', 'Make', r === 'make'),
        tab('#/check', 'Check', r === 'check' || r === 'verify'),
        tab('#/request', 'Pay & prove', r === 'newRequest' || r === 'request'),
        tab('#/ledger', 'Ledger', r === 'newLedger' || r === 'ledger'),
        tab('#/dev', 'Developers', r === 'dev'),
      ),
      h('a', { class: 'btn small accent', href: '#/make' }, 'Make a chit'),
    ),
    h('main', {}, ...kids),
    h(
      'footer',
      {},
      h('span', {}, 'No server, no account. Keys never leave this tab.'),
      h('span', {}, h('a', { href: 'https://github.com/neromtoobad/chit', target: '_blank', rel: 'noreferrer' }, 'Source'), ' · ', h('a', { href: 'https://zips.z.cash/zip-0311', target: '_blank', rel: 'noreferrer' }, 'ZIP 311')),
    ),
  );
}

function errorBox(msg: string, detail?: string) {
  return h('div', { class: 'error' }, h('b', {}, msg), detail ? h('p', {}, detail) : null);
}

function qr(text: string, cls = 'qr') {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const box = h('div', { class: cls });
  box.innerHTML = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  return box;
}

// ---------- checking a chit ----------

type Source = 'chain' | 'pasted' | 'specimen';

interface Checked {
  report: zpd.Report;
  source: Source;
  tx: TxData | null;
}

async function checkChit(chit: string, rawHex?: string): Promise<Checked> {
  const head = await zpd.inspect(chit);
  const spec = await specimen().catch(() => null);
  if (!rawHex && spec && head.txid === spec.txid) {
    return { report: await zpd.verify(spec.tx, chit), source: 'specimen', tx: null };
  }
  if (rawHex) return { report: await zpd.verify(rawHex, chit), source: 'pasted', tx: null };
  const tx = await fetchTx(head.network, head.txid);
  return { report: await zpd.verify(tx.hex, chit), source: 'chain', tx };
}

const sourceStep = (c: Checked): StepView =>
  c.source === 'chain'
    ? { id: 'mined', label: `Mined in block ${c.tx?.height?.toLocaleString('en-US') ?? '(pending)'} (Blockchair)`, ok: c.tx?.height ? true : null }
    : c.source === 'specimen'
      ? { id: 'mined', label: 'Specimen transaction: never mined, by design', ok: null }
      : { id: 'mined', label: 'Pasted transaction: confirm it is mined on your node', ok: null };

function voidCert(msg: string) {
  return h(
    'article',
    { class: 'cert is-void' },
    h('div', { class: 'doc' }, h('div', { class: 'doc-head' }, h('span', {}, 'Shielded payment certificate'), h('span', {}, 'Void')), h('h2', { class: 'void-title' }, 'This chit does not check out.'), h('p', {}, 'It does not open the output it names. It may have been edited, or it was never valid. Nothing about the payment can be trusted from it.'), h('p', { class: 'mono muted small' }, msg)),
    h('div', { class: 'seal bad' }, h('span', {}, 'Does not'), h('b', {}, 'Void'), h('span', {}, 'check out')),
  );
}

// ---------- views ----------

async function home() {
  const stage = h('div', { class: 'stage' }, h('div', { class: 'stage-wait' }, 'Rendering a specimen…'));
  const stats = h('div', { class: 'stats' }, stat('—', 'Blocks'), stat('—', 'Transactions · 24h'), stat('0', 'Keys sent, ever'));
  shell(
    h(
      'section',
      { class: 'hero' },
      h(
        'div',
        { class: 'hero-copy' },
        h('p', { class: 'eyebrow' }, 'Zcash · Orchard & Ironwood · ZIP 311'),
        h('h1', {}, 'One payment,', h('br'), h('em', {}, 'notarised.'), h('br'), 'Nothing else.'),
        h('p', { class: 'lede' }, 'Turn a single shielded output into a certificate anyone can verify against the chain. You never hand over a viewing key, and no other payment is exposed.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/make' }, 'Make a chit'), h('a', { class: 'btn', href: '#/check' }, 'Check a chit')),
        stats,
      ),
      stage,
    ),
    h(
      'section',
      { class: 'uses' },
      use('Burn Book', 'Say anything, burn ZEC to say it, nobody knows who. Posts are payments to an address nobody can spend from; the most burned rise to the top.', '#/burn', 'Open the book'),
      use('Pay & prove', 'Send a customer a payment request. When they pay, their chit is checked against it: right recipient, full amount, invoice number in the memo.', '#/request', 'Make a request'),
      use('Proof of payouts', 'Paying winners, grantees or staff from a shielded wallet? Publish one ledger page that proves every payment and the total, without opening the wallet.', '#/ledger', 'Build a ledger'),
      use('For developers', 'The verifier is a Rust crate compiled to WebAssembly. Use it from npm, the command line, or drop a <chit-verify> badge onto any page.', '#/dev', 'Developer kit'),
    ),
    h(
      'section',
      { class: 'reveal' },
      h('h2', {}, 'What a chit reveals'),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, ''), h('th', {}, 'Viewing key'), h('th', {}, 'Chit')),
        reveal('This payment’s amount, recipient and memo', 'Yes', 'Yes'),
        reveal('Every other payment you made or received', 'Yes', 'No'),
        reveal('Your balance', 'Yes', 'No'),
        reveal('Can be turned back into your key', '—', 'No'),
      ),
      h('p', { class: 'muted small' }, 'A payer’s chit carries the output’s outgoing cipher key (ock), the mechanism draft ZIP 311 specifies for Sapling. A payee’s chit carries pk_d and esk, which a recipient can rebuild under ZIP 212. Every check runs in your browser with the official Zcash crates compiled to WebAssembly.'),
    ),
  );

  fetchStats()
    .then((s) => stats.replaceChildren(stat(s.blocks.toLocaleString('en-US'), 'Blocks'), stat(s.tx24h.toLocaleString('en-US'), 'Transactions · 24h'), stat('0', 'Keys sent, ever')))
    .catch(() => {});

  try {
    const spec = await specimen();
    const chit = spec.chits[0];
    const c = await checkChit(chit);
    if (!c.report.verified) throw new Error(c.report.error ?? 'specimen failed');
    stage.replaceChildren(
      h('a', { class: 'stage-link', href: `#/v/${chit}`, 'aria-label': 'Open the specimen certificate' }, certificate(c.report.verified, { kind: 'valid', source: 'specimen' }, { chit })),
      checklog('Verification log · specimen', c.report.steps),
    );
  } catch {
    stage.replaceChildren();
  }
}

const stat = (v: string, l: string) => h('div', {}, h('b', {}, v), h('span', {}, l));
const use = (title: string, body: string, href: string, cta: string) => h('a', { class: 'use', href }, h('h3', {}, title), h('p', {}, body), h('span', { class: 'go' }, `${cta} →`));
const reveal = (label: string, key: string, chit: string) => h('tr', {}, h('td', {}, label), h('td', {}, key), h('td', { class: chit === 'No' ? 'no' : '' }, chit));

function make() {
  let network: Network = 'main';
  const txid = h('input', { id: 'txid', placeholder: 'Transaction ID (64 hex characters)', spellcheck: 'false', autocomplete: 'off' });
  const raw = h('textarea', { id: 'raw', placeholder: 'Raw transaction hex', spellcheck: 'false', rows: '4' });
  const rawWrap = h('div', { class: 'hidden' }, h('label', { for: 'raw' }, 'Raw transaction'), raw, h('p', { class: 'hint' }, 'Use this offline, on testnet, or so the explorer never sees this txid.'));
  const key = h('input', { id: 'ufvk', type: 'password', placeholder: 'uview1…', spellcheck: 'false', autocomplete: 'off' });
  const net = h('select', { onchange: (e: Event) => (network = (e.target as HTMLSelectElement).value as Network) }, h('option', { value: 'main' }, 'Mainnet'), h('option', { value: 'test' }, 'Testnet'));
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Find my outputs');
  const out = h('div', { class: 'results' });
  const useSpecimen = h(
    'button',
    {
      class: 'btn ghost',
      type: 'button',
      onclick: async () => {
        const s = await specimen();
        rawWrap.classList.remove('hidden');
        raw.value = s.tx;
        txid.value = s.txid;
        key.value = s.organiser_ufvk;
        net.value = 'main';
        network = 'main';
      },
    },
    'Use the specimen wallet',
  );

  const form = h(
    'form',
    {
      class: 'panel',
      autocomplete: 'off',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        go.disabled = true;
        go.textContent = 'Scanning…';
        out.replaceChildren();
        const ufvk = key.value;
        key.value = ''; // the key lives only for this call
        try {
          if (!ufvk.trim()) throw new ChainError('Paste your viewing key (a Unified Full Viewing Key, uview1…).');
          let tx: TxData | null = null;
          let hex = raw.value.trim();
          if (!hex) {
            tx = await fetchTx(network, txid.value.trim().toLowerCase());
            hex = tx.hex;
          }
          const found = await zpd.scan(hex, ufvk, network);
          const id = await zpd.txidOf(hex);
          const spec = await specimen().catch(() => null);
          const source: Source = spec?.txid === id ? 'specimen' : tx ? 'chain' : 'pasted';
          showFound(out, found, network, id, tx, source);
        } catch (err) {
          out.replaceChildren(errorBox(err instanceof Error ? err.message : String(err)));
        } finally {
          go.disabled = false;
          go.textContent = 'Find my outputs';
        }
      },
    },
    h('p', { class: 'eyebrow' }, 'Make'),
    h('h1', {}, 'Make a chit'),
    h('p', { class: 'muted' }, 'Find the outputs of one of your transactions, then share exactly one of them.'),
    h('label', { for: 'txid' }, 'Transaction'),
    h('div', { class: 'row tight' }, txid, net),
    h('button', { class: 'link', type: 'button', onclick: () => rawWrap.classList.toggle('hidden') }, 'Paste the raw transaction instead'),
    rawWrap,
    h('label', { for: 'ufvk' }, 'Your viewing key'),
    key,
    h('p', { class: 'hint' }, 'Export it from your wallet (Zodl: Settings → Export viewing key). It is used in this tab, cleared from the field straight away, and never sent anywhere.'),
    h('div', { class: 'row' }, go, useSpecimen),
  );
  shell(h('div', { class: 'narrow' }, form, out));
}

function showFound(out: HTMLElement, found: zpd.Found[], network: Network, txid: string, tx: TxData | null, source: Source) {
  if (!found.length) {
    out.replaceChildren(errorBox('This viewing key has no Orchard or Ironwood outputs in that transaction.', 'Check that it is the wallet that sent or received the payment, and that the payment was shielded.'));
    return;
  }
  const picked = new Set<string>();
  const title = h('input', { placeholder: 'Ledger title, e.g. “October grants”', class: 'grow' });
  const hide = h('input', { type: 'checkbox' });
  const ledgerBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => (location.hash = ledgerLink([...picked], title.value.trim(), hide.checked).split('#')[1]) }, 'Publish ledger');
  const rows = [...found]
    .sort((a, b) => Number(a.change) - Number(b.change))
    .map((f) => {
      const label = f.change ? 'Change to yourself' : f.direction === 'outgoing' ? 'You paid' : 'You received';
      const box = h('input', {
        type: 'checkbox',
        'aria-label': 'Add to ledger',
        onchange: (e: Event) => {
          (e.target as HTMLInputElement).checked ? picked.add(f.disclosure) : picked.delete(f.disclosure);
          ledgerBtn.disabled = picked.size < 1;
        },
      });
      const choose = h('button', { class: 'btn primary small', type: 'button' }, 'Make chit');
      choose.addEventListener('click', async () => {
        const report = await zpd.verify(tx?.hex ?? (await specimen()).tx, f.disclosure).catch(() => null);
        const v: zpd.Verified = { network, txid, pool: f.pool, action: f.action, direction: f.direction, value_zat: f.value_zat, recipient: f.recipient, memo: f.memo };
        out.replaceChildren(
          h('div', { class: 'pair' }, certificate(v, source === 'specimen' ? { kind: 'valid', source } : { kind: 'preview' }, { height: tx?.height, time: tx?.time, chit: f.disclosure }), report ? checklog('Self-check before sharing', report.steps) : h('span')),
          shareBox(f.disclosure),
          h('button', { class: 'link', type: 'button', onclick: () => showFound(out, found, network, txid, tx, source) }, '← All outputs'),
        );
        out.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return h(
        'div',
        { class: `found${f.change ? ' change' : ''}` },
        h('label', { class: 'pick' }, box),
        h('div', { class: 'grow' }, h('span', { class: 'kicker' }, `${label} · ${f.pool} output ${f.action}`), h('div', {}, zec(f.value_zat, 'amount md')), h('div', { class: 'mono small muted' }, short(f.recipient, 14, 10)), h('div', { class: 'small' }, memoNode(f.memo))),
        choose,
      );
    });
  out.replaceChildren(
    h('h2', {}, `${found.length} output${found.length > 1 ? 's' : ''} your key can disclose`),
    ...rows,
    h('div', { class: 'panel slim' }, h('p', { class: 'hint' }, 'Paying several people? Tick their outputs and publish one ledger that proves every payment and the total.'), h('div', { class: 'row tight' }, title, h('label', { class: 'inline' }, hide, 'Hide recipients'), ledgerBtn)),
  );
}

function shareBox(chit: string): HTMLElement {
  const url = chitLink(chit);
  return h(
    'section',
    { class: 'share' },
    qr(url),
    h(
      'div',
      { class: 'grow' },
      h('h3', {}, 'Share this chit'),
      h('p', { class: 'muted small' }, 'Anyone with the link can check this one payment. The chit sits after the #, so no server ever sees it.'),
      h('code', { class: 'code' }, chit),
      h('div', { class: 'row' }, h('button', { class: 'btn primary small', type: 'button', onclick: (e: Event) => copy(url, e.currentTarget as HTMLElement) }, 'Copy link'), h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(chit, e.currentTarget as HTMLElement) }, 'Copy code'), h('a', { class: 'btn small', href: `#/v/${chit}` }, 'Open as checker')),
    ),
  );
}

const CHIT_RE = /(zout(?:test)?1[02-9ac-hj-np-z]{20,})/gi;

function check() {
  const input = h('textarea', { rows: '3', placeholder: 'Paste a chit (zout1…) or a chit link', spellcheck: 'false' });
  const err = h('div');
  shell(
    h(
      'div',
      { class: 'narrow' },
      h(
        'form',
        {
          class: 'panel',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const m = input.value.match(CHIT_RE);
            if (!m) return err.replaceChildren(errorBox('That does not look like a chit.', 'A chit starts with zout1 (mainnet) or zouttest1 (testnet).'));
            location.hash = `#/v/${m[0].toLowerCase()}`;
          },
        },
        h('p', { class: 'eyebrow' }, 'Check'),
        h('h1', {}, 'Check a chit'),
        h('p', { class: 'muted' }, 'Someone sent you proof of a shielded payment. Paste it, and this page checks it against the transaction on chain.'),
        input,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Check it'), h('button', { class: 'btn ghost', type: 'button', onclick: async () => (location.hash = `#/v/${(await specimen()).chits[0]}`) }, 'Try the specimen')),
        err,
      ),
    ),
  );
}

function verifyView(chit: string, request: PayRequest | null) {
  const body = h('div', { class: 'pair' }, h('p', { class: 'muted' }, 'Checking…'));
  const raw = h('textarea', { rows: '3', placeholder: 'Raw transaction hex', spellcheck: 'false' });
  const offline = h(
    'details',
    { class: 'offline' },
    h('summary', {}, 'Check without the explorer'),
    h('p', { class: 'hint' }, 'The checker fetches the transaction from Blockchair, which learns that someone looked up this txid. To avoid that, fetch the raw transaction from your own node and paste it here.'),
    raw,
    h('button', { class: 'btn small', type: 'button', onclick: () => run(raw.value.trim()) }, 'Check with this transaction'),
  );
  const invoice = request ? invoiceCard(request) : null;
  shell(h('div', { class: 'wide' }, invoice, body, offline));

  async function run(rawHex?: string) {
    body.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
    let c: Checked;
    try {
      c = await checkChit(chit, rawHex || undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ChainError) {
        offline.open = true;
        return body.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'kicker' }, 'Not checked yet'), h('h3', {}, 'Could not fetch the transaction'), h('p', {}, msg), h('p', { class: 'hint' }, 'A just-sent payment can take a minute to reach the explorer. You can also paste the raw transaction below.')));
      }
      return body.replaceChildren(voidCert(msg));
    }
    const { report } = c;
    if (!report.verified) {
      return body.replaceChildren(voidCert(report.error ?? 'invalid'), checklog('Verification log', report.steps));
    }
    const v = report.verified;
    let seal: Seal = { kind: 'valid', source: c.source };
    const extra: StepView[] = [sourceStep(c)];
    if (request) {
      const inv = await checkInvoice(v, request);
      extra.push(
        { id: 'inv-to', label: 'Paid to the address on the request', ok: inv.recipient },
        { id: 'inv-amt', label: inv.amount ? `At least ${zecString(request.amountZat)} ZEC` : `Short by ${zecString(inv.shortBy)} ZEC`, ok: inv.amount },
        { id: 'inv-memo', label: `Memo carries “${request.reference}”`, ok: inv.memo },
      );
      seal = !inv.recipient ? { kind: 'wrong' } : !inv.amount ? { kind: 'short' } : !inv.memo ? { kind: 'memo' } : { kind: 'paid' };
    }
    const explorer = explorerUrl(v.network, v.txid);
    body.replaceChildren(
      certificate(v, seal, { height: c.tx?.height, time: c.tx?.time, confirmations: c.tx?.confirmations, chit, specimen: c.source === 'specimen' }),
      h('div', { class: 'side' }, checklog('Verification log', report.steps, extra), explorer && c.source === 'chain' ? h('a', { class: 'link small', href: explorer, target: '_blank', rel: 'noreferrer' }, 'Open the transaction on Blockchair ↗') : null),
    );
  }
  run();
}

function invoiceCard(r: PayRequest) {
  return h(
    'div',
    { class: 'invoice' },
    h('span', { class: 'kicker' }, 'Checking against a payment request'),
    h('div', { class: 'invoice-row' }, h('div', {}, h('span', { class: 'kicker' }, 'Amount'), zec(r.amountZat, 'amount md')), h('div', {}, h('span', { class: 'kicker' }, 'Reference'), h('b', { class: 'mono' }, r.reference)), h('div', { class: 'grow' }, h('span', { class: 'kicker' }, 'To'), h('span', { class: 'mono small' }, short(r.address, 14, 10)))),
  );
}

function newRequest() {
  const address = h('input', { placeholder: 'Your Unified Address (u1…)', spellcheck: 'false', autocomplete: 'off' });
  const amount = h('input', { placeholder: '0.25', inputmode: 'decimal' });
  const reference = h('input', { placeholder: 'INV-1042', spellcheck: 'false' });
  const label = h('input', { placeholder: 'What it is for (optional)' });
  const out = h('div');
  const err = h('div');
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
            err.replaceChildren();
            const zat = parseZec(amount.value);
            const a = address.value.trim();
            if (!(await zpd.hasOrchardReceiver(a, 'main').catch(() => false))) return err.replaceChildren(errorBox('Use a Unified Address with an Orchard receiver (u1…).', 'Chits prove Orchard and Ironwood payments, so the request must point at a shielded Unified Address. Zodl shows one on its Receive screen.'));
            if (!zat) return err.replaceChildren(errorBox('Enter an amount in ZEC, e.g. 0.25.'));
            if (!reference.value.trim()) return err.replaceChildren(errorBox('Add a reference, such as an invoice number. The payment’s memo must carry it.'));
            const req: PayRequest = { network: 'main', address: a, amountZat: zat, reference: reference.value.trim(), label: label.value.trim() };
            const link = `${base()}#/r/${encodeRequest(req)}`;
            out.replaceChildren(
              h(
                'section',
                { class: 'share' },
                qr(link),
                h('div', { class: 'grow' }, h('h3', {}, 'Send this to your customer'), h('p', { class: 'muted small' }, 'They open it, pay from their wallet with one tap, and send you back their chit. You check it here: right recipient, full amount, reference in the memo.'), h('code', { class: 'code' }, link), h('div', { class: 'row' }, h('button', { class: 'btn primary small', type: 'button', onclick: (ev: Event) => copy(link, ev.currentTarget as HTMLElement) }, 'Copy request link'), h('a', { class: 'btn small', href: link.split(base())[1] }, 'Open as customer'))),
              ),
            );
          },
        },
        h('p', { class: 'eyebrow' }, 'Pay & prove'),
        h('h1', {}, 'Request a payment'),
        h('p', { class: 'muted' }, 'Make a link your customer pays from. Their proof of payment is then checked against exactly what you asked for.'),
        h('label', {}, 'Pay to'),
        address,
        h('div', { class: 'grid2' }, h('div', {}, h('label', {}, 'Amount (ZEC)'), amount), h('div', {}, h('label', {}, 'Reference'), reference)),
        h('label', {}, 'Description'),
        label,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Make request link'),
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                const s = await specimen();
                address.value = s.winner_address;
                amount.value = '15';
                reference.value = 'Track 4';
                label.value = 'Core & Tooling';
              },
            },
            'Fill with the specimen',
          ),
        ),
        err,
      ),
      out,
    ),
  );
}

function requestView(r: PayRequest, raw: string) {
  const uri = zip321(r);
  const input = h('textarea', { rows: '2', placeholder: 'Paste your chit (zout1…) after paying', spellcheck: 'false' });
  const err = h('div');
  shell(
    h(
      'div',
      { class: 'narrow' },
      h(
        'section',
        { class: 'panel request' },
        h('p', { class: 'eyebrow' }, 'Payment request'),
        h('h1', {}, r.label || 'Payment requested'),
        h('div', { class: 'request-body' }, qr(uri, 'qr lg'), h('div', { class: 'grow' }, h('span', { class: 'kicker' }, 'Amount'), h('div', {}, zec(r.amountZat, 'amount lg')), h('span', { class: 'kicker' }, 'Memo'), h('p', { class: 'mono' }, memoFor(r)), h('span', { class: 'kicker' }, 'To'), h('p', { class: 'mono small', title: r.address }, short(r.address, 18, 12)), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: uri }, 'Pay in wallet'), h('button', { class: 'btn', type: 'button', onclick: (e: Event) => copy(uri, e.currentTarget as HTMLElement) }, 'Copy payment URI')))),
        h('p', { class: 'hint' }, 'Scan with Zodl or any ZIP 321 wallet. The amount and memo are filled in for you; keep the memo as it is, it is how the payee matches your payment.'),
      ),
      h(
        'form',
        {
          class: 'panel slim',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const m = input.value.match(CHIT_RE);
            if (!m) return err.replaceChildren(errorBox('That does not look like a chit.'));
            location.hash = `#/v/${m[0].toLowerCase()}/r/${raw}`;
          },
        },
        h('h3', {}, 'Paid? Prove it.'),
        h('p', { class: 'hint' }, h('a', { href: '#/make' }, 'Make a chit'), ' for your payment, paste it here, and send the result to the payee.'),
        input,
        h('div', { class: 'row' }, h('button', { class: 'btn primary small', type: 'submit' }, 'Check my payment against this request')),
        err,
      ),
    ),
  );
}

function newLedger() {
  const title = h('input', { placeholder: 'e.g. Specimen Hackathon · prize payouts' });
  const list = h('textarea', { rows: '6', placeholder: 'Paste chits or chit links, one per line', spellcheck: 'false' });
  const hide = h('input', { type: 'checkbox' });
  const err = h('div');
  shell(
    h(
      'div',
      { class: 'narrow' },
      h(
        'form',
        {
          class: 'panel',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const chits = [...new Set((list.value.match(CHIT_RE) ?? []).map((c) => c.toLowerCase()))];
            if (!chits.length) return err.replaceChildren(errorBox('Paste at least one chit.'));
            location.hash = ledgerLink(chits, title.value.trim(), hide.checked).split('#')[1];
          },
        },
        h('p', { class: 'eyebrow' }, 'Proof of payouts'),
        h('h1', {}, 'Publish a payout ledger'),
        h('p', { class: 'muted' }, 'One page that proves a set of shielded payments and their total, checked line by line in the reader’s browser. Your wallet stays closed: only these outputs are revealed.'),
        h('label', {}, 'Title'),
        title,
        h('label', {}, 'Chits'),
        list,
        h('label', { class: 'inline' }, hide, 'Hide recipient addresses (show amounts and memos only)'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Publish ledger'),
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                const s = await specimen();
                title.value = 'Specimen Hackathon · prize payouts';
                list.value = s.chits.join('\n');
              },
            },
            'Fill with the specimen payouts',
          ),
        ),
        err,
      ),
    ),
  );
}

interface LedgerRow {
  chit: string;
  status: 'checking' | 'valid' | 'specimen' | 'pasted' | 'void' | 'unfetched' | 'duplicate';
  v?: zpd.Verified;
  height?: number | null;
  error?: string;
}

function ledgerView(chits: string[], title: string, hide: boolean) {
  const rows: LedgerRow[] = chits.map((chit) => ({ chit, status: 'checking' }));
  const tbody = h('tbody');
  const totals = h('div', { class: 'ledger-totals' });
  const exportRow = h('div', { class: 'row' });
  shell(
    h(
      'div',
      { class: 'wide' },
      h(
        'article',
        { class: 'ledger-doc' },
        h('div', { class: 'ledger-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Proof of payouts'), h('h1', {}, title || 'Shielded payouts'), h('p', { class: 'muted small' }, 'Every line is a chit checked against its transaction in your browser, with the official Zcash crates. Together they prove these payments without opening the payer’s wallet.')), totals),
        h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Paid to'), h('th', {}, 'Memo'), h('th', {}, 'Block'), h('th', { class: 'r' }, 'Amount'), h('th', {}, 'Status'))), tbody),
        exportRow,
      ),
    ),
  );

  const paint = () => {
    tbody.replaceChildren(
      ...rows.map((r) => {
        const tag = { checking: ['Checking', ''], valid: ['Verified', 'ok'], specimen: ['Specimen', 'spec'], pasted: ['Pasted', ''], void: ['Void', 'bad'], unfetched: ['Not found', ''], duplicate: ['Duplicate', 'bad'] }[r.status];
        return h(
          'tr',
          { class: r.status },
          h('td', {}, r.v ? sigilTiny(`${r.v.txid}:${r.v.action}`) : ''),
          h('td', { class: 'mono' }, r.v ? (hide ? 'hidden' : short(r.v.recipient, 10, 6)) : short(r.chit, 12, 6)),
          h('td', {}, r.v ? memoNode(r.v.memo) : r.error ? h('span', { class: 'muted small' }, r.error) : ''),
          h('td', { class: 'mono small' }, r.height ? r.height.toLocaleString('en-US') : r.status === 'specimen' ? 'never mined' : '—'),
          h('td', { class: 'r' }, r.v ? zec(r.v.value_zat, 'amount sm') : ''),
          h('td', {}, h('a', { class: `tag ${tag[1]}`, href: `#/v/${r.chit}` }, tag[0])),
        );
      }),
    );
    const counted = rows.filter((r) => r.v && (r.status === 'valid' || r.status === 'specimen' || r.status === 'pasted'));
    const sum = counted.reduce((a, r) => a + r.v!.value_zat, 0);
    const done = rows.every((r) => r.status !== 'checking');
    totals.replaceChildren(h('span', { class: 'kicker' }, done ? `${counted.length} of ${rows.length} verified` : 'Checking…'), zec(sum, 'amount lg'));
    if (rows.some((r) => r.status === 'specimen')) totals.append(h('span', { class: 'tag spec' }, 'Specimen · not on chain'));
    if (done) {
      exportRow.replaceChildren(
        h('button', { class: 'btn small', type: 'button', onclick: () => download('payouts.csv', toCsv(rows, hide), 'text/csv') }, 'Export CSV'),
        h('button', { class: 'btn small', type: 'button', onclick: () => download('payouts.json', JSON.stringify(rows.map((r) => ({ chit: r.chit, status: r.status, ...(r.v ? { txid: r.v.txid, action: r.v.action, pool: r.v.pool, value_zat: r.v.value_zat, recipient: hide ? null : r.v.recipient, memo: r.v.memo } : {}), height: r.height ?? null })), null, 2), 'application/json') }, 'Export JSON'),
        h('button', { class: 'btn small', type: 'button', onclick: (e: Event) => copy(location.href, e.currentTarget as HTMLElement) }, 'Copy ledger link'),
      );
    }
  };
  paint();

  const seen = new Set<string>();
  rows.forEach(async (r) => {
    try {
      const c = await checkChit(r.chit);
      if (c.report.verified) {
        const key = `${c.report.verified.txid}:${c.report.verified.action}`;
        r.v = c.report.verified;
        r.height = c.tx?.height;
        r.status = seen.has(key) ? 'duplicate' : c.source === 'chain' ? 'valid' : c.source;
        seen.add(key);
      } else {
        r.status = 'void';
        r.error = c.report.error ?? undefined;
      }
    } catch (err) {
      r.status = err instanceof ChainError ? 'unfetched' : 'void';
      r.error = err instanceof Error ? err.message : String(err);
    }
    paint();
  });
}

function sigilTiny(seed: string) {
  const el = document.createElement('span');
  el.className = 'sigil-tiny';
  import('./cert').then(({ sigil }) => el.append(sigil(seed)));
  return el;
}

function toCsv(rows: LedgerRow[], hide: boolean) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [['status', 'amount_zec', 'recipient', 'memo', 'txid', 'output', 'block', 'chit'].join(',')];
  for (const r of rows) {
    lines.push([r.status, r.v ? zecString(r.v.value_zat) : '', r.v && !hide ? r.v.recipient : '', r.v?.memo.kind === 'text' ? esc(r.v.memo.value) : '', r.v?.txid ?? '', r.v?.action ?? '', r.height ?? '', r.chit].join(','));
  }
  return lines.join('\n') + '\n';
}

function download(name: string, body: string, type: string) {
  const a = h('a', { href: URL.createObjectURL(new Blob([body], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function dev() {
  const snippet = (code: string) => h('pre', { class: 'code block' }, h('code', {}, code), h('button', { class: 'btn tiny', type: 'button', onclick: (e: Event) => copy(code, e.currentTarget as HTMLElement) }, 'Copy'));
  shell(
    h(
      'div',
      { class: 'narrow dev' },
      h('p', { class: 'eyebrow' }, 'Developer kit'),
      h('h1', {}, 'Verify chits in your own product'),
      h('p', { class: 'muted' }, 'One Rust crate, built on the official Zcash crates, shipped three ways. Nothing in it touches the network: you fetch the transaction, it checks the chit.'),
      h('h2', {}, 'Embed a badge'),
      h('p', { class: 'muted' }, 'Show a live, self-verifying proof of payment on any page: a receipt page, a grants report, a prize announcement.'),
      snippet(`<script type="module" src="${base()}embed.js"></script>\n<chit-verify chit="zout1…"></chit-verify>`),
      h('div', { class: 'embed-demo', id: 'embed-demo' }),
      h('h2', {}, 'JavaScript and TypeScript'),
      snippet(`npm install ./chit-zcash-0.1.0.tgz   # from the GitHub release\n\nimport { ready, verify } from 'chit-zcash';\nawait ready();\nconst report = verify(rawTxHex, 'zout1…');\nif (report.valid) console.log(report.verified.value_zat, report.verified.memo);`),
      h('h2', {}, 'Command line'),
      snippet('cargo install --git https://github.com/neromtoobad/chit chit-cli\nchit make <txid> --key-file my.ufvk\nchit check zout1…'),
      h('h2', {}, 'Rust'),
      snippet('let tx = chit_core::parse_tx(&raw)?;\nlet report = chit_core::verify_with_steps(&tx, &Disclosure::decode(chit)?);\nfor step in &report.steps { println!("{:?} {}", step.ok, step.label); }'),
      h('h2', {}, 'The format'),
      h('p', { class: 'muted' }, 'Bech32m, prefix zout (mainnet) or zouttest. Version byte, pool and kind flags, output index, txid, then either the 32-byte ock (payer) or the 64-byte pk_d ‖ esk (payee). The full proposed ZIP 311 text, with test vectors, is in the repository.'),
      h('a', { class: 'btn', href: 'https://github.com/neromtoobad/chit/blob/main/docs/zip-0311-orchard-ironwood.md', target: '_blank', rel: 'noreferrer' }, 'Read the spec ↗'),
    ),
  );
  specimen().then((s) => {
    const demo = document.getElementById('embed-demo');
    if (!demo) return;
    import('./embed').then(() => demo.append(h('chit-verify' as keyof HTMLElementTagNameMap, { chit: s.chits[2] })));
  });
}

function render() {
  const r = route();
  if (r.view === 'make') make();
  else if (r.view === 'check') check();
  else if (r.view === 'verify') verifyView(r.chit, r.request);
  else if (r.view === 'newRequest') newRequest();
  else if (r.view === 'request') requestView(r.request, r.raw);
  else if (r.view === 'newLedger') newLedger();
  else if (r.view === 'ledger') ledgerView(r.chits, r.title, r.hide);
  else if (r.view === 'dev') dev();
  else if (r.view === 'burn') burnbook.wallView(shell, r.tab);
  else if (r.view === 'burnNew') burnbook.composeView(shell, r.preset);
  else if (r.view === 'burnPost') burnbook.postView(shell, r.id);
  else if (r.view === 'burnClaim') burnbook.claimView(shell);
  else if (r.view === 'burnProof') burnbook.proofView(shell);
  else home();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
