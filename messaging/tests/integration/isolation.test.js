'use strict';

/**
 * TENANT ISOLATION — the acceptance criterion for multi-tenancy.
 *
 * Two tenants are seeded holding the SAME contact phone number, which is the
 * case that breaks a single-tenant schema: one UNIQUE(phone_number) row cannot
 * belong to two agencies, and one flat WebSocket broadcast cannot serve them.
 *
 * Everything here runs against the REAL server over HTTP, with two independent
 * cookie jars, because the boundary that matters is the one a browser can
 * actually reach — not the one the database layer promises.
 *
 * A by-id request for another tenant's row must return 404. Not 403: a 403
 * confirms the row exists, which lets an agent enumerate another tenant's
 * contacts by walking integers even though they can never read one.
 */

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startServer } = require('../helpers/testserver');

// The same human, held by both agencies. This is the whole point.
const SHARED_CONTACT = '+15557778888';

const DID_A = '5555550111';
const DID_B = '5555550222';

let srv;
let A;   // client for tenant A (Acme)
let B;   // client for tenant B (Beta)

/** An independent session: its own cookie jar, so two users can be live at once. */
function makeClient(base) {
  let cookie = '';
  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, text };
  }
  return {
    request,
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b),
    del: (u) => request('DELETE', u),
    login: (username, password) => request('POST', '/api/auth/login', { username, password }),
    get cookie() { return cookie; }
  };
}

/** Collect every WebSocket frame a client receives, for later inspection. */
function openSocket(base, cookie) {
  const ws = new WebSocket(base.replace('http', 'ws'), { headers: { Cookie: cookie } });
  const received = [];
  ws.on('message', raw => {
    try { received.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, received }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('websocket did not open')), 5000);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  srv = await startServer({ label: 'isolation' });

  // Superadmin stands up both tenants, each owning its own DID.
  await srv.loginSuperadmin();

  const tenantA = (await srv.post('/api/tenants', { name: 'Acme Insurance' })).json;
  await srv.post(`/api/tenants/${tenantA.id}/dids`, { did: DID_A });
  await srv.post(`/api/tenants/${tenantA.id}/users`,
    { username: 'alice', password: 'alice-password-123', role: 'owner' });

  const tenantB = (await srv.post('/api/tenants', { name: 'Beta Agency' })).json;
  await srv.post(`/api/tenants/${tenantB.id}/dids`, { did: DID_B });
  await srv.post(`/api/tenants/${tenantB.id}/users`,
    { username: 'bob', password: 'bob-password-123', role: 'owner' });

  A = makeClient(srv.base);
  B = makeClient(srv.base);
  A.tenantId = tenantA.id;
  B.tenantId = tenantB.id;

  await A.login('alice', 'alice-password-123');
  await B.login('bob', 'bob-password-123');

  // Both tenants take on the SAME contact.
  A.conv = (await A.post('/api/conversations',
    { phone_number: SHARED_CONTACT, name: 'Acme Copy', city: 'Austin' })).json;
  B.conv = (await B.post('/api/conversations',
    { phone_number: SHARED_CONTACT, name: 'Beta Copy', city: 'Denver' })).json;

  // Each writes some history of its own.
  await A.post(`/api/conversations/${A.conv.id}/messages`, { body: 'Acme reaching out' });
  await B.post(`/api/conversations/${B.conv.id}/messages`, { body: 'Beta reaching out' });
  await A.post(`/api/conversations/${A.conv.id}/notes`, { note_text: 'Acme private note' });
  await B.post(`/api/conversations/${B.conv.id}/notes`, { note_text: 'Beta private note' });
});

test.after(async () => { if (srv) await srv.stop(); });

/* ================================================================
 * The premise
 * ================================================================ */

test('the same phone number is held independently by two tenants', () => {
  assert.notStrictEqual(A.conv.id, B.conv.id,
    'one contact, two tenants, two separate conversation rows');
  assert.strictEqual(A.conv.phone_number, B.conv.phone_number);
  assert.strictEqual(A.conv.name, 'Acme Copy');
  assert.strictEqual(B.conv.name, 'Beta Copy');
});

/* ================================================================
 * List endpoints
 * ================================================================ */

test('the conversation list returns only the calling tenant rows', async () => {
  const listA = (await A.get('/api/conversations')).json;
  const listB = (await B.get('/api/conversations')).json;

  assert.deepStrictEqual(listA.map(c => c.id), [A.conv.id]);
  assert.deepStrictEqual(listB.map(c => c.id), [B.conv.id]);

  // The decisive check: the shared number appears in both lists, but each
  // tenant only ever sees its own copy of it.
  assert.strictEqual(listA[0].name, 'Acme Copy');
  assert.strictEqual(listB[0].name, 'Beta Copy');
  assert.ok(!listA.some(c => c.id === B.conv.id), 'A must not see B rows');
  assert.ok(!listB.some(c => c.id === A.conv.id), 'B must not see A rows');
});

test('recent queue activity is scoped to the calling tenant', async () => {
  const recentA = (await A.get('/api/queue/recent?limit=50')).json;
  const recentB = (await B.get('/api/queue/recent?limit=50')).json;

  assert.ok(recentA.length > 0, 'A has its own activity');
  assert.ok(recentA.every(m => m.conversation_id === A.conv.id),
    'A sees only its own messages');
  assert.ok(recentB.every(m => m.conversation_id === B.conv.id),
    'B sees only its own messages');
  assert.ok(!recentA.some(m => String(m.body || '').includes('Beta')),
    "A must not see B's message bodies");
});

test('notes looked up by phone number do not cross tenants', async () => {
  // The sharpest case for notes: they can be fetched by phone number alone,
  // and both tenants hold this number.
  const notesA = (await A.get(`/api/conversations/0/notes?phone_number=${encodeURIComponent(SHARED_CONTACT)}`)).json;
  const notesB = (await B.get(`/api/conversations/0/notes?phone_number=${encodeURIComponent(SHARED_CONTACT)}`)).json;

  assert.ok(notesA.every(n => n.note_text.startsWith('Acme')), 'A sees only Acme notes');
  assert.ok(notesB.every(n => n.note_text.startsWith('Beta')), 'B sees only Beta notes');
  assert.ok(!notesA.some(n => n.note_text.includes('Beta')));
});

test('reminder state is scoped to the calling tenant', async () => {
  const when = new Date(Date.now() + 3600000).toISOString();
  const dispo = await B.post(`/api/conversations/${B.conv.id}/disposition`,
    { disposition: 'appointment', scheduled_at: when });
  assert.strictEqual(dispo.status, 200, dispo.text);

  await B.post('/api/reminders/ack',
    { conversation_id: B.conv.id, scheduled_at: dispo.json.scheduled_at, tier: 'due_60' });

  const remindersA = (await A.get('/api/reminders')).json;
  const remindersB = (await B.get('/api/reminders')).json;

  assert.ok(remindersB.notified.some(r => r.conversation_id === B.conv.id));
  assert.ok(!remindersA.notified.some(r => r.conversation_id === B.conv.id),
    "A must not see B's reminders");
});

test('pacing status shows only the tenant own numbers', async () => {
  const pacingA = (await A.get('/api/pacing/status')).json;
  const pacingB = (await B.get('/api/pacing/status')).json;

  assert.ok(!pacingA.dids.some(d => d.did === DID_B), "A must not see B's DID state");
  assert.ok(!pacingB.dids.some(d => d.did === DID_A), "B must not see A's DID state");
});

/* ================================================================
 * By-id endpoints — 404, never the record, never 403
 * ================================================================ */

test('reading another tenant conversation by id returns 404, not the record', async () => {
  const res = await A.get(`/api/conversations/${B.conv.id}/messages`);

  assert.strictEqual(res.status, 404, 'must be 404');
  assert.notStrictEqual(res.status, 403,
    '403 would confirm the row exists and let an agent enumerate the other tenant');
  assert.ok(!res.text.includes('Beta'), 'no trace of the other tenant in the body');
});

test('every by-id write endpoint refuses another tenant id with 404', async () => {
  const foreign = B.conv.id;
  const attempts = [
    ['POST', `/api/conversations/${foreign}/read`, {}],
    ['POST', `/api/conversations/${foreign}/messages`, { body: 'should never land' }],
    ['POST', `/api/conversations/${foreign}/disposition`, { disposition: 'no' }],
    ['POST', `/api/conversations/${foreign}/opt-out`, { kind: 'opt_out' }],
    ['POST', `/api/conversations/${foreign}/opt-in`, { confirm: true }],
    ['POST', `/api/conversations/${foreign}/notes`, { note_text: 'intrusion' }],
    ['DELETE', `/api/conversations/${foreign}`, undefined]
  ];

  for (const [method, url, body] of attempts) {
    const res = await A.request(method, url, body);
    assert.strictEqual(res.status, 404, `${method} ${url} must 404, got ${res.status}`);
  }

  // And none of it touched B's data.
  const listB = (await B.get('/api/conversations')).json;
  assert.strictEqual(listB.length, 1, 'B still has its conversation');
  assert.strictEqual(listB[0].opted_out, 0, 'B contact was not opted out by A');

  const messagesB = (await B.get(`/api/conversations/${B.conv.id}/messages`)).json;
  assert.ok(!messagesB.some(m => m.body === 'should never land'),
    'no message was planted in B');

  const notesB = (await B.get(`/api/conversations/${B.conv.id}/notes`)).json;
  assert.ok(!notesB.some(n => n.note_text === 'intrusion'), 'no note was planted in B');
});

test('deleting another tenant note returns 404 and leaves it intact', async () => {
  const notesB = (await B.get(`/api/conversations/${B.conv.id}/notes`)).json;
  const target = notesB[0];
  assert.ok(target, 'B has a note to protect');

  const res = await A.del(`/api/notes/${target.id}`);
  assert.strictEqual(res.status, 404);

  const stillThere = (await B.get(`/api/conversations/${B.conv.id}/notes`)).json;
  assert.ok(stillThere.some(n => n.id === target.id), "B's note survives");
});

test('a bulk send cannot reach another tenant conversation ids', async () => {
  const res = await A.post('/api/conversations/bulk-message', {
    conversation_ids: [B.conv.id],
    message_text: 'blast that must not land'
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.queued_count, 0, 'nothing queued for a foreign id');

  const messagesB = (await B.get(`/api/conversations/${B.conv.id}/messages`)).json;
  assert.ok(!messagesB.some(m => m.body === 'blast that must not land'));
});

/* ================================================================
 * Stats
 * ================================================================ */

test('the stats endpoint aggregates only the calling tenant data', async () => {
  // A window either side of today. created_at is written in server-local time
  // while the range is bounded in UTC, so a single-day window can fall on the
  // wrong side of midnight; the isolation being tested here is unaffected by
  // which day a message lands on.
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const from = day(-1);
  const to = day(1);
  const statsA = (await A.get(`/api/stats?from=${from}&to=${to}`)).json;
  const statsB = (await B.get(`/api/stats?from=${from}&to=${to}`)).json;

  // Each tenant queued exactly one outbound message for one contact.
  assert.strictEqual(statsA.sent.attempted, 1, 'A counts only its own send');
  assert.strictEqual(statsB.sent.attempted, 1, 'B counts only its own send');
  assert.strictEqual(statsA.new_leads, 1, 'A counts only its own contact');
  assert.strictEqual(statsB.new_leads, 1, 'B counts only its own contact');

  // B booked an appointment above; A must not see it in its own totals.
  assert.strictEqual(statsA.dispositions.appointment, 0,
    "A must not count B's appointment");
  assert.strictEqual(statsB.dispositions.appointment, 1);
});

test('queue status counts only the calling tenant messages', async () => {
  const queueA = (await A.get('/api/queue/status')).json;
  const queueB = (await B.get('/api/queue/status')).json;
  const totalA = queueA.queued + queueA.sending + queueA.sent + queueA.failed;
  const totalB = queueB.queued + queueB.sending + queueB.sent + queueB.failed;

  assert.strictEqual(totalA, 1, 'A sees exactly its own one message');
  assert.strictEqual(totalB, 1, 'B sees exactly its own one message');
});

/* ================================================================
 * The WebSocket stream
 * ================================================================ */

test('no WebSocket event crosses from one tenant to another', async () => {
  const socketA = await openSocket(srv.base, A.cookie);
  const socketB = await openSocket(srv.base, B.cookie);

  try {
    await sleep(200);
    socketA.received.length = 0;
    socketB.received.length = 0;

    // B does something that broadcasts: a new outbound message.
    await B.post(`/api/conversations/${B.conv.id}/messages`, { body: 'Beta broadcast probe' });
    // And an inbound arrives on B's number.
    await srv.post('/webhook/inbound',
      { From: SHARED_CONTACT, To: DID_B, Message: 'reply meant for Beta' }, { auth: false });
    await sleep(600);

    const bodies = frames => JSON.stringify(frames);

    assert.ok(socketB.received.length > 0, 'B receives its own events');
    assert.ok(bodies(socketB.received).includes('Beta broadcast probe'),
      "B's own message reaches B");

    assert.ok(!bodies(socketA.received).includes('Beta broadcast probe'),
      "A must not receive B's outbound message event");
    assert.ok(!bodies(socketA.received).includes('reply meant for Beta'),
      "A must not receive B's inbound reply event");
    assert.ok(!socketA.received.some(f => f.data && f.data.conversation_id === B.conv.id),
      "no frame referencing B's conversation may reach A");
  } finally {
    socketA.ws.close();
    socketB.ws.close();
  }
});

/* ================================================================
 * Inbound routing
 * ================================================================ */

test('an inbound reply is routed to the tenant that owns the To number', async () => {
  const FROM = '+15556660001';

  await srv.post('/webhook/inbound',
    { From: FROM, To: DID_A, Message: 'this belongs to Acme' }, { auth: false });

  const listA = (await A.get('/api/conversations')).json;
  const listB = (await B.get('/api/conversations')).json;

  const inA = listA.find(c => c.phone_number === FROM);
  assert.ok(inA, 'the reply created a conversation for the DID owner');
  assert.strictEqual(inA.assigned_did, DID_A, 'pinned to the number they texted');
  assert.ok(!listB.some(c => c.phone_number === FROM),
    'the other tenant never sees it');
});

test('an inbound to an unregistered number is dropped, not misrouted', async () => {
  const FROM = '+15556660002';
  const before = (await A.get('/api/conversations')).json.length;

  const res = await srv.post('/webhook/inbound',
    { From: FROM, To: '5559990000', Message: 'nobody owns this number' }, { auth: false });

  // 200 so the carrier stops retrying into a void, but nothing is created.
  assert.strictEqual(res.status, 200);

  const listA = (await A.get('/api/conversations')).json;
  const listB = (await B.get('/api/conversations')).json;
  assert.strictEqual(listA.length, before, 'no conversation created for A');
  assert.ok(!listA.some(c => c.phone_number === FROM));
  assert.ok(!listB.some(c => c.phone_number === FROM));
});

/* ================================================================
 * DID ownership and sending
 * ================================================================ */

test('a DID cannot be claimed by a second tenant', async () => {
  await srv.loginSuperadmin();
  const res = await srv.post(`/api/tenants/${B.tenantId}/dids`, { did: DID_A });

  assert.strictEqual(res.status, 409, 'the primary key makes this impossible');
  assert.match(res.json.error, /already belongs to tenant/);

  // Ownership is unchanged.
  const didsA = (await srv.get(`/api/tenants/${A.tenantId}/dids`)).json;
  assert.ok(didsA.some(d => d.did === DID_A));
});

test('a tenant cannot send from a number it does not own', async () => {
  const res = await A.post(`/api/conversations/${A.conv.id}/messages`,
    { body: 'sent from a stolen number', from_number: DID_B });

  assert.notStrictEqual(res.status, 201, 'the send must not be accepted');

  const messagesB = (await B.get(`/api/conversations/${B.conv.id}/messages`)).json;
  assert.ok(!messagesB.some(m => m.from_number === DID_B && m.body === 'sent from a stolen number'));

  const messagesA = (await A.get(`/api/conversations/${A.conv.id}/messages`)).json;
  assert.ok(!messagesA.some(m => m.from_number === DID_B),
    "no message may go out from another tenant's number");
});

/* ================================================================
 * Suppression: tenant-scoped, with one global override
 * ================================================================ */

test('an opt-out binds only the tenant that was texted', async () => {
  // The contact opts out of Acme. Beta holds the same number and has its own
  // relationship with them, so Beta must be unaffected.
  const res = await A.post(`/api/conversations/${A.conv.id}/opt-out`,
    { kind: 'opt_out', reason: 'asked Acme to stop' });
  assert.strictEqual(res.status, 200);

  const listA = (await A.get('/api/conversations')).json;
  const listB = (await B.get('/api/conversations')).json;
  assert.strictEqual(listA.find(c => c.id === A.conv.id).opted_out, 1, 'suppressed for Acme');
  assert.strictEqual(listB.find(c => c.id === B.conv.id).opted_out, 0, 'untouched for Beta');

  // Acme can no longer message them; Beta still can.
  const blockedForA = await A.post(`/api/conversations/${A.conv.id}/messages`, { body: 'again?' });
  assert.strictEqual(blockedForA.status, 409);

  const allowedForB = await B.post(`/api/conversations/${B.conv.id}/messages`, { body: 'still fine' });
  assert.strictEqual(allowedForB.status, 201, 'Beta is not bound by an opt-out given to Acme');
});

test('the global do-not-contact list blocks every tenant at once', async () => {
  const LITIGATOR = '+15554443333';

  // Both tenants take on the contact before it is listed.
  const convA = (await A.post('/api/conversations', { phone_number: LITIGATOR, name: 'A copy' })).json;
  const convB = (await B.post('/api/conversations', { phone_number: LITIGATOR, name: 'B copy' })).json;

  await srv.loginSuperadmin();
  const added = await srv.post('/api/global-suppression',
    { phone_number: LITIGATOR, reason: 'litigator', detail: 'known TCPA plaintiff' });
  assert.strictEqual(added.status, 201);

  for (const [client, convId, label] of [[A, convA.id, 'A'], [B, convB.id, 'B']]) {
    const res = await client.post(`/api/conversations/${convId}/messages`, { body: 'hello' });
    assert.strictEqual(res.status, 409, `${label} must be blocked by the global list`);
    assert.strictEqual(res.json.reason, 'global_dnc');
  }

  // And no tenant can re-opt them in.
  const optIn = await A.post(`/api/conversations/${convA.id}/opt-in`, { confirm: true });
  assert.notStrictEqual(optIn.status, 200,
    'a tenant cannot clear a global block');
});

/* ================================================================
 * Roles
 * ================================================================ */

test('a tenant user cannot reach superadmin-only routes', async () => {
  for (const [method, url, body] of [
    ['GET', '/api/tenants', undefined],
    ['POST', '/api/tenants', { name: 'Rogue Tenant' }],
    ['POST', '/api/tenants/switch', { tenant_id: B.tenantId }],
    ['GET', '/api/global-suppression', undefined],
    ['POST', `/api/tenants/${B.tenantId}/dids`, { did: '5555559999' }]
  ]) {
    const res = await A.request(method, url, body);
    assert.strictEqual(res.status, 403, `${method} ${url} must be superadmin only`);
  }
});

test('a superadmin acts as exactly one tenant at a time', async () => {
  await srv.loginSuperadmin();

  // Before switching there is no tenant context, so tenant data is refused
  // rather than served unscoped.
  const before = await srv.get('/api/conversations');
  assert.strictEqual(before.status, 409, 'no tenant selected yet');
  assert.strictEqual(before.json.needs_tenant, true);

  await srv.post('/api/tenants/switch', { tenant_id: A.tenantId });
  const asA = (await srv.get('/api/conversations')).json;
  assert.ok(asA.some(c => c.id === A.conv.id));
  assert.ok(!asA.some(c => c.id === B.conv.id), 'acting as A shows only A');

  await srv.post('/api/tenants/switch', { tenant_id: B.tenantId });
  const asB = (await srv.get('/api/conversations')).json;
  assert.ok(asB.some(c => c.id === B.conv.id));
  assert.ok(!asB.some(c => c.id === A.conv.id), 'acting as B shows only B');
});

test('the server logged no unexpected errors during the isolation suite', () => {
  const noise = srv.serverErrors.join('');
  assert.ok(!/tenant_id is required/.test(noise),
    `a route reached the database without a tenant:\n${noise}`);
});
