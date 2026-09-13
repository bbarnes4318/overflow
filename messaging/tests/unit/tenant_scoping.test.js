'use strict';

/**
 * A static guard on the tenancy boundary.
 *
 * database.js holds well over a hundred prepared statements. The isolation
 * suite proves the boundary holds for the paths it exercises; this proves no
 * statement was ADDED that quietly skips it. Without something like this, the
 * 141st statement is the one that leaks, and it leaks silently.
 *
 * A statement that touches a tenant-owned table must either filter on
 * tenant_id, or appear in ALLOWED_GLOBAL below with the reason it does not.
 * Adding an entry here is meant to be a deliberate, reviewable act.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.resolve(__dirname, '..', '..', 'database.js');

const TENANT_TABLES = [
  'conversations', 'messages', 'notes',
  'suppression_events', 'reminder_state', 'users'
];

// Statements that are global BY DESIGN. The value is why.
const ALLOWED_GLOBAL = new Map([
  ["UPDATE messages SET status = 'queued' WHERE status = 'sending'",
   'startup reconciliation by the single global queue worker'],

  ["UPDATE messages SET status = 'failed', error_message = 'Interrupted mid-send (server restarted). Check the carrier log before resending.' WHERE status = 'sending' AND created_at <= datetime('now', 'localtime', ?)",
   'same: a crash strands rows across every tenant and there is no caller tenant'],

  ['SELECT COUNT(*) as count FROM users',
   'bootstrap check: is any user configured at all'],

  ['SELECT * FROM users WHERE username = ?',
   'login and session resolution - this is where the tenant is DISCOVERED'],

  ['INSERT INTO users (username, password_hash, tenant_id, role) VALUES (?, ?, ?, ?)',
   'writes the tenant_id column itself; createUser validates the pairing'],

  ["UPDATE users SET role = 'superadmin' WHERE id = (SELECT MIN(id) FROM users)",
   'one-off migration promoting a pre-tenancy admin'],

  ['SELECT * FROM messages WHERE ref_id = ?',
   'delivery receipt: the carrier sends only a ref_id, so the tenant is DISCOVERED here'],

  ['SELECT * FROM conversations',
   'legacy normalization migration, before any request exists'],
  ['UPDATE messages SET conversation_id = ? WHERE conversation_id = ?',
   'legacy duplicate merge; the dedupe key includes tenant_id'],
  ['DELETE FROM conversations WHERE id = ?',
   'legacy duplicate merge of a row the loop already read'],
  ['UPDATE conversations SET phone_number = ? WHERE id = ?',
   'legacy phone normalization of a row the loop already read'],
  ['UPDATE conversations SET name = ? WHERE id = ?',
   'legacy duplicate merge of a row the loop already read'],
  ['UPDATE conversations SET last_message_text = ?, last_message_at = ? WHERE id = ?',
   'legacy duplicate merge of a row the loop already read'],

  ['INSERT INTO recruiting_inquiries (source, agency_name, contact_name, email, phone, states, agent_count, offer, timing, notes, client_ip) VALUES (@source, @agency_name, @contact_name, @email, @phone, @states, @agent_count, @offer, @timing, @notes, @client_ip)',
   'anonymous public form owned by the platform, not a tenant; "notes" here is a column, not the notes table'],
]);

/** Queue-worker reads are global: every row they return carries its tenant_id. */
function isQueueWorkerRead(sql) {
  return /from messages/.test(sql) &&
         /(status = 'queued'|status = 'sending'|group by from_number)/.test(sql);
}

/** Pull the SQL out of every db.prepare(...) call. */
function preparedStatements(source) {
  const found = [];
  const re = /db\.prepare\(\s*(`([^`]*)`|'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const sql = m[2] || m[3] || m[4] || '';
    found.push({
      line: source.slice(0, m.index).split('\n').length,
      sql: sql.split(/\s+/).join(' ').trim()
    });
  }
  return found;
}

const source = fs.readFileSync(DB_FILE, 'utf8');
const statements = preparedStatements(source);

test('the audit actually found the statements it claims to check', () => {
  assert.ok(statements.length > 100,
    `expected the full statement set, parsed only ${statements.length}`);
});

test('every statement touching tenant data is scoped, or explicitly justified', () => {
  const offenders = [];
  let scopedCount = 0;

  for (const { line, sql } of statements) {
    const lowered = sql.toLowerCase();

    const touchesTenantData = TENANT_TABLES.some(t =>
      new RegExp(`\\b${t}\\b`).test(lowered));
    if (!touchesTenantData) continue;

    // Schema definition is not a read or a write of tenant rows.
    if (/^(create table|create index|alter table|pragma|drop table)/.test(lowered)) continue;

    if (lowered.includes('tenant_id')) { scopedCount++; continue; }
    if (ALLOWED_GLOBAL.has(sql)) continue;
    if (isQueueWorkerRead(lowered)) continue;

    offenders.push(`database.js:${line}  ${sql.slice(0, 140)}`);
  }

  assert.ok(scopedCount > 60,
    `only ${scopedCount} statements were tenant-scoped; the audit is not seeing the file`);

  assert.deepStrictEqual(offenders, [],
    'these statements touch tenant-owned tables without filtering on tenant_id.\n' +
    'Either add the filter, or add the statement to ALLOWED_GLOBAL with a reason:\n' +
    offenders.join('\n'));
});

test('every scoped database function rejects a missing tenant_id', () => {
  // The guard must throw rather than default. A default would mean one tenant
  // silently reading another's rows, which is the failure tenancy exists to
  // prevent - so it has to be loud.
  const { freshDb } = require('../helpers/testdb');
  const ctx = freshDb('scoping');
  try {
    const { db } = ctx;
    const calls = [
      ['getConversations', () => db.getConversations()],
      ['getConversationsForList', () => db.getConversationsForList()],
      ['getConversationById', () => db.getConversationById(undefined, 1)],
      ['getOrCreateConversation', () => db.getOrCreateConversation(undefined, '+15550001111')],
      ['getMessages', () => db.getMessages(undefined, 1)],
      ['insertMessage', () => db.insertMessage(undefined, { conversation_id: 1 })],
      ['updateMessageStatus', () => db.updateMessageStatus(undefined, 1, 'sent')],
      ['getQueueStats', () => db.getQueueStats()],
      ['getStats', () => db.getStats(undefined, '2026-01-01', '2026-01-02')],
      ['getRecentMessages', () => db.getRecentMessages()],
      ['markConversationRead', () => db.markConversationRead(undefined, 1)],
      ['deleteConversation', () => db.deleteConversation(undefined, 1)],
      ['setConversationDisposition', () => db.setConversationDisposition(undefined, 1, 'no')],
      ['recordOptOut', () => db.recordOptOut(undefined, 1)],
      ['recordWrongNumber', () => db.recordWrongNumber(undefined, 1)],
      ['recordOptIn', () => db.recordOptIn(undefined, 1, 'actor')],
      ['getSuppressionBlock', () => db.getSuppressionBlock(undefined, 1)],
      ['backfillSuppression', () => db.backfillSuppression()],
      ['bulkImportLeads', () => db.bulkImportLeads(undefined, [], null)],
      ['sendBulkMessages', () => db.sendBulkMessages(undefined, [1], 'hi')],
      ['getNotesForTarget', () => db.getNotesForTarget(undefined, { conversationId: 1 })],
      ['addNoteForTarget', () => db.addNoteForTarget(undefined, { conversationId: 1, noteText: 'x' })],
      ['deleteNote', () => db.deleteNote(undefined, 1)],
      ['getNotifiedReminders', () => db.getNotifiedReminders()],
      ['acknowledgeReminder', () => db.acknowledgeReminder(undefined, 1, 'x', 'due_60')],
      ['recordDelivery', () => db.recordDelivery(undefined, 1, 'DELIVRD')],
      ['recordCarrierStatus', () => db.recordCarrierStatus(undefined, 1, 'UNDELIV')],
      ['getPlaceholderWidths', () => db.getPlaceholderWidths()],
      ['getTenantDidPool', () => db.getTenantDidPool()],
      ['resolveSenderNumber', () => db.resolveSenderNumber(undefined, 1, null)],
      ['getEffectiveSettings', () => db.getEffectiveSettings()],
      ['getTenantSettings', () => db.getTenantSettings()],
      ['updateTenantSettings', () => db.updateTenantSettings(undefined, {})],
      ['getTenantDids', () => db.getTenantDids()],
      ['logSuppressionEvent', () => db.logSuppressionEvent(undefined, 1, 'p', 'e')],
    ];

    for (const [name, call] of calls) {
      assert.throws(call, /tenant_id is required/,
        `${name}() must refuse to run without a tenant_id`);
    }
  } finally {
    ctx.cleanup();
  }
});
