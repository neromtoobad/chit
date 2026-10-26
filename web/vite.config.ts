import { defineConfig, type Plugin } from 'vite';

// The production page may talk to one host: the public explorer it fetches transactions
// from. The dev server needs its HMR socket too, so the policy is only added at build.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.blockchair.com https://api.drand.sh",
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
  // No data: URIs, so the font-src 'self' policy holds for every asset.
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      // The app, plus the <chit-verify> badge at a stable URL other sites can load.
      input: { main: 'index.html', embed: 'src/embed.ts' },
      output: { entryFileNames: (c) => (c.name === 'embed' ? 'embed.js' : 'assets/[name]-[hash].js') },
    },
  },
});
