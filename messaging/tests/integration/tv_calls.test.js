'use strict';

/**
 * The public TV inbound call access form: no session, validated, stored once.
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { startServer } = require('../helpers/testserver');

let srv;

test.before(async () => { srv = await startServer({ label: 'tvcalls' }); });
test.after(async () => { if (srv) await srv.stop(); });

const valid = {
  source: 'medicare-tv-calls',
  products: ['medicare'],
  contact_name: 'Pat Example',
  agency_name: 'Example Benefits',
  email: 'pat@example.com',
  phone: '(904) 555-0100',
  agent_type: 'Agency',
  states: 'FL, GA',
  agent_count: '6 to 20',
  attribution: { utm_source: 'google', junk: 'dropped' }
};

test('a request is stored once; a quick resubmit returns the same id', async () => {
  const res = await srv.post('/api/tv-calls-inquiry', valid, { auth: false });
  assert.strictEqual(res.status, 200, res.text);
  const again = await srv.post('/api/tv-calls-inquiry', valid, { auth: false });
  assert.strictEqual(again.json.id, res.json.id);
  assert.strictEqual(again.json.duplicate, true);

  const db = new Database(srv.dbFile, { readonly: true });
  const row = db.prepare('SELECT * FROM tv_call_inquiries WHERE id = ?').get(res.json.id);
  assert.strictEqual(row.products, 'medicare');
  assert.deepStrictEqual(JSON.parse(row.attribution), { utm_source: 'google' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM tv_call_inquiries').get().n, 1);
});

test('both products are accepted and stored in a fixed order', async () => {
  const res = await srv.post('/api/tv-calls-inquiry', { ...valid, email: 'b@example.com', products: ['final_expense', 'medicare'] }, { auth: false });
  assert.strictEqual(res.status, 200, res.text);
  const row = new Database(srv.dbFile, { readonly: true }).prepare('SELECT products FROM tv_call_inquiries WHERE id = ?').get(res.json.id);
  assert.strictEqual(row.products, 'medicare,final_expense');
});

test('missing fields, no product, unknown product and bad choices are rejected', async () => {
  for (const patch of [{ agency_name: '' }, { email: 'nope' }, { phone: '123' }, { products: [] }, { products: ['aca'] }, { agent_count: 'lots' }]) {
    const res = await srv.post('/api/tv-calls-inquiry', { ...valid, ...patch }, { auth: false });
    assert.strictEqual(res.status, 400, JSON.stringify(patch));
  }
});
