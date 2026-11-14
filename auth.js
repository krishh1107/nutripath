// Authentication: Firebase (Google) ID-token verification + app session tokens.
//
// Flow: the browser signs in with Firebase Google popup → POSTs the Firebase ID token to
// /api/auth/login → we verify its RS256 signature against Google's published certs, then
// issue our own HMAC-signed session token that the client sends as `Authorization: Bearer …`.
//
// When FIREBASE_PROJECT_ID is not configured (local dev / demo) a "demo sign-in" is allowed
// instead, so the app stays usable without a Firebase project. Set ALLOW_DEMO_LOGIN=false
// to forbid that explicitly.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIREBASE = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || (process.env.FIREBASE_PROJECT_ID ? `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com` : ''),
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
};
const firebaseEnabled = Boolean(FIREBASE.apiKey && FIREBASE.projectId);
const demoLoginEnabled = process.env.ALLOW_DEMO_LOGIN
  ? process.env.ALLOW_DEMO_LOGIN === 'true'
  : !firebaseEnabled;

// ---------------------------------------------------------------------------
// Session secret: env, else generated once and persisted to ./data/.session_secret.
// On Render (ephemeral disk) SESSION_SECRET MUST be set, or every restart signs everyone out.
// ---------------------------------------------------------------------------
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(path.resolve(process.env.DB_PATH || './data/nutripath.db')), '.session_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
let SECRET = null;
const secret = () => (SECRET ??= loadSecret());

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const SESSION_DAYS = 30;

function signSession(userId) {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 86400000 }));
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() ? uid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firebase ID token verification (per Firebase docs, without firebase-admin)
// ---------------------------------------------------------------------------
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { keys: null, expires: 0 };

async function googleCerts() {
  if (certCache.keys && Date.now() < certCache.expires) return certCache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Could not fetch Google certs (${res.status})`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  certCache = { keys: await res.json(), expires: Date.now() + maxAge * 1000 };
  return certCache.keys;
}

async function verifyFirebaseIdToken(idToken) {
  if (!firebaseEnabled) throw new Error('Firebase is not configured on the server');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('Unknown token key id');
  const key = new crypto.X509Certificate(pem).publicKey;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('Invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (claims.aud !== FIREBASE.projectId) throw new Error('Token audience mismatch');
  if (claims.iss !== `https://securetoken.google.com/${FIREBASE.projectId}`) throw new Error('Token issuer mismatch');
  if (!claims.sub) throw new Error('Token has no subject');
  if (claims.exp < now - skew) throw new Error('Token expired');
  if (claims.iat > now + skew || (claims.auth_time && claims.auth_time > now + skew)) throw new Error('Token issued in the future');
  return claims; // { sub, email, name, picture, ... }
}

// ---------------------------------------------------------------------------
// Express middleware: attaches req.user or responds 401
// ---------------------------------------------------------------------------
function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const uid = verifySession(token);
      const user = uid && (await db.getUser(uid));
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      req.user = user;
      next();
    } catch (err) {
      next(err); // DB unreachable → JSON 500, not a hung request
    }
  };
}

module.exports = {
  FIREBASE, firebaseEnabled, demoLoginEnabled,
  signSession, verifySession, verifyFirebaseIdToken, requireAuth,
};
