import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

// Exercise the production TypeScript without requiring a generated WASM package.
// Amount tests never call receiver verification; fail loudly if that changes.
async function moduleAt(path, globals = {}) {
  const context = vm.createContext({ TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, setTimeout, ...globals });
  const source = stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'));
  const mod = new vm.SourceTextModule(source, { context, initializeImportMeta(meta) { meta.url = 'https://chit.example/src/chain.ts'; } });
  await mod.link(() => new vm.SyntheticModule(['sameReceiver'], function () {
    this.setExport('sameReceiver', () => { throw new Error('Unexpected cryptographic call'); });
  }, { context }));
  await mod.evaluate();
  return mod.namespace;
}

const request = await moduleAt('../src/request.ts');

test('ZEC parsing preserves exact zatoshis and rejects unsafe or impossible amounts', () => {
  for (const [input, expected] of [['0.00000001', 1], [' 1.23456789 ', 123456789], ['21000000', 2100000000000000]]) {
    assert.equal(request.parseZec(input), expected);
    assert.equal(request.parseZec(request.zecString(expected)), expected);
  }
  for (const input of ['0', '-1', 'NaN', 'Infinity', '1e2', '1.000000001', '21000000.00000001', '90071992.54740993', '99999999.99999999']) {
    assert.equal(request.parseZec(input), null, input);
  }
});

test('decoded requests reject invalid amount boundaries', () => {
  const encode = (z) => btoa(JSON.stringify({ n: 'main', a: 'address', z, r: 'INV-1' }));
  for (const amount of [0, -1, 0.5, 2100000000000001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(request.decodeRequest(encode(amount)), null, String(amount));
  }
  assert.equal(request.decodeRequest(encode(1)).amountZat, 1);
  assert.equal(request.decodeRequest(encode(2100000000000000)).amountZat, 2100000000000000);
});

// Minimal asynchronous IndexedDB boundary: use real cache and source-selection code.
function storage(entries = new Map()) {
  const database = { transaction() { return { objectStore() { return {
    get(key) { const req = {}; queueMicrotask(() => { req.result = entries.get(key); req.onsuccess(); }); return req; },
    put(value, key) { entries.set(key, value); },
  }; } }; } };
  return { entries, indexedDB: { open() { const req = { result: database }; queueMicrotask(() => req.onsuccess()); return req; } } };
}

test('browser cache isolates networks, ignores legacy entries and clears confirmations', async () => {
  const txid = 'ab'.repeat(32);
  const cache = storage(new Map([[txid, { hex: 'legacy', height: 10, source: 'old' }]]));
  const chain = await moduleAt('../src/chain.ts', { indexedDB: cache.indexedDB, fetch: async (url) => {
    if (String(url).endsWith('/v1/health')) return { ok: false };
    if (String(url).includes('/raw/')) return { ok: true, json: async () => ({ data: { [txid]: { raw_transaction: 'main-hex' } }, context: { state: 20 } }) };
    return { ok: true, json: async () => ({ data: { [txid]: { transaction: { block_id: 10 } } } }) };
  } });
  assert.equal((await chain.fetchTx('main', txid.toUpperCase())).hex, 'main-hex');
  // Let the intentionally asynchronous cache write settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.entries.get(`main:${txid}`).hex, 'main-hex');
  await assert.rejects(chain.fetchTx('test', txid), /testnet/);
  const hit = await chain.fetchTx('main', txid);
  assert.equal(hit.confirmations, null);
  assert.match(hit.source, /cached/);
});

test('browser continues without IndexedDB and never caches unmined transactions', async () => {
  const txid = 'cd'.repeat(32);
  const cache = storage();
  let requests = 0;
  const fetch = async (url) => {
    if (String(url).endsWith('/v1/health')) return { ok: false };
    requests++;
    return { ok: true, json: async () => ({ data: { [txid]: { raw_transaction: 'mempool' } } }) };
  };
  const chain = await moduleAt('../src/chain.ts', { indexedDB: cache.indexedDB, fetch });
  const first = chain.fetchTx('main', txid);
  assert.equal(first, chain.fetchTx('main', txid.toUpperCase()));
  assert.equal((await first).hex, 'mempool');
  await chain.fetchTx('main', txid);
  assert.equal(cache.entries.size, 0);
  assert.equal(requests, 4);
  const uncached = await moduleAt('../src/chain.ts', { fetch });
  assert.equal((await uncached.fetchTx('main', txid)).hex, 'mempool');
  await assert.rejects(uncached.fetchTx('main', 'invalid'), /64 hex/);
});
