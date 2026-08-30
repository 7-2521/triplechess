// A lightweight, anonymous identity kept in the browser. There are no
// accounts or passwords — this is what ratings are keyed on, so it lives and
// dies with the browser profile.

const KEY = 'triplechess:player';

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
