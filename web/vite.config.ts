import { defineConfig, type Plugin } from 'vite';

// The production page may talk to one host: the public explorer it fetches transactions
// from. The dev server needs its HMR socket too, so the policy is only added at build.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.blockchair.com",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer"`),
});

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [cspPlugin()],
  build: { target: 'es2022' },
});
