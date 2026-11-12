// PIN for opening the app on this device. The PIN is never stored: only a salted PBKDF2 hash is kept.
const ITER = 150000;
const enc = new TextEncoder();

export const validPin = pin => /^\d{4,6}$/.test(String(pin ?? ''));

async function derive(pin, saltHex, iter) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function makePinRecord(pin) {
  if (!validPin(pin)) throw new Error('The PIN must be 4 to 6 digits.');
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  return { salt, iter: ITER, hash: await derive(pin, salt, ITER) };
}

export async function checkPin(pin, rec) {
  if (!rec) return false;
  const h = await derive(pin, rec.salt, rec.iter);
  // Compare every character, so the time taken does not show how much matched.
  let diff = h.length ^ rec.hash.length;
  for (let i = 0; i < Math.min(h.length, rec.hash.length); i++) diff |= h.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

// Failed attempts: after 5 wrong PINs, wait 30 seconds before the next try.
export function lockoutLeft(state, now = Date.now()) {
  if (state.fails < 5) return 0;
  return Math.max(0, state.until - now);
}
export function registerFailure(state, now = Date.now()) {
  state.fails += 1;
  if (state.fails >= 5) state.until = now + 30000;
  return state;
}
