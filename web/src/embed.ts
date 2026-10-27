// <chit-verify chit="zout1…">: a self-verifying proof-of-payment badge for any page.
// It runs the same WebAssembly verifier as the app, in the reader's browser.
//
//   <script type="module" src="https://chit.nerom.site/embed.js"></script>
//   <chit-verify chit="zout1…"></chit-verify>
//
// The host page's Content-Security-Policy must allow this script, 'wasm-unsafe-eval', and
// connections to chit.nerom.site and https://api.blockchair.com.

import { fetchTx } from './chain';
import { specimen } from './specimen';
import * as zpd from './zpd';

const css = `
:host{display:inline-block;font:14px/1.45 system-ui,sans-serif;color:#17201b}
a{color:inherit;text-decoration:none}
.b{display:flex;gap:14px;align-items:center;background:#f3eee2;border:1px solid #d9d1bd;border-radius:10px;padding:12px 16px;min-width:300px;position:relative;overflow:hidden}
.b:before{content:'';position:absolute;inset:0;background:repeating-radial-gradient(circle at 85% 40%,transparent 0 6px,rgba(80,130,100,.08) 6px 7px);pointer-events:none}
.s{width:46px;height:46px;flex:none;border-radius:50%;display:grid;place-content:center;font:700 9px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;text-align:center;background:conic-gradient(from 30deg,#a8ffcf,#7ad9ff,#c8a8ff,#ffd59a,#a8ffcf);color:#0d3a24;box-shadow:inset 0 0 0 3px rgba(255,255,255,.6)}
.s.bad{background:#f3d3cf;color:#8a1c14}.s.wait{background:#e5dfcf;color:#6b766e}
.amt{font:600 20px ui-serif,Georgia,serif;letter-spacing:-.01em}
.m{font:12px ui-monospace,monospace;color:#4b574f}
.k{font:10px ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#6b766e}
`;

class ChitVerify extends HTMLElement {
  static observedAttributes = ['chit'];
  #root = this.attachShadow({ mode: 'open' });

  connectedCallback() {
    this.#run();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.#run();
  }

  #paint(seal: string, cls: string, main: string, sub: string, kicker: string) {
    const chit = this.getAttribute('chit') ?? '';
    const href = new URL(`/#/v/${chit}`, import.meta.url).href;
    this.#root.innerHTML = `<style>${css}</style><a class="b" href="${href}" target="_blank" rel="noreferrer"><span class="s ${cls}">${seal}</span><span><div class="k">${kicker}</div><div class="amt">${main}</div><div class="m">${sub}</div></span></a>`;
  }

  async #run() {
    const chit = (this.getAttribute('chit') ?? '').trim();
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    this.#paint('…', 'wait', 'Checking…', 'Verifying in your browser', 'Shielded payment');
    try {
      const head = await zpd.inspect(chit);
      const spec = await specimen().catch(() => null);
      const isSpecimen = spec?.txid === head.txid;
      const tx = isSpecimen ? null : await fetchTx(head.network, head.txid);
      const r = await zpd.verify(tx?.hex ?? spec!.tx, chit);
      if (!r.verified) return this.#paint('Void', 'bad', 'Does not check out', esc(r.error ?? ''), 'Shielded payment');
      const v = r.verified;
      const zec = `${(v.value_zat / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} ZEC`;
      const memo = v.memo.kind === 'text' ? `“${esc(v.memo.value)}”` : 'no memo';
      const unmined = !isSpecimen && !tx?.height;
      this.#paint(isSpecimen ? 'Spec' : unmined ? 'Wait' : 'Valid', unmined ? 'wait' : '', zec, `${memo} · ${v.recipient.slice(0, 10)}…`, isSpecimen ? 'Specimen · not on chain' : unmined ? 'Valid, not mined yet' : `Verified · mined · ${v.pool}`);
    } catch (e) {
      this.#paint('?', 'wait', 'Could not check', esc(e instanceof Error ? e.message : String(e)), 'Shielded payment');
    }
  }
}

if (!customElements.get('chit-verify')) customElements.define('chit-verify', ChitVerify);
