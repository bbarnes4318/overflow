'use strict';

/**
 * The public recruiting inquiry form: no session, validated, stored.
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { startServer } = require('../helpers/testserver');

let srv;

test.before(async () => { srv = await startServer({ label: 'recruiting' }); });
test.after(async () => { if (srv) await srv.stop(); });

const valid = {
  source: 'aca-agent-recruiting',
  agency_name: 'Example Benefits',
  contact_name: 'Pat Example',
  email: 'pat@example.com',
  phone: '(904) 555-0100',
  states: 'FL, GA',
  agent_count: '10',
  offer: 'Commission only',
  timing: 'Before November 1',
  notes: 'Bilingual preferred.'
};

test('a complete inquiry is accepted without a session and stored', async () => {
  const res = await srv.post('/api/recruiting-inquiry', valid, { auth: false });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.id > 0);

  const row = new Database(srv.dbFile, { readonly: true })
    .prepare('SELECT * FROM recruiting_inquiries WHERE id = ?').get(res.json.id);
  assert.strictEqual(row.agency_name, 'Example Benefits');
  assert.strictEqual(row.source, 'aca-agent-recruiting');
  assert.strictEqual(row.notes, 'Bilingual preferred.');
});

test('a missing field, a bad email and an off-list choice are each rejected', async () => {
  for (const patch of [{ agency_name: '' }, { email: 'not-an-email' }, { timing: 'Whenever' }, { phone: '123' }]) {
    const res = await srv.post('/api/recruiting-inquiry', { ...valid, ...patch }, { auth: false });
    assert.strictEqual(res.status, 400, JSON.stringify(patch));
    assert.ok(res.json.error);
  }
});
