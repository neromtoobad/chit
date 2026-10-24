import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/fraunces';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './style.css';
import qrcode from 'qrcode-generator';
import { ChainError, explorerUrl, fetchTx, type Network, type TxData } from './chain';
import * as zpd from './zpd';

const NAME = 'Chit';
const app = document.getElementById('app')!;

// Routes live in the URL fragment, which browsers never send to a server, so a shared
// disclosure link reveals nothing to whoever hosts this page.
type Route =
  | { view: 'home' }
  | { view: 'make' }
  | { view: 'check' }
  | { view: 'verify'; disclosure: string }
  | { view: 'ledger'; disclosures: string[]; title: string };

function route(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = h.split('/');
  const tail = decodeURIComponent(rest.join('/'));
  if (head === 'make') return { view: 'make' };
  if (head === 'check') return { view: 'check' };
  if (head === 'v' && tail) return { view: 'verify', disclosure: tail };
  if (head === 'l' && tail) {
    const [list, title = ''] = tail.split('~');
    return { view: 'ledger', disclosures: list.split(',').filter(Boolean), title };
  }
  return { view: 'home' };
}

const linkFor = (d: string) => `${location.origin}${location.pathname}#/v/${d}`;
const ledgerLinkFor = (ds: string[], title: string) =>
  `${location.origin}${location.pathname}#/l/${ds.join(',')}${title ? '~' + encodeURIComponent(title) : ''}`;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null && kid !== false) el.append(kid);
  return el;
}

function zec(zat: number): HTMLElement {
  const whole = Math.floor(zat / 1e8).toLocaleString('en-US');
  const frac = String(zat % 1e8).padStart(8, '0');
  const sig = frac.replace(/0+$/, '');
  const shown = sig.length < 2 ? frac.slice(0, 2) : sig;
  return h('span', { class: 'amount' }, whole, h('span', { class: 'frac' }, '.' + shown), h('span', { class: 'unit' }, ' ZEC'));
}

function short(s: string, head = 10, tail = 8) {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

async function copy(text: string, btn: HTMLButtonElement) {
  await navigator.clipboard.writeText(text);
  const was = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = was), 1400);
}

function memoNode(m: zpd.Memo): Node {
  if (m.kind === 'empty') return h('span', { class: 'muted' }, 'No memo');
  if (m.kind === 'text') return h('span', { class: 'memo-text' }, m.value);
  return h('span', { class: 'mono muted' }, `binary · ${short(m.value, 16, 8)}`);
}

function shell(...kids: Node[]) {
  app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, ''), NAME),
      h(
        'nav',
        {},
        h('a', { href: '#/make', class: route().view === 'make' ? 'on' : '' }, 'Make'),
        h('a', { href: '#/check', class: route().view === 'check' ? 'on' : '' }, 'Check'),
      ),
    ),
    h('main', {}, ...kids),
    h(
      'footer',
      {},
      h('span', {}, 'No server. No account. Keys never leave this tab.'),
      h('a', { href: 'https://zips.z.cash/zip-0311', target: '_blank', rel: 'noreferrer' }, 'ZIP 311'),
    ),
  );
}

// ---------- the slip: one disclosed payment ----------

interface SlipData {
  v: zpd.Verified;
  tx: TxData | null;
}

function slip({ v, tx }: SlipData, status: 'verified' | 'preview' | 'pasted'): HTMLElement {
  const who = v.direction === 'outgoing' ? 'Paid to' : 'Received at';
  const by = v.direction === 'outgoing' ? 'The payer’s viewing key' : 'The payee’s viewing key';
  const explorer = explorerUrl(v.network, v.txid);
  const copyBtn = h('button', { class: 'tiny', onclick: (e: Event) => copy(v.recipient, e.currentTarget as HTMLButtonElement) }, 'Copy');
  return h(
    'article',
    { class: `slip ${status}` },
    h('div', { class: 'slip-head' }, h('span', { class: 'kicker' }, 'Shielded payment'), h('span', { class: 'kicker' }, `${v.pool} · ${v.network === 'main' ? 'mainnet' : 'testnet'}`)),
    h('div', { class: 'slip-amount' }, zec(v.value_zat)),
    status === 'verified'
      ? h('div', { class: 'stamp ok', 'aria-label': 'Verified on chain' }, h('b', {}, 'Valid'), h('span', {}, 'on chain'))
      : status === 'pasted'
        ? h('div', { class: 'stamp ok', 'aria-label': 'Valid for the pasted transaction' }, h('b', {}, 'Valid'), h('span', {}, 'pasted tx'))
        : null,
    h(
      'dl',
      {},
      h('dt', {}, who),
      h('dd', {}, h('span', { class: 'mono addr', title: v.recipient }, short(v.recipient, 14, 10)), copyBtn),
      h('dt', {}, 'Memo'),
      h('dd', {}, memoNode(v.memo)),
      h('dt', {}, 'Transaction'),
      h(
        'dd',
        {},
        explorer
          ? h('a', { class: 'mono', href: explorer, target: '_blank', rel: 'noreferrer' }, short(v.txid, 12, 8))
          : h('span', { class: 'mono' }, short(v.txid, 12, 8)),
        h('span', { class: 'muted' }, ` · output ${v.action}`),
      ),
      tx?.height ? h('dt', {}, 'Mined') : null,
      tx?.height
        ? h('dd', {}, `block ${tx.height.toLocaleString('en-US')}`, tx.time ? h('span', { class: 'muted' }, ` · ${tx.time}`) : '', tx.confirmations ? h('span', { class: 'muted' }, ` · ${tx.confirmations.toLocaleString('en-US')} conf.`) : '')
        : null,
      h('dt', {}, 'Made with'),
      h('dd', {}, by),
    ),
    h(
      'p',
      { class: 'slip-foot' },
      status === 'pasted'
        ? 'Checked against the transaction you pasted. Confirm on your own node that this txid is mined.'
        : 'This proves what one output of this transaction contains. It reveals no other payment, balance or key, and it does not prove who is showing it to you.',
    ),
  );
}

function shareBox(disclosure: string): HTMLElement {
  const url = linkFor(disclosure);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const img = h('div', { class: 'qr' });
  img.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  const linkBtn = h('button', { class: 'primary', onclick: (e: Event) => copy(url, e.currentTarget as HTMLButtonElement) }, 'Copy link');
  const rawBtn = h('button', { onclick: (e: Event) => copy(disclosure, e.currentTarget as HTMLButtonElement) }, 'Copy code');
  return h(
    'section',
    { class: 'share' },
    img,
    h(
      'div',
      {},
      h('h3', {}, 'Share this'),
      h('p', { class: 'muted' }, 'Anyone with the link can check this one payment. The code sits after the #, so no server sees it.'),
      h('code', { class: 'code' }, disclosure),
      h('div', { class: 'row' }, linkBtn, rawBtn, h('a', { class: 'button', href: `#/v/${disclosure}` }, 'Open as checker')),
    ),
  );
}

function errorBox(msg: string, detail?: string) {
  return h('div', { class: 'error' }, h('b', {}, msg), detail ? h('p', {}, detail) : null);
}

// ---------- views ----------

function home() {
  shell(
    h(
      'section',
      { class: 'hero' },
      h('p', { class: 'eyebrow' }, 'Zcash · Orchard & Ironwood'),
      h('h1', {}, 'Prove one shielded payment.', h('br'), h('em', {}, 'Reveal nothing else.')),
      h(
        'p',
        { class: 'lede' },
        'Shielded ZEC hides who paid whom. Sometimes you need to show one payment anyway: to a merchant, a support desk, an accountant, a DAO. ',
        `${NAME} turns a single output into a short code that anyone can check against the chain, without your viewing key and without exposing any other payment.`,
      ),
      h('div', { class: 'row' }, h('a', { class: 'button primary', href: '#/make' }, 'Make a chit'), h('a', { class: 'button', href: '#/check' }, 'Check a chit')),
    ),
    h(
      'section',
      { class: 'how' },
      card('1', 'Pick the payment', 'Paste the transaction ID and your viewing key. The key is used in this tab and then dropped. It is never sent anywhere.'),
      card('2', 'Share one output', 'You get a code for exactly one output: the amount, the recipient and the memo. Payers and payees can both make one.'),
      card('3', 'Anyone checks it', 'The checker decrypts that one output with the code and confirms it matches the transaction on chain. Edit one character and it fails.'),
    ),
    h(
      'section',
      { class: 'facts' },
      h('h2', {}, 'What a chit reveals'),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, ''), h('th', {}, 'Viewing key'), h('th', {}, 'Chit')),
        row('This payment’s amount, recipient and memo', true, true),
        row('Every other payment you ever made or received', true, false),
        row('Your balance', true, false),
        row('Can be turned back into your key', '—', false),
      ),
      h(
        'p',
        { class: 'muted small' },
        'A payer’s chit carries the output’s outgoing cipher key (ock), the mechanism draft ZIP 311 specifies for Sapling. A payee’s chit carries pk_d and esk, which a recipient can rebuild under ZIP 212. Both are checked with the official Zcash crates, compiled to WebAssembly.',
      ),
    ),
  );
}

function card(n: string, title: string, body: string) {
  return h('div', { class: 'card' }, h('span', { class: 'num' }, n), h('h3', {}, title), h('p', {}, body));
}

function row(label: string, key: boolean | string, chit: boolean) {
  const cell = (v: boolean | string) => h('td', { class: v === true ? 'yes' : v === false ? 'no' : '' }, v === true ? 'Yes' : v === false ? 'No' : v);
  return h('tr', {}, h('td', {}, label), cell(key), cell(chit));
}

function make() {
  let network: Network = 'main';
  const txid = h('input', { id: 'txid', placeholder: 'Transaction ID (64 hex characters)', spellcheck: 'false', autocomplete: 'off' });
  const rawTx = h('textarea', { id: 'raw', placeholder: 'Raw transaction hex', spellcheck: 'false', rows: '4' });
  const rawWrap = h('div', { class: 'raw hidden' }, h('label', { for: 'raw' }, 'Raw transaction'), rawTx, h('p', { class: 'muted small' }, 'Use this offline, on testnet, or if you do not want the explorer to see this txid.'));
  const rawToggle = h('button', { class: 'link', type: 'button', onclick: () => rawWrap.classList.toggle('hidden') }, 'Paste the raw transaction instead');
  const key = h('input', { id: 'ufvk', type: 'password', placeholder: 'uview1…', spellcheck: 'false', autocomplete: 'off' });
  const net = h(
    'select',
    { id: 'net', onchange: (e: Event) => (network = (e.target as HTMLSelectElement).value as Network) },
    h('option', { value: 'main' }, 'Mainnet'),
    h('option', { value: 'test' }, 'Testnet'),
  );
  const go = h('button', { class: 'primary', type: 'submit' }, 'Find my outputs');
  const out = h('div', { class: 'results' });

  const form = h(
    'form',
    {
      class: 'panel',
      autocomplete: 'off',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        go.disabled = true;
        go.textContent = 'Looking…';
        out.replaceChildren();
        const ufvk = key.value;
        key.value = ''; // the key lives only for this call
        try {
          if (!ufvk.trim()) throw new ChainError('Paste your viewing key (Unified Full Viewing Key, uview1…).');
          let tx: TxData | null = null;
          let hex = rawTx.value.trim();
          if (!hex) {
            tx = await fetchTx(network, txid.value.trim().toLowerCase());
            hex = tx.hex;
          }
          const found = await zpd.scan(hex, ufvk, network);
          const id = await zpd.txidOf(hex);
          showFound(out, found, network, id, tx);
        } catch (err) {
          out.replaceChildren(errorBox(err instanceof Error ? err.message : String(err)));
        } finally {
          go.disabled = false;
          go.textContent = 'Find my outputs';
        }
      },
    },
    h('h1', {}, 'Make a chit'),
    h('p', { class: 'muted' }, 'Find the outputs of one of your transactions, then share exactly one of them.'),
    h('label', { for: 'txid' }, 'Transaction'),
    h('div', { class: 'row tight' }, txid, net),
    rawToggle,
    rawWrap,
    h('label', { for: 'ufvk' }, 'Your viewing key'),
    key,
    h('p', { class: 'muted small' }, 'Export it from your wallet (Zodl: Settings → Export viewing key). It is used in this tab, cleared from the field straight away, and never sent anywhere. Chit has no server.'),
    h('div', { class: 'row' }, go),
  );
  shell(form, out);
}

function showFound(out: HTMLElement, found: zpd.Found[], network: Network, txid: string, tx: TxData | null) {
  if (!found.length) {
    out.replaceChildren(errorBox('This viewing key has no Orchard or Ironwood outputs in that transaction.', 'Check that it is the wallet that sent or received the payment, and that the payment was shielded.'));
    return;
  }
  const picked = new Set<string>();
  const ledgerBtn = h('button', { disabled: true }, 'Make a ledger of the selected');
  const ledgerTitle = h('input', { placeholder: 'Ledger title (optional)', class: 'grow' });
  ledgerBtn.addEventListener('click', () => {
    location.hash = ledgerLinkFor([...picked], ledgerTitle.value.trim()).split('#')[1];
  });
  const list = found
    .sort((a, b) => Number(a.change) - Number(b.change))
    .map((f) => {
      const label = f.change ? 'Change to yourself' : f.direction === 'outgoing' ? 'You paid' : 'You received';
      const box = h('input', {
        type: 'checkbox',
        onchange: (e: Event) => {
          (e.target as HTMLInputElement).checked ? picked.add(f.disclosure) : picked.delete(f.disclosure);
          ledgerBtn.disabled = picked.size < 1;
        },
      });
      const choose = h('button', { class: 'primary' }, 'Make chit');
      const item = h(
        'div',
        { class: `found ${f.change ? 'change' : ''}` },
        h('label', { class: 'pick' }, box),
        h('div', { class: 'grow' }, h('span', { class: 'kicker' }, `${label} · ${f.pool} output ${f.action}`), h('div', { class: 'found-amount' }, zec(f.value_zat)), h('div', { class: 'muted small mono' }, short(f.recipient, 14, 10)), h('div', { class: 'small' }, memoNode(f.memo))),
        choose,
      );
      choose.addEventListener('click', () => {
        const v: zpd.Verified = { network, txid, pool: f.pool, action: f.action, direction: f.direction, value_zat: f.value_zat, recipient: f.recipient, memo: f.memo };
        out.replaceChildren(slip({ v, tx }, 'preview'), shareBox(f.disclosure), h('button', { class: 'link', onclick: () => showFound(out, found, network, txid, tx) }, '← Back to all outputs'));
        out.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return item;
    });
  out.replaceChildren(
    h('h2', {}, `${found.length} output${found.length > 1 ? 's' : ''} your key can disclose`),
    ...list,
    h('div', { class: 'panel ledger-make' }, h('p', { class: 'muted small' }, 'Paying several people? Tick the outputs and make one ledger page that proves all of them, with a total.'), h('div', { class: 'row tight' }, ledgerTitle, ledgerBtn)),
  );
}

function check() {
  const input = h('textarea', { rows: '3', placeholder: 'Paste a chit code (zout1…) or link', spellcheck: 'false' });
  const err = h('div');
  shell(
    h(
      'form',
      {
        class: 'panel',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const v = input.value.trim();
          const m = v.match(/(zout(?:test)?1[02-9ac-hj-np-z]+)/i);
          if (!m) {
            err.replaceChildren(errorBox('That does not look like a chit.', 'A chit code starts with zout1 (mainnet) or zouttest1 (testnet).'));
            return;
          }
          location.hash = `#/v/${m[1].toLowerCase()}`;
        },
      },
      h('h1', {}, 'Check a chit'),
      h('p', { class: 'muted' }, 'Someone sent you proof of a shielded payment. Paste it here and this page checks it against the transaction on chain.'),
      input,
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Check it')),
      err,
    ),
  );
}

async function verifyOne(disclosure: string, rawHex?: string): Promise<SlipData> {
  const head = await zpd.inspect(disclosure);
  const tx = rawHex ? null : await fetchTx(head.network, head.txid);
  const v = await zpd.verify(rawHex ?? tx!.hex, disclosure);
  return { v, tx };
}

function verifyView(disclosure: string) {
  const body = h('div', { class: 'checking' }, h('p', { class: 'muted' }, 'Checking against the chain…'));
  const offline = h('details', { class: 'offline' }, h('summary', {}, 'Check without the explorer'));
  const raw = h('textarea', { rows: '3', placeholder: 'Raw transaction hex', spellcheck: 'false' });
  offline.append(
    h('p', { class: 'muted small' }, 'The checker fetches the transaction from a public explorer, which learns that someone looked up this txid. To avoid that, fetch the raw transaction from your own node and paste it here.'),
    raw,
    h('button', { onclick: () => run(raw.value.trim()) }, 'Check with this transaction'),
  );
  shell(body, offline);

  async function run(rawHex?: string) {
    body.replaceChildren(h('p', { class: 'muted' }, 'Checking…'));
    try {
      const data = await verifyOne(disclosure, rawHex || undefined);
      body.replaceChildren(slip(data, rawHex ? 'pasted' : 'verified'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ChainError) {
        // Not a verdict: the transaction could not be fetched.
        body.replaceChildren(h('article', { class: 'slip void' }, h('p', { class: 'kicker' }, 'Not checked yet'), h('h3', {}, 'Could not fetch the transaction'), h('p', {}, msg), h('p', { class: 'muted small' }, 'A just-sent payment can take a minute to reach the explorer. You can also paste the raw transaction below.')));
        offline.open = true;
        return;
      }
      body.replaceChildren(
        h('article', { class: 'slip void' }, h('div', { class: 'stamp bad' }, h('b', {}, 'Void')), h('p', {}, 'This chit does not match the transaction it names. It may have been edited, or it was never valid.'), h('p', { class: 'muted small mono' }, msg)),
      );
    }
  }
  run();
}

function ledgerView(disclosures: string[], title: string) {
  const rows = h('tbody');
  const total = h('span', { class: 'muted' }, 'Checking…');
  const status = h('span', { class: 'kicker' }, `0 of ${disclosures.length} checked`);
  shell(
    h(
      'section',
      { class: 'panel ledger' },
      h('p', { class: 'eyebrow' }, 'Payout ledger'),
      h('h1', {}, title || 'Shielded payouts'),
      h('p', { class: 'muted' }, 'Each line is a chit checked against the chain in your browser. Together they prove these payments were made, without showing the payer’s wallet.'),
      h('table', { class: 'ledger-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Paid to'), h('th', {}, 'Memo'), h('th', {}, 'Block'), h('th', { class: 'r' }, 'Amount'), h('th', {}, ''))), rows),
      h('div', { class: 'ledger-total' }, status, h('div', {}, h('span', { class: 'kicker' }, 'Verified total '), total)),
    ),
  );
  let sum = 0;
  let ok = 0;
  let done = 0;
  const seen = new Set<string>();
  disclosures.forEach(async (d) => {
    const tr = h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Checking…'));
    rows.append(tr);
    try {
      const { v, tx } = await verifyOne(d);
      const dup = seen.has(`${v.txid}:${v.action}`);
      seen.add(`${v.txid}:${v.action}`);
      tr.replaceChildren(
        h('td', { class: 'mono' }, short(v.recipient, 10, 6)),
        h('td', {}, memoNode(v.memo)),
        h('td', {}, tx?.height ? tx.height.toLocaleString('en-US') : '—'),
        h('td', { class: 'r' }, zec(v.value_zat)),
        h('td', {}, h('a', { href: `#/v/${d}`, class: dup ? 'tag bad' : 'tag ok' }, dup ? 'Duplicate' : 'Verified')),
      );
      if (!dup) {
        sum += v.value_zat;
        ok++;
      }
    } catch (err) {
      const unchecked = err instanceof ChainError;
      tr.replaceChildren(
        h('td', { colspan: '4', class: 'mono small' }, short(d, 14, 6)),
        h('td', {}, h('span', { class: unchecked ? 'tag' : 'tag bad', title: err instanceof Error ? err.message : '' }, unchecked ? 'Not found' : 'Void')),
      );
    } finally {
      done++;
      status.textContent = `${ok} of ${disclosures.length} verified${done < disclosures.length ? ' so far' : ''}`;
      total.replaceChildren(zec(sum));
    }
  });
}

function render() {
  const r = route();
  if (r.view === 'make') make();
  else if (r.view === 'check') check();
  else if (r.view === 'verify') verifyView(r.disclosure);
  else if (r.view === 'ledger') ledgerView(r.disclosures, r.title);
  else home();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
