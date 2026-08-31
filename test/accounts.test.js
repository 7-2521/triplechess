import assert from 'node:assert/strict';
import test from 'node:test';
import { Ratings } from '../src/server/ratings.js';
import {
  Accounts,
  parseCookies,
  sessionCookie,
  clearedCookie,
  validateUsername,
  validatePassword,
  isAccountId,
  isGuestId,
} from '../src/server/accounts.js';

function fresh() {
  const ratings = new Ratings({ dir: null });
  return { ratings, accounts: new Accounts(ratings) };
}

test('usernames and passwords are validated', () => {
  assert.equal(validateUsername('jeremy').value, 'jeremy');
  assert.equal(validateUsername('a_b-9').value, 'a_b-9');
  assert.ok(validateUsername('ab').error, 'too short');
  assert.ok(validateUsername('x'.repeat(21)).error, 'too long');
  assert.ok(validateUsername('has space').error);
  assert.ok(validateUsername('bad!char').error);

  assert.equal(validatePassword('longenough').value, 'longenough');
  assert.ok(validatePassword('short').error);
  assert.ok(validatePassword('x'.repeat(500)).error);
});

test('registering creates an account with a prefixed id at 1200', () => {
  const { accounts, ratings } = fresh();
  const result = accounts.register('Jeremy', 'hunter2hunter2');
  assert.equal(result.username, 'Jeremy');
  assert.ok(isAccountId(result.id), 'account ids are prefixed');
  assert.equal(ratings.peek(result.id).rating, 1200);
  assert.equal(ratings.peek(result.id).username, 'Jeremy');
});

test('passwords are never stored in the clear', () => {
  const { accounts, ratings } = fresh();
  const { id } = accounts.register('someone', 'correct-horse');
  const record = ratings.players.get(id);
  assert.ok(record.passwordHash, 'a hash is stored');
  assert.notEqual(record.passwordHash, 'correct-horse');
  assert.ok(record.salt, 'with a salt');
  assert.equal(JSON.stringify(record).includes('correct-horse'), false);
});

test('two accounts with the same password get different hashes', () => {
  const { accounts, ratings } = fresh();
  const a = accounts.register('alice', 'same-password');
  const b = accounts.register('bob', 'same-password');
  assert.notEqual(
    ratings.players.get(a.id).passwordHash,
    ratings.players.get(b.id).passwordHash,
    'per-user salts',
  );
});

test('usernames are unique regardless of case', () => {
  const { accounts } = fresh();
  accounts.register('Jeremy', 'hunter2hunter2');
  assert.match(accounts.register('JEREMY', 'otherpassword').error, /taken/i);
});

test('login works case-insensitively and rejects a bad password', () => {
  const { accounts } = fresh();
  const created = accounts.register('Jeremy', 'hunter2hunter2');
  const ok = accounts.login('jErEmY', 'hunter2hunter2');
  assert.equal(ok.id, created.id);
  assert.match(accounts.login('Jeremy', 'wrongpassword').error, /incorrect/i);
});

test('an unknown user and a wrong password are indistinguishable', () => {
  const { accounts } = fresh();
  accounts.register('realuser', 'hunter2hunter2');
  const missing = accounts.login('ghost', 'hunter2hunter2').error;
  const wrong = accounts.login('realuser', 'nottherightone').error;
  assert.equal(missing, wrong, 'so usernames cannot be probed');
});

test('repeated failures are rate limited', () => {
  const { accounts } = fresh();
  accounts.register('target', 'hunter2hunter2');
  for (let i = 0; i < 8; i++) accounts.login('target', `guess-${i}`, '1.2.3.4');
  const blocked = accounts.login('target', 'hunter2hunter2', '1.2.3.4');
  assert.match(blocked.error, /too many attempts/i, 'even a correct password waits');

  // A different address is unaffected.
  assert.ok(accounts.login('target', 'hunter2hunter2', '5.6.7.8').id);
});

test('a successful login clears the failure count', () => {
  const { accounts } = fresh();
  accounts.register('target', 'hunter2hunter2');
  for (let i = 0; i < 3; i++) accounts.login('target', 'nope', '1.1.1.1');
  assert.ok(accounts.login('target', 'hunter2hunter2', '1.1.1.1').id);
  for (let i = 0; i < 7; i++) accounts.login('target', 'nope', '1.1.1.1');
  assert.ok(accounts.login('target', 'hunter2hunter2', '1.1.1.1').id, 'count was reset');
});

test('session tokens round-trip and reject tampering', () => {
  const { accounts } = fresh();
  const { id } = accounts.register('jeremy', 'hunter2hunter2');
  const token = accounts.issueToken(id);

  assert.equal(accounts.verifyToken(token), id);
  assert.equal(accounts.verifyToken(token.slice(0, -2) + 'xx'), null, 'bad signature');
  assert.equal(accounts.verifyToken('nonsense'), null);
  assert.equal(accounts.verifyToken(''), null);
  assert.equal(accounts.verifyToken(undefined), null);

  // Forging a different id invalidates the signature.
  const [, expires, signature] = token.split('.');
  assert.equal(accounts.verifyToken(`u:someone-else.${expires}.${signature}`), null);
});

test('expired tokens are refused', () => {
  const { accounts } = fresh();
  const { id } = accounts.register('jeremy', 'hunter2hunter2');
  const past = Date.now() - 1000;
  const payload = `${id}.${past}`;
  const expired = `${payload}.${accounts.sign(payload)}`;
  assert.equal(accounts.verifyToken(expired), null);
});

test('a token for a deleted account is refused', () => {
  const { accounts, ratings } = fresh();
  const { id } = accounts.register('jeremy', 'hunter2hunter2');
  const token = accounts.issueToken(id);
  ratings.players.delete(id);
  assert.equal(accounts.verifyToken(token), null);
});

test('the signing secret is stable across Accounts instances', () => {
  const { ratings, accounts } = fresh();
  const { id } = accounts.register('jeremy', 'hunter2hunter2');
  const token = accounts.issueToken(id);
  // A restart rebuilds Accounts from the same persisted ratings store.
  const afterRestart = new Accounts(ratings);
  assert.equal(afterRestart.verifyToken(token), id, 'sessions survive a restart');
});

test('guest ids and account ids are distinguishable', () => {
  assert.equal(isGuestId('g:abc'), true);
  assert.equal(isAccountId('g:abc'), false);
  assert.equal(isAccountId('u:abc'), true);
  assert.equal(isGuestId('u:abc'), false);
  assert.equal(isGuestId('abc'), false, 'unprefixed ids are not accepted as guests');
});

test('cookies are parsed and issued safely', () => {
  const jar = parseCookies('a=1; tc_session=abc%2Fdef; b=2');
  assert.equal(jar.tc_session, 'abc/def');
  assert.equal(jar.a, '1');
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('garbage'), {});

  const cookie = sessionCookie('tok', { secure: true });
  assert.match(cookie, /HttpOnly/, 'not readable from JavaScript');
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(sessionCookie('tok', { secure: false }).includes('Secure'), false);
  assert.match(clearedCookie({ secure: false }), /Max-Age=0/);
});

test('an account keeps its rating history when it signs in again', () => {
  const { accounts, ratings } = fresh();
  const { id } = accounts.register('jeremy', 'hunter2hunter2');
  ratings.applyResult({
    playerIds: { white: id, black: 'g:someone' },
    playerNames: { white: 'jeremy', black: 'Guest' },
    result: '1-0',
    rated: false,
  });
  assert.equal(ratings.peek(id).rating, 1220);

  const again = accounts.login('jeremy', 'hunter2hunter2');
  assert.equal(again.id, id);
  assert.equal(ratings.peek(again.id).rating, 1220, 'rating follows the account');
});
