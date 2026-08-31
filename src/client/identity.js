// The guest identity: a lightweight anonymous player kept in the browser, used
// when nobody is signed in. Guest ids carry a "g:" prefix that the server
// insists on, so an anonymous client can never claim an account's identity.
// Signing in supersedes this entirely — the server then takes the player id
// from the session cookie and ignores whatever the client sends.

const KEY = 'triplechess:player';
const GUEST_PREFIX = 'g:';

function randomId() {
  const raw = crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return GUEST_PREFIX + raw;
}

function randomName() {
  return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
}

let cached = null;

export function getIdentity() {
  if (cached) return cached;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || !stored.id) {
    stored = { id: randomId(), name: randomName() };
    save(stored);
  } else if (!stored.id.startsWith(GUEST_PREFIX)) {
    // Ids minted before guest prefixes existed.
    stored = { ...stored, id: GUEST_PREFIX + stored.id };
    save(stored);
  }
  cached = stored;
  return cached;
}

export function setName(name) {
  const identity = getIdentity();
  const clean = String(name || '').trim().slice(0, 20);
  identity.name = clean || randomName();
  save(identity);
  return identity;
}

function save(identity) {
  cached = identity;
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* private browsing — identity lasts for this page only */
  }
}
