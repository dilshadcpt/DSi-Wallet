// DSi Digital push relay (Cloudflare Worker). Apps Script calls it with one device's subscription and a reminder.
// It encrypts the reminder (RFC 8291 / 8188) and sends it through the browser's push service (Web Push, VAPID).
// Secrets (set in Cloudflare → Settings → Variables and secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url, same keys as config.js), VAPID_SUBJECT (mailto:you@example.com), RELAY_SECRET

const te = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Signs the VAPID token that proves we are the app owner to the push service.
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const pub = fromB64u(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// Encrypts the text for one device (aes128gcm, RFC 8291).
async function encryptFor(sub, text) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic, ct);
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/send') return new Response('not found', { status: 404 });
    if (req.headers.get('x-relay-secret') !== env.RELAY_SECRET) return new Response('forbidden', { status: 403 });
    const { subscription, payload } = await req.json();
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        Authorization: await vapidAuth(subscription.endpoint, env),
      },
      body: await encryptFor(subscription, JSON.stringify(payload)),
    });
    // 404 or 410 means this device has turned reminders off or removed the app. Apps Script drops it then.
    return new Response(JSON.stringify({ status: res.status }), { status: res.status === 201 ? 200 : res.status, headers: { 'content-type': 'application/json' } });
  },
};
