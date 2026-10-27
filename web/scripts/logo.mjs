// Draws the Chit logo as pixel-exact SVG: the mark (a receipt that is also a faceless
// shielded identity, its right edge dissolving) and a dot-matrix wordmark.
//   node scripts/logo.mjs   -> public/logo.svg, public/mark.svg, public/favicon.svg
import { writeFileSync } from 'node:fs';

const PAPER = '#ece7da';
const INK = '#0b0d0c';
const GREEN = '#7cf5a8';

// Mark, 15 × 16. P paper, E eye, L printed line, G green pixel, . empty.
const MARK = [
  '.PPPPPPPPPP....',
  'PPPPPPPPPPPP...',
  'PPPPPPPPPPPP...',
  'PPPPPPPPPPP.G..',
  'PPPPPPPPPPPP...',
  'PPPEEPPPEEPP.G.',
  'PPPEEPPPEEP....',
  'PPPPPPPPPPPP..G',
  'PPPPPPPPPP.P...',
  'PPLLLLLLPPP..G.',
  'PPPPPPPPPP.....',
  'PPLLLLPPPPP.P..',
  'PPPPPPPPP.P....',
  'PPPPPPPPPPP...G',
  'PPP.PPP.PPP....',
  'PP...P...P.....',
];

const FILL = { P: PAPER, E: INK, L: '#9aa59d', G: GREEN };

function rects(rows, x0 = 0, y0 = 0) {
  let out = '';
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (FILL[c]) out += `<rect x="${x0 + x}" y="${y0 + y}" width="1.02" height="1.02" fill="${FILL[c]}"/>`;
    }),
  );
  return out;
}

// Dot-matrix letters, 5 × 7 (I is 3 wide).
const FONT = {
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
};

function word(text, x0, y0, step, fill) {
  let x = x0;
  let out = '';
  for (const ch of text) {
    const g = FONT[ch];
    g.forEach((row, y) =>
      [...row].forEach((c, i) => {
        if (c === '#') out += `<circle cx="${(x + i * step + step / 2).toFixed(2)}" cy="${(y0 + y * step + step / 2).toFixed(2)}" r="${(step * 0.4).toFixed(2)}" fill="${fill}"/>`;
      }),
    );
    x += (g[0].length + 1) * step;
  }
  return { out, width: x - step - x0 };
}

const svg = (w, h, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"${extra}>${body}</svg>\n`;

// mark alone
writeFileSync(new URL('../public/mark.svg', import.meta.url), svg(15, 16, rects(MARK)));

// favicon: the mark on a dark rounded screen
writeFileSync(new URL('../public/favicon.svg', import.meta.url), svg(24, 24, `<rect width="24" height="24" rx="5" fill="#050806"/>${rects(MARK, 4.5, 4)}`));

// lockup: mark + dot-matrix CHIT, letters as tall as the receipt body (16 units ≈ 7 dots)
const step = 2.1;
const w = word('CHIT', 21, 0.6, step, PAPER);
writeFileSync(new URL('../public/logo.svg', import.meta.url), svg(Math.ceil(21 + w.width + 1), 16, rects(MARK) + w.out));
console.log('wrote mark.svg, favicon.svg, logo.svg');
