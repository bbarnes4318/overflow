'use strict';

/**
 * The public A2P registration form: anonymous to submit, validated, stored,
 * and readable only by the superadmin because the record holds an EIN.
 */

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/testserver');
const { summaryText } = require('../../a2p');

let srv;

test.before(async () => { srv = await startServer({ label: 'a2p' }); });
test.after(async () => { if (srv) await srv.stop(); });

const PNG = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nrest', 'latin1').toString('base64');

const valid = {
  legal_name: 'Example Benefits LLC', entity_type: 'LLC', ein: '12-3456789', ownership_type: 'Privately owned',
  industry: 'Insurance', business_description: 'We sell life insurance.', website: 'https://example.com',
  address_street: '1 Main St', address_city: 'Jacksonville', address_state: 'FL', address_zip: '32202',
  rep_name: 'Pat Example', rep_title: 'Owner', rep_email: 'pat@example.com', rep_phone: '(904) 555-0100',
  sms_brand: 'Example Benefits', use_cases: ['Sales Follow-Ups'], recipients: ['Current customers'],
  message_description: 'Follow-ups to people who asked.',
  sample_1: 'Example Benefits: Hi Sam, following up. Reply STOP to opt out.',
  sample_2: 'Example Benefits: Your appointment is Monday. Reply STOP to opt out.',
  sample_3: 'Example Benefits: Your policy is updated. Reply STOP to opt out.',
  has_links: 'No', has_phone_numbers: 'No', daily_volume: 'Under 100', allows_replies: 'Yes',
  consent_methods: ['Website Form'], optin_url: 'https://example.com/contact', consent_language: 'By checking this box you agree.',
  screenshot_choice: 'Send it later', list_source: 'Collected directly by us', keeps_records: 'Yes',
  privacy_url: 'https://example.com/privacy', terms_url: 'https://example.com/terms', support_contact: 'help@example.com',
  prior_registration: 'No', number_count: '2', number_source: 'Purchase new numbers', certified: true
};

// The form rate limits per IP, so each rejected case stays below the insert
// path: only accepted submissions count against the limit.
const post = (patch, opts = {}) => srv.post('/api/a2p-registration', { ...valid, ...patch }, { auth: false, ...opts });

test('a complete registration is stored without a session, with its screenshot', async () => {
  const res = await post({ screenshot_choice: 'Upload now', screenshot: PNG });
  assert.strictEqual(res.status, 200);
  assert.ok(res.json.id);

  await srv.loginSuperadmin();
  const record = await srv.get(`/api/a2p-registrations/${res.json.id}`);
  assert.strictEqual(record.status, 200);
  assert.strictEqual(record.json.answers.ein, '12-3456789');
  assert.deepStrictEqual(record.json.answers.use_cases, ['Sales Follow-Ups']);
  assert.ok(record.json.screenshot_url);

  const list = await srv.get('/api/a2p-registrations');
  assert.strictEqual(list.json[0].legal_name, 'Example Benefits LLC');
  assert.strictEqual(list.json[0].answers, undefined);
});

test('a sole proprietor needs no EIN; everyone else does', async () => {
  assert.strictEqual((await post({ entity_type: 'Sole Proprietor', ein: '' })).status, 200);
  assert.strictEqual((await post({ ein: '' })).status, 400);
});

test('bad answers are rejected', async () => {
  const cases = [
    { legal_name: '' }, { ein: '123' }, { entity_type: 'Trust' }, { rep_email: 'nope' }, { rep_phone: '12345' },
    { website: 'javascript:alert(1)' }, { use_cases: [] }, { use_cases: ['Spam'] }, { recipients: 'Current customers' },
    { has_links: 'Yes', link_domains: '' }, { consent_methods: ['Website Form'], optin_url: '' },
    { prior_registration: 'Yes', prior_provider: '' }, { support_contact: 'neither' }, { number_count: '0' },
    { number_count: '1.5' }, { certified: false }, { address_zip: 'ABCDE' }
  ];
  for (const patch of cases) {
    assert.strictEqual((await post(patch)).status, 400, JSON.stringify(patch));
  }
});

test('a screenshot must really be an image', async () => {
  const html = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.strictEqual((await post({ screenshot_choice: 'Upload now', screenshot: html })).status, 400);
  assert.strictEqual((await post({ screenshot_choice: 'Upload now' })).status, 400);
});

test('submitted records are not readable without a superadmin session', async () => {
  for (const path of ['/api/a2p-registrations', '/api/a2p-registrations/1', '/api/a2p-registrations/1/screenshot']) {
    assert.strictEqual((await srv.get(path, { auth: false })).status, 401, path);
  }
});

test('the notification email masks the EIN', () => {
  const text = summaryText({ legal_name: 'X', ein: '12-3456789', use_cases: ['Marketing'] }, 7);
  assert.ok(!text.includes('12-3456789'));
  assert.ok(text.includes('***6789'));
  assert.ok(text.includes('/api/a2p-registrations/7'));
});
