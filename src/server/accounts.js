import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
  randomUUID,
} from 'node:crypto';

// Account ids are prefixed so a client-supplied guest id can never collide
// with (or impersonate) a real account.
export const ACCOUNT_PREFIX = 'u:';
export const GUEST_PREFIX = 'g:';

const SCRYPT_KEYLEN = 64;
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'tc_session';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// Simple brute-force brake: attempts are counted per username and per IP.
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function isAccountId(id) {
  return typeof id === 'string' && id.startsWith(ACCOUNT_PREFIX);
}

export function isGuestId(id) {
  return typeof id === 'string' && id.startsWith(GUEST_PREFIX);
}

export function validateUsername(username) {
  const value = String(username ?? '').trim();
  if (!USERNAME_RE.test(value)) {
    return { error: 'Usernames are 3-20 characters: letters, numbers, _ or -.' };
  }
  return { value };
}

export function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD) {
    return { error: `Passwords must be at least ${MIN_PASSWORD} characters.` };
  }
  if (value.length > MAX_PASSWORD) return { error: 'That password is too long.' };
  return { value };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, SCRYPT_KEYLEN).toString('base64');
}

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Username/password accounts layered over the ratings store: an account is
 * simply a player record that also carries credentials, so a player's rating
 * follows them across browsers and devices once they sign in.
 *
 * Sessions are stateless HMAC-signed tokens, so they survive a restart without
 * needing to be stored or swept.
 */
export class Accounts {
  /** @param {import('./ratings.js').Ratings} ratings */
  constructor(ratings) {
    this.ratings = ratings;
    this.attempts = new Map(); // key -> { count, first }
  }

  /** Signing secret lives with the data so logins survive a restart. */
  get secret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    if (!this.ratings.secret) {
      this.ratings.secret = randomBytes(32).toString('base64url');
      this.ratings.scheduleSave();
    }
    return this.ratings.secret;
  }

  findByUsername(username) {
    const lower = String(username ?? '').toLowerCase();
    for (const [id, player] of this.ratings.players) {
      if (player.usernameLower === lower) return { id, player };
    }
    return null;
  }

  register(username, password) {
    const name = validateUsername(username);
    if (name.error) return { error: name.error };
    const pass = validatePassword(password);
    if (pass.error) return { error: pass.error };
    if (this.findByUsername(name.value)) return { error: 'That username is taken.' };

    const salt = randomBytes(16).toString('base64');
    const id = ACCOUNT_PREFIX + randomUUID();
    const player = this.ratings.get(id, name.value);
    player.username = name.value;
    player.usernameLower = name.value.toLowerCase();
    player.salt = salt;
    player.passwordHash = hashPassword(pass.value, salt);
    player.createdAt = Date.now();
    this.ratings.scheduleSave();

    return { id, username: player.username, player };
  }

  /** @param {string} ip used only for rate limiting */
  login(username, password, ip = '') {
    const limitKey = `${String(username).toLowerCase()}|${ip}`;
    if (this.isLockedOut(limitKey)) {
      return { error: 'Too many attempts. Please wait a few minutes and try again.' };
    }

    const found = this.findByUsername(username);
    // Same message either way, so usernames cannot be probed.
    const generic = { error: 'Incorrect username or password.' };
    if (!found || !found.player.passwordHash) {
      this.noteFailure(limitKey);
      return generic;
    }
    const attempt = hashPassword(String(password ?? ''), found.player.salt);
    if (!safeEqual(attempt, found.player.passwordHash)) {
      this.noteFailure(limitKey);
      return generic;
    }

    this.attempts.delete(limitKey);
    return { id: found.id, username: found.player.username, player: found.player };
  }

  isLockedOut(key) {
    const record = this.attempts.get(key);
    if (!record) return false;
    if (Date.now() - record.first > ATTEMPT_WINDOW_MS) {
      this.attempts.delete(key);
      return false;
    }
    return record.count >= MAX_ATTEMPTS;
  }

  noteFailure(key) {
    const record = this.attempts.get(key);
    if (!record || Date.now() - record.first > ATTEMPT_WINDOW_MS) {
      this.attempts.set(key, { count: 1, first: Date.now() });
      return;
    }
    record.count += 1;
  }

  // --- sessions ------------------------------------------------------------

  issueToken(id) {
    const expires = Date.now() + SESSION_MS;
    const payload = `${id}.${expires}`;
    return `${payload}.${this.sign(payload)}`;
  }

  sign(payload) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  /** @returns {string|null} the account id a token proves, if any */
  verifyToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [id, expires, signature] = parts;
    if (!safeEqual(signature, this.sign(`${id}.${expires}`))) return null;
    if (!Number(expires) || Number(expires) < Date.now()) return null;
    if (!isAccountId(id) || !this.ratings.players.has(id)) return null;
    return id;
  }
}

/** Minimal Cookie header parser — avoids pulling in a dependency. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* malformed cookie value — ignore it */
    }
  }
  return out;
}

export function sessionCookie(token, { secure }) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearedCookie({ secure }) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
