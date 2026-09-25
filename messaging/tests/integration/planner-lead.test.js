'use strict';

/**
 * The public Agency Planner lead ("Email me my plan"): no session, validated, stored.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('../helpers/testserver');

// The recorded consent must be the server's own constant, read from the source so there is one copy of the wording.
const PLANNER_CONSENT_V1 = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.js'), 'utf8')
  .match(/const PLANNER_CONSENT_V1 = "([^"]+)";/)[1];

let srv;

test.before(async () => { srv = await startServer({ label: 'planner-lead' }); });
test.after(async () => { if (srv) await srv.stop(); });

const valid = {
  source: 'agency-planner',
  contact_name: 'Pat Example',
  agency_name: 'Example Benefits',
  email: 'pat@example.com',
  phone: '(904) 555-0100',
  states: 'FL, GA, TX',
  sells: 'both',
  agents_today: 20,
  agents_next_year: 40,
  medicare_agents: 10,
  close_rate: 0.1,
  agent_pay: 120,
  goal: 25000,
  partners: 2,
  sms_consent: true,
  plan_url: 'https://netenroll.com/agency-planner/?s=both&a0=20&a1=40&m0=10&c=0.1&p=120&g=25000&n=2&v=result',
  results: {
    take_home_y1: 36708.91, take_home_y2: 127398.5, take_home_y3: 231585.57, agents_needed: 11,
    fe_apps_day: 7.43, md_apps_day: 16.15, fe_spend_day: 1478.58, md_spend_day: 2568.49,
    exit_y3_low: 21511573.83, exit_y3_base: 27965045.98, exit_y3_high: 34418518.13
  }
};

const row = (id) => new Database(srv.dbFile, { readonly: true }).prepare('SELECT * FROM planner_leads WHERE id = ?').get(id);

test('a valid lead is accepted without a session and stored', async () => {
  const res = await srv.post('/api/planner-lead', valid, { auth: false });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.json.id > 0);

  const r = row(res.json.id);
  assert.strictEqual(r.agency_name, 'Example Benefits');
  assert.strictEqual(r.sells, 'both');
  assert.strictEqual(r.sms_consent, 1);
  assert.strictEqual(r.consent_text, PLANNER_CONSENT_V1);
  assert.deepStrictEqual(JSON.parse(r.results_json), valid.results);
});

test('without consent nothing is recorded as consent', async () => {
  const res = await srv.post('/api/planner-lead', { ...valid, sms_consent: false }, { auth: false });
  assert.strictEqual(res.status, 200, res.text);
  const r = row(res.json.id);
  assert.strictEqual(r.sms_consent, 0);
  assert.strictEqual(r.consent_text, null);
});

test('bad input is rejected with a message', async () => {
  for (const patch of [
    { agency_name: '' }, { email: 'not-an-email' }, { phone: '123' }, { sells: 'life' },
    { medicare_agents: 21 }, { plan_url: 'https://evil.example/' },
    { results: { ...valid.results, exit_y3_base: 'abc' } }
  ]) {
    const res = await srv.post('/api/planner-lead', { ...valid, ...patch }, { auth: false });
    assert.strictEqual(res.status, 400, JSON.stringify(patch));
    assert.ok(res.json.error);
  }
});
