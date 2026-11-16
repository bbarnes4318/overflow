'use strict';

/**
 * Custom inbox tabs: create / rename / delete, moving many threads at once,
 * and the tenancy boundary around both. Database layer first, then the real
 * server over HTTP.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, seedConversation, utcStamp } = require('../helpers/testdb');
const { startServer } = require('../helpers/testserver');

/* ---------------- database layer ---------------- */

const ctx = freshDb('tabs');
const { tenantId, db, raw } = ctx;
test.after(() => ctx.cleanup());

let seq = 0;
function newConversation(extra = {}) {
  seq++;
  return seedConversation(raw, { tenantId, phone: `+1555333${String(seq).padStart(4, '0')}`, ...extra });
}
const tabOf = id => raw.prepare('SELECT tab_id FROM conversations WHERE id = ?').get(id).tab_id;

test('tabs are created in order, trimmed, and listed per tenant', () => {
  const a = db.createTab(tenantId, '  Medicare   leads ');
  const b = db.createTab(tenantId, 'Callbacks');
  assert.strictEqual(a.name, 'Medicare leads');
  assert.deepStrictEqual(db.getTabs(tenantId).map(t => t.id), [a.id, b.id]);
  assert.ok(b.position > a.position);
});

test('tab names are required, bounded, and unique ignoring case', () => {
  assert.throws(() => db.createTab(tenantId, '   '), /required/);
  assert.throws(() => db.createTab(tenantId, 'x'.repeat(db.TAB_NAME_MAX + 1)), /characters or fewer/);
  db.createTab(tenantId, 'Spanish');
  assert.throws(() => db.createTab(tenantId, 'SPANISH'), /already exists/);
});

test('moving many threads into a tab, and back out', () => {
  const tab = db.createTab(tenantId, 'Bulk');
  const ids = [newConversation(), newConversation(), newConversation({ disposition: 'customer' })];

  const result = db.moveConversationsToTab(tenantId, ids, tab.id);
  assert.deepStrictEqual(result.moved, ids);
  ids.forEach(id => assert.strictEqual(tabOf(id), tab.id));
  // Moving into a tab keeps the disposition.
  assert.strictEqual(db.getConversationById(tenantId, ids[2]).disposition, 'customer');

  db.moveConversationsToTab(tenantId, ids, null);
  ids.forEach(id => assert.strictEqual(tabOf(id), null));
});

test('opted-out and wrong-number contacts are never filed into a tab', () => {
  const tab = db.createTab(tenantId, 'Suppressed check');
  const ok = newConversation();
  const stop = newConversation({ opted_out: 1 });
  const wrong = newConversation({ wrong_number: 1 });
  const result = db.moveConversationsToTab(tenantId, [ok, stop, wrong], tab.id);
  assert.deepStrictEqual(result.moved, [ok]);
  assert.strictEqual(result.skipped_suppressed, 2);
  assert.strictEqual(tabOf(stop), null);
});

test('a disposition takes the thread out of its custom tab', () => {
  const tab = db.createTab(tenantId, 'Dispo check');
  const id = newConversation();
  db.moveConversationsToTab(tenantId, [id], tab.id);
  const updated = db.setConversationDisposition(tenantId, id, 'follow_up', utcStamp(60 * 24));
  assert.strictEqual(updated.tab_id, null);
});

test('renaming and deleting a tab; deletion releases its threads, never deletes them', () => {
  const tab = db.createTab(tenantId, 'Temp');
  assert.strictEqual(db.renameTab(tenantId, tab.id, 'Temporary').name, 'Temporary');
  const ids = [newConversation(), newConversation()];
  db.moveConversationsToTab(tenantId, ids, tab.id);

  const released = db.deleteTab(tenantId, tab.id);
  assert.deepStrictEqual(released.sort(), ids.slice().sort());
  assert.strictEqual(db.getTabById(tenantId, tab.id), null);
  ids.forEach(id => {
    assert.ok(db.getConversationById(tenantId, id), 'conversation survives');
    assert.strictEqual(tabOf(id), null);
  });
});

test('another tenant can neither see, use, rename nor delete a tab', () => {
  const other = ctx.addTenant('Other Agency');
  const mine = db.createTab(tenantId, 'Private');
  const theirConv = seedConversation(raw, { tenantId: other.id, phone: '+15553339999' });

  assert.deepStrictEqual(db.getTabs(other.id), []);
  assert.strictEqual(db.getTabById(other.id, mine.id), null);
  assert.strictEqual(db.renameTab(other.id, mine.id, 'Hijacked'), null);
  assert.strictEqual(db.deleteTab(other.id, mine.id), null);
  assert.throws(() => db.moveConversationsToTab(other.id, [theirConv], mine.id), /Tab not found/);

  // And my move cannot touch their conversation.
  const result = db.moveConversationsToTab(tenantId, [theirConv], mine.id);
  assert.deepStrictEqual(result.moved, []);
  assert.strictEqual(tabOf(theirConv), null);
  assert.strictEqual(db.getTabById(tenantId, mine.id).name, 'Private');
});

/* ---------------- HTTP ---------------- */

let srv;
test.before(async () => {
  srv = await startServer({ label: 'tabs' });
  const signup = await srv.signup();
  assert.strictEqual(signup.status, 200);
});
test.after(async () => { if (srv) await srv.stop(); });

async function makeConversation(phone) {
  const res = await srv.post('/api/conversations', { phone_number: phone });
  assert.strictEqual(res.status, 201, res.text);
  return res.json.id;
}

test('HTTP: create, list, rename and delete tabs', async () => {
  const created = await srv.post('/api/tabs', { name: 'Hot Spanish' });
  assert.strictEqual(created.status, 201, created.text);

  const dup = await srv.post('/api/tabs', { name: 'hot spanish' });
  assert.strictEqual(dup.status, 400);

  const list = await srv.get('/api/tabs');
  assert.deepStrictEqual(list.json.map(t => t.name), ['Hot Spanish']);

  const renamed = await srv.patch(`/api/tabs/${created.json.id}`, { name: 'Spanish' });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.json.name, 'Spanish');

  assert.strictEqual((await srv.patch('/api/tabs/999999', { name: 'x' })).status, 404);
  assert.strictEqual((await srv.del(`/api/tabs/${created.json.id}`)).status, 200);
  assert.strictEqual((await srv.del(`/api/tabs/${created.json.id}`)).status, 404);
});

test('HTTP: move selected threads into a tab and to built-in tabs', async () => {
  const tab = (await srv.post('/api/tabs', { name: 'Batch' })).json;
  const ids = [await makeConversation('+15554440001'), await makeConversation('+15554440002')];

  const toTab = await srv.post('/api/conversations/move', { conversation_ids: ids, tab_id: tab.id });
  assert.strictEqual(toTab.status, 200, toTab.text);
  assert.strictEqual(toTab.json.moved_count, 2);
  let list = (await srv.get('/api/conversations')).json;
  ids.forEach(id => assert.strictEqual(list.find(c => c.id === id).tab_id, tab.id));

  // Moving to Customers sets the disposition and leaves the custom tab.
  const toCustomers = await srv.post('/api/conversations/move', { conversation_ids: ids, disposition: 'customer' });
  assert.strictEqual(toCustomers.status, 200, toCustomers.text);
  list = (await srv.get('/api/conversations')).json;
  ids.forEach(id => {
    const c = list.find(x => x.id === id);
    assert.strictEqual(c.disposition, 'customer');
    assert.strictEqual(c.tab_id, null);
  });

  // Follow-up needs a date.
  const noDate = await srv.post('/api/conversations/move', { conversation_ids: ids, disposition: 'follow_up' });
  assert.strictEqual(noDate.status, 400);
  const future = new Date(Date.now() + 86400000).toISOString();
  const withDate = await srv.post('/api/conversations/move',
    { conversation_ids: ids, disposition: 'follow_up', scheduled_at: future });
  assert.strictEqual(withDate.status, 200, withDate.text);

  // Back to automatic sorting clears the disposition.
  const auto = await srv.post('/api/conversations/move', { conversation_ids: ids, disposition: null });
  assert.strictEqual(auto.status, 200);
  list = (await srv.get('/api/conversations')).json;
  ids.forEach(id => assert.strictEqual(list.find(c => c.id === id).disposition, null));
});

test('HTTP: move validates its input', async () => {
  const id = await makeConversation('+15554440003');
  const cases = [
    [{ tab_id: 1 }, 400],
    [{ conversation_ids: [], tab_id: null }, 400],
    [{ conversation_ids: ['abc'], tab_id: null }, 400],
    [{ conversation_ids: [id] }, 400],
    [{ conversation_ids: [id], tab_id: null, disposition: 'no' }, 400],
    [{ conversation_ids: [id], disposition: 'banana' }, 400],
    [{ conversation_ids: [id], tab_id: 999999 }, 404]
  ];
  for (const [body, status] of cases) {
    const res = await srv.post('/api/conversations/move', body);
    assert.strictEqual(res.status, status, `${JSON.stringify(body)} -> ${res.status} ${res.text}`);
  }
});

test('HTTP: one agency cannot use another agency\'s tab', async () => {
  const mine = (await srv.post('/api/tabs', { name: 'Mine only' })).json;
  await srv.createTenantWithOwner('Rival Agency', 'rival-owner', 'test-password-123', ['5555550199']);
  const login = await srv.login('rival-owner', 'test-password-123');
  assert.strictEqual(login.status, 200);

  const theirs = await makeConversation('+15554449999');
  assert.deepStrictEqual((await srv.get('/api/tabs')).json, []);
  assert.strictEqual((await srv.patch(`/api/tabs/${mine.id}`, { name: 'x' })).status, 404);
  assert.strictEqual((await srv.del(`/api/tabs/${mine.id}`)).status, 404);
  const move = await srv.post('/api/conversations/move', { conversation_ids: [theirs], tab_id: mine.id });
  assert.strictEqual(move.status, 404);

  await srv.login();
});
