'use strict';

/**
 * Sending hours are locked to the legal window: the settings API refuses a
 * window outside 8am-9pm and will not switch quiet hours off, and the queue
 * hands the pacer the contact's state so the stricter time zone applies.
 */

const test = require('node:test');
const assert = require('node:assert');
const { freshDb, seedConversation, seedMessage } = require('../helpers/testdb');
const { startServer } = require('../helpers/testserver');

/* ---------------- the queue carries the contact's state ---------------- */

const ctx = freshDb('sending-hours');
test.after(() => ctx.cleanup());

test('queued messages come with the contact state the pacer needs', () => {
  const { raw, db, tenantId } = ctx;
  const withState = seedConversation(raw, { tenantId, phone: '+12125550111', state: 'CA' });
  const without = seedConversation(raw, { tenantId, phone: '+12125550112' });
  seedMessage(raw, { tenantId, conversationId: withState, direction: 'outbound', status: 'queued' });
  seedMessage(raw, { tenantId, conversationId: without, direction: 'outbound', status: 'queued' });

  const due = db.getDueQueuedMessages(10);
  const byConv = id => due.find(m => m.conversation_id === id);
  assert.strictEqual(byConv(withState).contact_state, 'CA');
  assert.strictEqual(byConv(without).contact_state, null);
  // Still the message row: the worker reads these columns.
  assert.strictEqual(byConv(withState).status, 'queued');
  assert.ok(byConv(withState).tenant_id);
});

/* ---------------- the settings API ---------------- */

let srv;
test.before(async () => {
  srv = await startServer({ label: 'sending-hours' });
  const signup = await srv.signup();
  assert.strictEqual(signup.status, 200);
});
test.after(async () => { if (srv) await srv.stop(); });

test('settings report sending hours as always on, 9am-8pm by default', async () => {
  const res = await srv.get('/api/settings');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.quiet_hours_enabled, '1');
  assert.strictEqual(res.json.quiet_start_hour, '9');
  assert.strictEqual(res.json.quiet_end_hour, '20');
});

test('a window inside 8am-9pm saves', async () => {
  const res = await srv.post('/api/settings', { quiet_start_hour: '8', quiet_end_hour: '21' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.quiet_start_hour, '8');
  assert.strictEqual(res.json.quiet_end_hour, '21');
});

test('a window outside 8am-9pm, or inverted, is refused', async () => {
  const bad = [
    { quiet_start_hour: '7', quiet_end_hour: '20' },
    { quiet_start_hour: '9', quiet_end_hour: '22' },
    { quiet_start_hour: '0', quiet_end_hour: '24' },
    { quiet_start_hour: '15', quiet_end_hour: '10' },
    { quiet_start_hour: '9.5', quiet_end_hour: '20' },
    { quiet_start_hour: 'abc', quiet_end_hour: '20' },
    { quiet_end_hour: '23' }
  ];
  for (const body of bad) {
    const res = await srv.post('/api/settings', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
    assert.match(res.json.error, /8am/);
  }
  // Nothing bad was stored.
  const after = await srv.get('/api/settings');
  assert.strictEqual(after.json.quiet_start_hour, '8');
  assert.strictEqual(after.json.quiet_end_hour, '21');
});

test('quiet hours cannot be switched off through the API', async () => {
  const res = await srv.post('/api/settings', { quiet_hours_enabled: '0' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.quiet_hours_enabled, '1');
  assert.strictEqual((await srv.get('/api/settings')).json.quiet_hours_enabled, '1');
});
