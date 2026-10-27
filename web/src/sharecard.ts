// Share cards: a 1200×630 image of a Burn Book post, drawn in the browser, for posting
// on X or anywhere else. Nothing is uploaded; the image is a local download.

import { portrait } from './pixel';
import { zecString } from './request';

export interface CardInput {
  text: string;
  zat: number;
  mask: string | null;
  seed: string;
  specimen: boolean;
  kicker: string;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

export async function drawCard(c: CardInput): Promise<HTMLCanvasElement> {
  await Promise.all([document.fonts.load('64px Gloock'), document.fonts.load('600 20px "Geist Mono Variable"')]).catch(() => {});
  const W = 1200;
  const H = 630;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const x = cv.getContext('2d')!;
  // charred ground with an ember glow
  x.fillStyle = '#0d0907';
  x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(W * 0.85, H * 1.05, 20, W * 0.85, H * 1.05, 700);
  g.addColorStop(0, 'rgba(255,110,40,0.55)');
  g.addColorStop(0.45, 'rgba(255,90,30,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.strokeStyle = '#3b281f';
  x.lineWidth = 2;
  x.strokeRect(28, 28, W - 56, H - 56);

  x.fillStyle = '#ff7a3d';
  x.font = '600 20px "Geist Mono Variable", monospace';
  x.fillText(`BURN BOOK · ${c.kicker.toUpperCase()}`, 70, 92);

  // the message, shrinking to fit
  let size = 64;
  let lines: string[] = [];
  for (; size >= 30; size -= 4) {
    x.font = `${size}px Gloock, Georgia, serif`;
    lines = wrap(x, c.text, W - 300);
    if (lines.length * size * 1.18 <= 330) break;
  }
  x.fillStyle = '#f3e9df';
  lines.slice(0, 8).forEach((l, i) => x.fillText(l, 70, 170 + i * size * 1.18));

  // amount burned
  x.font = '76px Gloock, Georgia, serif';
  x.fillStyle = '#ffb36b';
  const amt = `🔥 ${zecString(c.zat)}`;
  x.fillText(amt, 70, H - 82);
  const aw = x.measureText(amt).width;
  x.font = '600 22px "Geist Mono Variable", monospace';
  x.fillStyle = '#c9a58a';
  x.fillText('ZEC BURNED', 86 + aw, H - 88);

  x.font = '600 18px "Geist Mono Variable", monospace';
  x.fillStyle = '#93a097';
  const who = c.mask ? `signed by mask ${c.mask}` : 'nobody knows who';
  x.fillText(`${who}${c.specimen ? ' · SPECIMEN, not on chain' : ''}`, 70, H - 46);
  x.textAlign = 'right';
  x.fillText('chit.nerom.site/#/burn', W - 70, H - 46);
  x.textAlign = 'left';

  // the post's pixel identity, large
  x.imageSmoothingEnabled = false;
  x.drawImage(portrait(c.seed), W - 222, 54, 156, 156);
  return cv;
}

export async function downloadCard(c: CardInput, name: string) {
  const cv = await drawCard(c);
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = name;
  a.click();
}

export function tweetIntent(text: string, url: string) {
  const q = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${q}`;
}
