// Masks: pseudonymous Burn Book identities.
//
// A mask is an Ed25519 key that lives only in this browser. Signing a burn appends one
// line to its memo:
//
//   ~<public key, base64url, 43 chars>.<signature over everything before it, 86 chars>
//
// Anyone can check the signature, so a mask's posts and its total ZEC burned are provably
// its own, while nothing links the mask to the wallet that paid. Losing the key loses the
// mask; exporting it is the only backup.

import { ed25519 } from '@noble/curves/ed25519';

const KEY = 'chit.burnbook.mask';
export const SIG_BYTES = 132; // "\n~" + 43 + "." + 86

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);

export interface Mask {
  secret: string;
  pub: string;
}

export function myMask(): Mask | null {
  try {
    const secret = localStorage.getItem(KEY);
    if (!secret) return null;
    return { secret, pub: b64url(ed25519.getPublicKey(unb64url(secret))) };
  } catch {
    return null;
  }
}

export function newMask(): Mask {
  const sk = ed25519.utils.randomPrivateKey();
  const secret = b64url(sk);
  try {
    localStorage.setItem(KEY, secret);
  } catch {
    /* private mode: the mask lasts for this visit */
  }
  return { secret, pub: b64url(ed25519.getPublicKey(sk)) };
}

export function importMask(secret: string): Mask {
  const sk = unb64url(secret.trim());
  if (sk.length !== 32) throw new Error('A mask key is 43 characters.');
  localStorage.setItem(KEY, secret.trim());
  return { secret: secret.trim(), pub: b64url(ed25519.getPublicKey(sk)) };
}

export function dropMask() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** Appends a mask signature line to a memo body. */
export function sign(body: string, mask: Mask): string {
  const sig = ed25519.sign(utf8(body), unb64url(mask.secret));
  return `${body}\n~${mask.pub}.${b64url(sig)}`;
}

/** Splits a memo into its body and, if the signature checks out, the signing mask. */
export function verifySigned(memo: string): { body: string; mask: string | null } {
  const m = memo.match(/^([\s\S]*)\n~([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{86})$/);
  if (!m) return { body: memo, mask: null };
  try {
    return ed25519.verify(unb64url(m[3]), utf8(m[1]), unb64url(m[2])) ? { body: m[1], mask: m[2] } : { body: memo, mask: null };
  } catch {
    return { body: memo, mask: null };
  }
}

const ADJ = ['Ashen', 'Silent', 'Hollow', 'Velvet', 'Feral', 'Lucid', 'Gilded', 'Rogue', 'Quiet', 'Molten', 'Paper', 'Hidden', 'Wired', 'Lunar', 'Static', 'Crimson', 'Shielded', 'Nameless', 'Veiled', 'Burnt', 'Cold', 'Sly', 'Grim', 'Bright', 'Dusky', 'Iron', 'Glass', 'Saint', 'Wild', 'Night', 'Prime', 'Last'];
const NOUN = ['Moth', 'Oracle', 'Ember', 'Cipher', 'Raven', 'Ghost', 'Fox', 'Monk', 'Viper', 'Lantern', 'Pilgrim', 'Witness', 'Heron', 'Jackal', 'Saint', 'Wolf', 'Owl', 'Coyote', 'Specter', 'Herald', 'Mask', 'Hermit', 'Rook', 'Wren', 'Shade', 'Comet', 'Kestrel', 'Phantom', 'Lynx', 'Vandal', 'Poet', 'Sphinx'];

/** A stable, human name for a mask's public key. */
export function maskName(pub: string): string {
  const b = unb64url(pub);
  return `${ADJ[b[0] % ADJ.length]} ${NOUN[b[1] % NOUN.length]} ·${pub.slice(2, 6)}`;
}
