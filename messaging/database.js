const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const classification = require('./public/lib/classification');

// The merge fields a template may reference. One list, shared with variation.js
// so a field cannot exist for substitution but not for measurement.
const {
  MERGE_FIELDS,
  MERGE_COLUMNS,
  DEFAULT_MERGE_WIDTHS,
  mergePlaceholders
} = require('./merge_fields');

// SMS_DB_PATH lets tests point at a throwaway database. Production leaves it
// unset and gets the file next to this module, exactly as before.
const dbPath = process.env.SMS_DB_PATH || path.resolve(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Number ownership lives in tenant_dids, not in a constant and not in a CSV
// setting. One DID belongs to exactly one tenant, enforced by that table's
// primary key, and that is what makes the per-DID pacer a tenant boundary: a
// number can never pace, send, or receive on behalf of two tenants at once.
//
// This deliberately replaces the old FRACTEL_DID_POOL constant, the
// fractel_enabled_dids CSV setting, and the version-bump migration that used to
// force-reset that pool on every deploy. A new install starts with no DIDs at
// all; an operator adds them per tenant.

// Sentinel accepted in place of a from_number to request round-robin selection.
const ROTATE_SENDER = 'rotate';

/**
 * The tenant guard.
 *
 * Every query that touches tenant-owned data runs through this. It throws
 * rather than defaulting, because the failure mode of a silent default is one
 * tenant reading another's contacts - the exact thing tenancy exists to stop.
 * A caller that does not know its tenant has a bug, and should crash loudly at
 * the boundary instead of quietly returning the wrong rows.
 */
function requireTenant(tenantId) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('tenant_id is required');
  }
  return id;
}

/* ==================================================================
 * Tenants
 * ================================================================== */

const TENANT_STATUSES = ['active', 'suspended'];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function createTenant(name, slug = null) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Tenant name is required');
  const cleanSlug = slugify(slug || cleanName);
  if (!cleanSlug) throw new Error('Tenant slug is required');
  const result = db.prepare(
    "INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')"
  ).run(cleanName, cleanSlug);
  return getTenantById(result.lastInsertRowid);
}

function getTenants() {
  return db.prepare('SELECT * FROM tenants ORDER BY name ASC').all();
}

function getTenantById(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(numeric) || null;
}

function getTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slugify(slug)) || null;
}

function setTenantStatus(tenantId, status) {
  const id = requireTenant(tenantId);
  if (!TENANT_STATUSES.includes(status)) {
    throw new Error(`Invalid tenant status: ${status}`);
  }
  db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, id);
  return getTenantById(id);
}

/* ==================================================================
 * DID ownership
 *
 * tenant_dids is the ONLY place a number's owner is recorded. The primary key
 * on `did` is what guarantees one number cannot serve two tenants, which in
 * turn is what makes the existing per-DID pacer a tenant boundary for free.
 * ================================================================== */

function assignDidToTenant(tenantId, did, { enabled = true } = {}) {
  const id = requireTenant(tenantId);
  const clean = toDidFormat(did);
  if (clean.length !== 10) throw new Error(`Invalid DID: ${did}`);
  if (!getTenantById(id)) throw new Error(`Unknown tenant: ${tenantId}`);

  const owner = db.prepare('SELECT tenant_id FROM tenant_dids WHERE did = ?').get(clean);
  if (owner && owner.tenant_id !== id) {
    throw new Error(`DID ${clean} already belongs to tenant ${owner.tenant_id}`);
  }
  db.prepare(`
    INSERT INTO tenant_dids (did, tenant_id, enabled) VALUES (?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET tenant_id = excluded.tenant_id, enabled = excluded.enabled
  `).run(clean, id, enabled ? 1 : 0);
  return db.prepare('SELECT * FROM tenant_dids WHERE did = ?').get(clean);
}

function removeDidFromTenant(tenantId, did) {
  const id = requireTenant(tenantId);
  return db.prepare('DELETE FROM tenant_dids WHERE did = ? AND tenant_id = ?')
           .run(toDidFormat(did), id);
}

function getTenantDids(tenantId) {
  const id = requireTenant(tenantId);
  return db.prepare('SELECT * FROM tenant_dids WHERE tenant_id = ? ORDER BY did ASC').all(id);
}

/**
 * Which tenant owns this number, if any.
 *
 * Deliberately NOT tenant-scoped: this is the function that DISCOVERS the
 * tenant, and the inbound webhook depends on it before any tenant is known.
 * Returns null for an unknown or disabled number so the caller can reject.
 */
function resolveTenantForDid(did) {
  const clean = toDidFormat(did);
  if (clean.length !== 10) return null;
  const row = db.prepare(`
    SELECT d.tenant_id, d.enabled, t.status
    FROM tenant_dids d
    JOIN tenants t ON t.id = d.tenant_id
    WHERE d.did = ?
  `).get(clean);
  if (!row || !row.enabled || row.status !== 'active') return null;
  return row.tenant_id;
}

/* ==================================================================
 * Settings
 *
 * Global (settings): carrier credentials and the Anthropic key - one carrier
 * account and one LLM account serve the whole platform.
 *
 * Per-tenant (tenant_settings): pacing overrides, keyword lists and sender
 * defaults. A tenant with no row for a key inherits the global default, so a
 * tenant only stores what it actually diverges on.
 * ================================================================== */

// Keys that stay global no matter what a tenant tries to write.
const GLOBAL_ONLY_SETTINGS = new Set([
  'fractel_username', 'fractel_password', 'fractel_brand_id',
  'bulkvs_username', 'bulkvs_token',
  'anthropic_api_key', 'variation_model', 'variation_batch_size'
]);

function getTenantSettings(tenantId) {
  const id = requireTenant(tenantId);
  const rows = db.prepare('SELECT key, value FROM tenant_settings WHERE tenant_id = ?').all(id);
  const out = {};
  rows.forEach(row => { out[row.key] = row.value; });
  return out;
}

/**
 * The settings a tenant actually runs on: global defaults with that tenant's
 * overrides laid on top. Carrier credentials can never be overridden.
 */
function getEffectiveSettings(tenantId) {
  const id = requireTenant(tenantId);
  const merged = { ...getSettings() };
  const overrides = getTenantSettings(id);
  for (const [key, value] of Object.entries(overrides)) {
    if (GLOBAL_ONLY_SETTINGS.has(key)) continue;
    merged[key] = value;
  }
  return merged;
}

function updateTenantSettings(tenantId, settingsObj) {
  const id = requireTenant(tenantId);
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)'
  );
  const transaction = db.transaction((obj) => {
    for (const [key, val] of Object.entries(obj)) {
      if (GLOBAL_ONLY_SETTINGS.has(key)) continue;
      stmt.run(id, key, String(val));
    }
  });
  transaction(settingsObj);
  return getEffectiveSettings(id);
}

/* ==================================================================
 * Global suppression
 *
 * Exactly one list that outranks every tenant: litigators and DNC numbers.
 * A tenant opt-out binds the sender who was texted and lives on that tenant's
 * conversation row; this blocks every tenant at once.
 * ================================================================== */

function addGlobalSuppression(phoneNumber, { reason = 'dnc', detail = null, actor = null } = {}) {
  const phone = normalizePhoneNumber(phoneNumber);
  if (!phone) throw new Error('A phone number is required');
  db.prepare(`
    INSERT INTO global_suppression (phone_number, reason, detail, actor) VALUES (?, ?, ?, ?)
    ON CONFLICT(phone_number) DO UPDATE SET reason = excluded.reason, detail = excluded.detail
  `).run(phone, reason, detail, actor);
  return db.prepare('SELECT * FROM global_suppression WHERE phone_number = ?').get(phone);
}

function removeGlobalSuppression(phoneNumber) {
  return db.prepare('DELETE FROM global_suppression WHERE phone_number = ?')
           .run(normalizePhoneNumber(phoneNumber));
}

function getGlobalSuppression() {
  return db.prepare('SELECT * FROM global_suppression ORDER BY created_at DESC').all();
}

/** Cross-tenant block check. Returns the row, or null when the number is clear. */
function isGloballySuppressed(phoneNumber) {
  const phone = normalizePhoneNumber(phoneNumber);
  if (!phone) return null;
  return db.prepare('SELECT * FROM global_suppression WHERE phone_number = ?').get(phone) || null;
}

// Initialize database schema
function initDatabase() {
  // ---- Tenancy ----------------------------------------------------------
  // Created first: every other table references a tenant.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // The single source of truth for number ownership. The primary key on `did`
  // is the enforcement: one number, one tenant, no overlap possible.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS tenant_dids (
      did TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_tenant_dids_tenant ON tenant_dids(tenant_id)`).run();

  // Per-tenant overrides. A key absent here falls back to the global settings
  // table, so a tenant only stores what it actually diverges on.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (tenant_id, key),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `).run();

  // The one list that crosses every tenant: litigators and DNC numbers that
  // nobody may text. Tenant opt-outs live on conversations and bind only the
  // tenant who was texted; this blocks everyone.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS global_suppression (
      phone_number TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT 'dnc',
      detail TEXT,
      actor TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // Create tables
  db.prepare(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL,
      name TEXT,
      last_message_text TEXT,
      last_message_at TEXT,
      stage TEXT DEFAULT 'Stage 1',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      -- Two tenants may legitimately hold the same contact. The uniqueness that
      -- matters is one conversation per contact PER TENANT.
      UNIQUE (tenant_id, phone_number),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Carried explicitly rather than inherited through conversation_id: the
      -- delivery-receipt path looks a message up by ref_id with no conversation
      -- in hand, and must still know whose message it is.
      tenant_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      direction TEXT CHECK(direction IN ('inbound', 'outbound')) NOT NULL,
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT,
      media_urls TEXT, -- JSON string array of URLs
      status TEXT CHECK(status IN ('queued', 'sending', 'sent', 'failed', 'received')) NOT NULL,
      ref_id TEXT,
      error_message TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT UNIQUE PRIMARY KEY,
      value TEXT
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      -- NULL only for a superadmin, who belongs to no tenant and may act as any.
      tenant_id INTEGER,
      role TEXT NOT NULL DEFAULT 'agent'
        CHECK (role IN ('superadmin', 'owner', 'agent')),
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      -- The tenant this session is currently acting as. For an owner/agent it
      -- is their own tenant; a superadmin may switch it.
      tenant_id INTEGER,
      expires_at TEXT NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      phone_number TEXT,
      note_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `).run();

  // Create indexes
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_notes_conversation ON notes(conversation_id)`).run();

  // Insert default settings if they don't exist
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('bulkvs_username', (process.env.BULKVS_USERNAME || '').trim());
  insertSetting.run('bulkvs_token', (process.env.BULKVS_TOKEN || '').trim());
  insertSetting.run('sender_number', (process.env.SENDER_NUMBER || '').trim());
  insertSetting.run('send_interval_ms', '2000'); // legacy global metronome; superseded by did_min_gap_ms

  // Pacing. The old model was one global 2s interval shared by every DID, which
  // is both a bot-obvious cadence and a waste of a six-number pool. These
  // defaults pace each number independently. See pacing.js.
  insertSetting.run('pacing_enabled', '1');
  insertSetting.run('did_min_gap_ms', '12000');       // per number, not global
  insertSetting.run('did_jitter_pct', '0.4');         // +/-40% so the cadence is irregular
  insertSetting.run('did_daily_cap', '300');          // per number, per day
  insertSetting.run('did_warmup_enabled', '1');       // ramp new numbers up
  insertSetting.run('did_failure_threshold', '0.5');
  insertSetting.run('did_failure_min_samples', '8');
  insertSetting.run('did_failure_pause_ms', '900000'); // 15m cooloff on a failure spike
  insertSetting.run('max_concurrent_sends', '3');

  // Quiet hours, in the RECIPIENT's local time (inferred from area code).
  // 9:00-20:00 is deliberately narrower than the 8:00-21:00 TCPA window: area
  // code to timezone inference can be off by one hour for numbers in states
  // that straddle a boundary, and the margin absorbs that error.
  insertSetting.run('quiet_hours_enabled', '1');
  insertSetting.run('quiet_start_hour', '9');
  insertSetting.run('quiet_end_hour', '20');

  // Per-recipient message variation. Off until an API key is set, so the
  // system behaves exactly as before on an untouched install.
  insertSetting.run('variation_enabled', '0');
  insertSetting.run('anthropic_api_key', '');
  insertSetting.run('variation_model', 'claude-opus-5');
  insertSetting.run('variation_batch_size', '20');
  // Distinct rewrites generated per campaign. Recipients draw from this pool
  // round-robin, and merge fields vary on top, so 25 templates over thousands
  // of contacts leaves no repeated body for a content filter to hash.
  insertSetting.run('variation_pool_size', '25');

  // Let ANTHROPIC_API_KEY in the environment fill an empty setting on any
  // startup, not just the very first one. INSERT OR IGNORE above cannot do
  // this: once the row exists (even empty) it is never touched again, so a key
  // added to .env after the first boot would silently never take effect.
  // A key already saved through the UI always wins - this only fills a blank.
  const envKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (envKey) {
    const current = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get();
    if (!current || !current.value) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'anthropic_api_key'").run(envKey);
      console.log('Anthropic API key loaded from the environment.');
    }
  }
  // Carrier credentials stay GLOBAL: one carrier account serves every tenant.
  // Blank by default - this install has no numbers and must never inherit any.
  insertSetting.run('fractel_username', '');
  insertSetting.run('fractel_password', '');
  insertSetting.run('fractel_sender_number', '');
  insertSetting.run('fractel_brand_id', '');

  // Number ownership and the rotation cursor are per-tenant now; see
  // tenant_dids and tenant_settings. The old fractel_enabled_dids CSV and the
  // fractel_did_pool_version force-reset migration are deliberately gone.
  db.prepare("DELETE FROM settings WHERE key IN ('fractel_enabled_dids', 'fractel_did_pool_version')").run();

  // Migration: Add stage column if not exists
  const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
  const hasStage = tableInfo.some(column => column.name === 'stage');
  if (!hasStage) {
    db.prepare("ALTER TABLE conversations ADD COLUMN stage TEXT DEFAULT 'Stage 1'").run();
    console.log("Database migration: Added 'stage' column to conversations table.");
  }
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_stage ON conversations(stage)`).run();

  // Migration: Add unread column if not exists
  const hasUnread = tableInfo.some(column => column.name === 'unread');
  if (!hasUnread) {
    db.prepare("ALTER TABLE conversations ADD COLUMN unread INTEGER DEFAULT 0").run();
    console.log("Database migration: Added 'unread' column to conversations table.");
  }

  // Migration: Add city column if not exists
  const hasCity = tableInfo.some(column => column.name === 'city');
  if (!hasCity) {
    db.prepare("ALTER TABLE conversations ADD COLUMN city TEXT").run();
    console.log("Database migration: Added 'city' column to conversations table.");
  }

  // Migration: Lead disposition columns (appointment / follow_up / no / unqualified / customer)
  const dispositionColumns = [
    ['disposition', "ALTER TABLE conversations ADD COLUMN disposition TEXT"],
    ['disposition_at', "ALTER TABLE conversations ADD COLUMN disposition_at TEXT"],
    ['scheduled_at', "ALTER TABLE conversations ADD COLUMN scheduled_at TEXT"],
    ['disposition_note', "ALTER TABLE conversations ADD COLUMN disposition_note TEXT"]
  ];
  dispositionColumns.forEach(([name, sql]) => {
    if (!tableInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to conversations table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_disposition ON conversations(disposition)`).run();

  // Migration: Add zip column if not exists
  const hasZip = tableInfo.some(column => column.name === 'zip');
  if (!hasZip) {
    db.prepare("ALTER TABLE conversations ADD COLUMN zip TEXT").run();
    console.log("Database migration: Added 'zip' column to conversations table.");
  }

  // Migration: the merge columns.
  //
  // Driven off MERGE_FIELDS rather than a hand-written list, so adding a field
  // to that list migrates itself. Reads table_info fresh: earlier migrations in
  // this same run may already have changed the shape captured in `tableInfo`.
  const liveColumns = db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
  for (const column of MERGE_COLUMNS) {
    if (liveColumns.includes(column)) continue;
    db.prepare(`ALTER TABLE conversations ADD COLUMN ${column} TEXT`).run();
    console.log(`Database migration: Added '${column}' column to conversations table.`);
  }

  // Migration: Add assigned_did column. Holds the FracTEL number this contact
  // is pinned to, so every message in a thread comes from the same sender.
  const hasAssignedDid = tableInfo.some(column => column.name === 'assigned_did');
  if (!hasAssignedDid) {
    db.prepare("ALTER TABLE conversations ADD COLUMN assigned_did TEXT").run();
    console.log("Database migration: Added 'assigned_did' column to conversations table.");
  }

  // Migration: permanent, auditable contact suppression.
  //
  // Suppression is stored, never inferred from the latest reply. A contact who
  // texts STOP and then texts again later stays suppressed until someone runs
  // the explicit re-opt-in workflow.
  const suppressionColumns = [
    // Reply classification of the most recent inbound message (display only).
    ['reply_classification', "ALTER TABLE conversations ADD COLUMN reply_classification TEXT"],
    // Hard suppression flag. 1 = do not contact.
    ['opted_out', "ALTER TABLE conversations ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0"],
    ['opted_out_at', "ALTER TABLE conversations ADD COLUMN opted_out_at TEXT"],
    // 'inbound_keyword' | 'manual' | 'backfill' | 'import'
    ['opt_out_source', "ALTER TABLE conversations ADD COLUMN opt_out_source TEXT"],
    // Verbatim message that triggered it, kept for the audit trail.
    ['opt_out_text', "ALTER TABLE conversations ADD COLUMN opt_out_text TEXT"],
    ['opted_in_at', "ALTER TABLE conversations ADD COLUMN opted_in_at TEXT"],
    ['opted_in_by', "ALTER TABLE conversations ADD COLUMN opted_in_by TEXT"],
    ['wrong_number', "ALTER TABLE conversations ADD COLUMN wrong_number INTEGER NOT NULL DEFAULT 0"],
    ['wrong_number_at', "ALTER TABLE conversations ADD COLUMN wrong_number_at TEXT"],
    ['suppression_reason', "ALTER TABLE conversations ADD COLUMN suppression_reason TEXT"]
  ];
  suppressionColumns.forEach(([name, sql]) => {
    if (!tableInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to conversations table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_opted_out ON conversations(opted_out)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_wrong_number ON conversations(wrong_number)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_conversations_classification ON conversations(reply_classification)`).run();

  // Migration: real carrier delivery receipts.
  //
  // The messages.status CHECK constraint cannot take a new value without
  // rebuilding the table, so delivery is tracked alongside it. status='sent'
  // means "carrier accepted"; delivered_at set means the carrier confirmed
  // handset delivery via DLR.
  const messageInfo = db.prepare("PRAGMA table_info(messages)").all();
  const messageColumns = [
    ['delivered_at', "ALTER TABLE messages ADD COLUMN delivered_at TEXT"],
    ['carrier_status', "ALTER TABLE messages ADD COLUMN carrier_status TEXT"],
    // Message variation audit trail. body always holds what was actually sent;
    // original_body holds the merged template it was rewritten from, so a
    // regulator (or an operator) can see both halves of every send.
    ['original_body', "ALTER TABLE messages ADD COLUMN original_body TEXT"],
    // 'llm' = a validated rewrite went out. 'template' = the merged template
    // went out unchanged, either because variation is off or because the
    // rewrite was rejected. NULL on pre-existing rows.
    ['variation_source', "ALTER TABLE messages ADD COLUMN variation_source TEXT"]
  ];
  messageColumns.forEach(([name, sql]) => {
    if (!messageInfo.some(column => column.name === name)) {
      db.prepare(sql).run();
      console.log(`Database migration: Added '${name}' column to messages table.`);
    }
  });
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)`).run();
  // Per-DID pacing reads send history by sending number; without this the
  // daily-cap and warm-up lookups full-scan the messages table on every start.
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_from_status ON messages(from_number, status)`).run();

  // Audit log for suppression decisions and blocked sends.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS suppression_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      conversation_id INTEGER,
      phone_number TEXT,
      event TEXT NOT NULL,
      reason TEXT,
      detail TEXT,
      actor TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_suppression_events_conv ON suppression_events(conversation_id)`).run();

  // Reminder delivery state, so a reminder fires once and survives restarts.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS reminder_state (
      tenant_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      tier TEXT NOT NULL,
      notified_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, scheduled_at, tier)
    )
  `).run();

  // Inquiries from the public recruiting page on netenroll.com. Not tenant
  // data: the form is anonymous and the rows belong to the platform operator.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recruiting_inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      agency_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      states TEXT NOT NULL,
      agent_count TEXT NOT NULL,
      offer TEXT NOT NULL,
      timing TEXT NOT NULL,
      notes TEXT,
      client_ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();

  // Bring a pre-tenancy database up to the multi-tenant shape.
  migrateToMultiTenant();

  // Run database migration to normalize existing conversation numbers
  migrateAndNormalizeDatabase();

  // Bootstrap the platform operator. There is no first-user-becomes-admin
  // signup any more: on a multi-tenant install that route lets whoever reaches
  // the login page first own the platform. A superadmin is seeded here instead,
  // and creates tenants and their owners from inside the app.
  seedSuperadmin();

  // Reset any stuck sending messages to queued status on startup
  try {
    const result = db.prepare("UPDATE messages SET status = 'queued' WHERE status = 'sending'").run();
    if (result.changes > 0) {
      console.log(`Database initialized: Reset ${result.changes} stuck 'sending' messages back to 'queued'.`);
    }
  } catch (err) {
    console.error("Failed to reset stuck sending messages:", err);
  }
}

function insertRecruitingInquiry(row) {
  return db.prepare(`
    INSERT INTO recruiting_inquiries
      (source, agency_name, contact_name, email, phone, states, agent_count, offer, timing, notes, client_ip)
    VALUES
      (@source, @agency_name, @contact_name, @email, @phone, @states, @agent_count, @offer, @timing, @notes, @client_ip)
  `).run(row).lastInsertRowid;
}

/**
 * Seed the platform superadmin if no user exists yet.
 *
 * The password comes from SUPERADMIN_PASSWORD. When that is unset a random one
 * is generated and printed once - deliberately, rather than shipping a default
 * password that every install would share.
 */
function seedSuperadmin() {
  if (countUsers() > 0) return;

  const username = (process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
  const envPassword = (process.env.SUPERADMIN_PASSWORD || '').trim();
  const password = envPassword || crypto.randomBytes(18).toString('base64url');

  createUser(username, password, { role: 'superadmin' });

  if (envPassword) {
    console.log(`Seeded superadmin '${username}' from SUPERADMIN_PASSWORD.`);
  } else {
    console.log('='.repeat(72));
    console.log(`  Seeded superadmin '${username}'`);
    console.log(`  Generated password: ${password}`);
    console.log('  This is shown ONCE. Store it now, then sign in and change it.');
    console.log('='.repeat(72));
  }
}

function normalizePhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    return cleaned === '+' ? '' : cleaned;
  }
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+' + cleaned;
  }
  return cleaned;
}

/**
 * Bring a pre-tenancy database up to the multi-tenant shape.
 *
 * A fresh install creates every table already carrying tenant_id, so this is a
 * no-op there. It exists for a database created before tenancy: those rows all
 * belong to one implicit tenant, and this gives them one rather than leaving
 * NULLs that the scoped queries would silently drop.
 */
function migrateToMultiTenant() {
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  // Only mint a legacy tenant if there is legacy data to attach to it.
  let legacyTenantId = null;
  const legacyTenant = () => {
    if (legacyTenantId) return legacyTenantId;
    const existing = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get();
    if (existing) { legacyTenantId = existing.id; return legacyTenantId; }
    legacyTenantId = db.prepare(
      "INSERT INTO tenants (name, slug, status) VALUES ('Default', 'default', 'active')"
    ).run().lastInsertRowid;
    console.log('Database migration: created the Default tenant for pre-tenancy rows.');
    return legacyTenantId;
  };

  // conversations must be REBUILT, not altered: the old table declares
  // phone_number UNIQUE and SQLite cannot drop a constraint in place.
  if (!columns('conversations').includes('tenant_id')) {
    const tenantId = legacyTenant();
    const cols = columns('conversations');
    const colList = cols.join(', ');

    db.transaction(() => {
      db.prepare('ALTER TABLE conversations RENAME TO conversations_old').run();
      db.prepare(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id INTEGER NOT NULL,
          phone_number TEXT NOT NULL,
          name TEXT,
          last_message_text TEXT,
          last_message_at TEXT,
          stage TEXT DEFAULT 'Stage 1',
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          unread INTEGER DEFAULT 0,
          city TEXT,
          zip TEXT,
          -- The rest of the merge columns. They are listed here, not just added
          -- by the ALTER above, because that ALTER runs FIRST: this rebuild then
          -- copies every column the old table has into a table declared here,
          -- and a column missing from this list fails the copy outright with
          -- "table conversations has no column named bus_name".
          bus_name TEXT,
          state TEXT,
          years TEXT,
          disposition TEXT,
          disposition_at TEXT,
          scheduled_at TEXT,
          disposition_note TEXT,
          assigned_did TEXT,
          reply_classification TEXT,
          opted_out INTEGER NOT NULL DEFAULT 0,
          opted_out_at TEXT,
          opt_out_source TEXT,
          opt_out_text TEXT,
          opted_in_at TEXT,
          opted_in_by TEXT,
          wrong_number INTEGER NOT NULL DEFAULT 0,
          wrong_number_at TEXT,
          suppression_reason TEXT,
          UNIQUE (tenant_id, phone_number),
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        )
      `).run();
      db.prepare(
        `INSERT INTO conversations (tenant_id, ${colList}) SELECT ?, ${colList} FROM conversations_old`
      ).run(tenantId);
      db.prepare('DROP TABLE conversations_old').run();
    })();
    console.log('Database migration: conversations rebuilt with UNIQUE(tenant_id, phone_number).');
  }

  // The rest only ever gained a column, so a plain ALTER is enough.
  const addTenantColumn = (table, backfillSql) => {
    if (columns(table).includes('tenant_id')) return;
    db.prepare(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER`).run();
    if (backfillSql) db.prepare(backfillSql).run();
    console.log(`Database migration: added 'tenant_id' to ${table}.`);
  };

  // messages, notes and reminder_state can recover their tenant from the
  // conversation they hang off. suppression_events may hold rows whose
  // conversation is already gone, so those fall back to the legacy tenant.
  addTenantColumn('messages',
    'UPDATE messages SET tenant_id = (SELECT c.tenant_id FROM conversations c WHERE c.id = messages.conversation_id)');
  addTenantColumn('notes',
    'UPDATE notes SET tenant_id = (SELECT c.tenant_id FROM conversations c WHERE c.id = notes.conversation_id)');
  addTenantColumn('reminder_state',
    'UPDATE reminder_state SET tenant_id = (SELECT c.tenant_id FROM conversations c WHERE c.id = reminder_state.conversation_id)');
  addTenantColumn('suppression_events',
    'UPDATE suppression_events SET tenant_id = (SELECT c.tenant_id FROM conversations c WHERE c.id = suppression_events.conversation_id)');

  const orphaned = ['messages', 'notes', 'reminder_state', 'suppression_events']
    .some(t => db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE tenant_id IS NULL`).get().c > 0);
  if (orphaned) {
    const tenantId = legacyTenant();
    for (const table of ['messages', 'notes', 'reminder_state', 'suppression_events']) {
      db.prepare(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`).run(tenantId);
    }
  }

  if (!columns('users').includes('tenant_id')) {
    db.prepare('ALTER TABLE users ADD COLUMN tenant_id INTEGER').run();
    console.log("Database migration: added 'tenant_id' to users.");
  }
  if (!columns('users').includes('role')) {
    // No CHECK constraint on an added column - SQLite cannot add one to an
    // existing table - but every write goes through createUser, which validates.
    db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'agent'").run();
    // A pre-tenancy install had exactly one admin. Promote them rather than
    // stranding them without access.
    db.prepare("UPDATE users SET role = 'superadmin' WHERE id = (SELECT MIN(id) FROM users)").run();
    console.log("Database migration: added 'role' to users; existing admin promoted to superadmin.");
  }
  if (!columns('sessions').includes('tenant_id')) {
    db.prepare('ALTER TABLE sessions ADD COLUMN tenant_id INTEGER').run();
    console.log("Database migration: added 'tenant_id' to sessions.");
  }

  // Every hot query is now scoped by tenant, so every hot index leads with it.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_conversations_tenant_phone ON conversations(tenant_id, phone_number)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_conversations_tenant_last ON conversations(tenant_id, last_message_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_tenant_conv ON messages(tenant_id, conversation_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_tenant_ref ON messages(tenant_id, ref_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_suppression_events_tenant ON suppression_events(tenant_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_reminder_state_tenant ON reminder_state(tenant_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)').run();
}

function migrateAndNormalizeDatabase() {
  // A migration, not a query path: it runs at startup over every row before any
  // request exists, so the statements below are deliberately unscoped. They are
  // still tenant-safe - the dedupe key includes tenant_id, and every write
  // targets a row this loop has already read.
  console.log("Starting database normalization and migration...");
  const conversations = db.prepare('SELECT * FROM conversations').all();

  const mergeStmt = db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?');
  const deleteConvStmt = db.prepare('DELETE FROM conversations WHERE id = ?');
  const updateConvPhoneStmt = db.prepare('UPDATE conversations SET phone_number = ? WHERE id = ?');
  const updateLastMessageStmt = db.prepare(`
    UPDATE conversations 
    SET last_message_text = ?, last_message_at = ? 
    WHERE id = ?
  `);

  db.transaction(() => {
    const normMap = {};

    for (const c of conversations) {
      const normalized = normalizePhoneNumber(c.phone_number);
      // Keyed by tenant AND number. The same contact held by two tenants is two
      // legitimate conversations, not a duplicate pair to merge - merging them
      // would hand one tenant the other's message history.
      const dedupeKey = `${c.tenant_id}|${normalized}`;

      if (normMap[dedupeKey]) {
        const targetConv = normMap[dedupeKey];
        console.log(`Merging duplicate conversation ID ${c.id} (${c.phone_number}) into target ID ${targetConv.id} (${normalized})...`);
        
        // Merge messages
        mergeStmt.run(targetConv.id, c.id);
        
        // Determine latest last_message_at
        let latestText = targetConv.last_message_text;
        let latestAt = targetConv.last_message_at;
        
        if (c.last_message_at) {
          if (!latestAt || new Date(c.last_message_at) > new Date(latestAt)) {
            latestText = c.last_message_text;
            latestAt = c.last_message_at;
          }
        }
        
        // Update target conversation last message details
        updateLastMessageStmt.run(latestText, latestAt, targetConv.id);
        
        // Update target name if not set
        if (!targetConv.name && c.name) {
          db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(c.name, targetConv.id);
          targetConv.name = c.name;
        }

        // Delete duplicate conversation
        deleteConvStmt.run(c.id);
      } else {
        if (normalized !== c.phone_number) {
          console.log(`Updating conversation ID ${c.id} phone number: ${c.phone_number} -> ${normalized}`);
          updateConvPhoneStmt.run(normalized, c.id);
          c.phone_number = normalized;
        }
        normMap[dedupeKey] = c;
      }
    }
  })();
  console.log("Database normalization and migration completed.");
}

// Helpers
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(row => {
    settings[row.key] = row.value;
  });
  return settings;
}

function updateSettings(settingsObj) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const transaction = db.transaction((obj) => {
    for (const [key, val] of Object.entries(obj)) {
      stmt.run(key, String(val));
    }
  });
  transaction(settingsObj);
  return getSettings();
}

// Strip a phone number down to the bare 10-digit form FracTEL expects.
function toDidFormat(value) {
  let cleaned = (value || '').toString().replace(/[^\d]/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

// This tenant's DIDs cleared for outbound sending, in rotation order.
// Read from tenant_dids, which is the only source of truth for ownership.
function getTenantDidPool(tenantId) {
  const id = requireTenant(tenantId);
  return db.prepare(
    'SELECT did FROM tenant_dids WHERE tenant_id = ? AND enabled = 1 ORDER BY did ASC'
  ).all(id).map(row => row.did);
}

// Advance the round-robin cursor and hand back the next DID. The read and the
// write share one transaction so concurrent sends can't land on the same number.
// The cursor is per-tenant: two tenants rotating their own pools must not share
// a counter, or one tenant's volume would skew the other's distribution.
const nextRotatingDid = db.transaction((tenantId, pool) => {
  const row = db.prepare(
    "SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = 'did_rotation_index'"
  ).get(tenantId);
  const index = parseInt(row && row.value, 10) || 0;
  const did = pool[index % pool.length];
  db.prepare(`
    INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, 'did_rotation_index', ?)
    ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
  `).run(tenantId, String((index + 1) % 1000000));
  return did;
});

function setConversationDid(tenantId, conversationId, did) {
  const id = requireTenant(tenantId);
  db.prepare('UPDATE conversations SET assigned_did = ? WHERE id = ? AND tenant_id = ?')
    .run(did, conversationId, id);
}

/**
 * Decide which number a message to `conversationId` goes out from.
 *
 * Rotation is sticky per contact rather than per message: the first outbound
 * message claims the next DID in the pool and pins it to the conversation, and
 * every later message reuses it. A contact therefore always sees one sender,
 * while the pool spreads volume across all numbers.
 *
 * Passing an explicit number overrides rotation and re-pins the conversation.
 */
function resolveSenderNumber(tenantId, conversationId, requested) {
  const id = requireTenant(tenantId);
  const settings = getEffectiveSettings(id);
  const pool = getTenantDidPool(id);
  const requestedStr = (requested || '').toString().trim();
  const wantsRotation = !requestedStr || requestedStr.toLowerCase() === ROTATE_SENDER;

  if (!wantsRotation) {
    const explicit = toDidFormat(requestedStr);
    if (explicit.length === 10) {
      // A tenant may only send from a number it owns. Without this check an
      // agent could put another tenant's DID in the request body and send from
      // it, which would also mis-attribute the reply when it came back.
      if (!pool.includes(explicit)) {
        throw new Error(`DID ${explicit} is not assigned to this tenant`);
      }
      if (conversationId) setConversationDid(id, conversationId, explicit);
      return explicit;
    }
    // Not a US 10-digit number (e.g. the legacy BulkVS sender) - pass through.
    return requestedStr;
  }

  if (!pool.length) {
    return toDidFormat(settings.fractel_sender_number) || settings.sender_number || '';
  }

  if (conversationId) {
    const row = db.prepare('SELECT assigned_did FROM conversations WHERE id = ? AND tenant_id = ?')
                  .get(conversationId, id);
    const existing = row && row.assigned_did;
    // Only reuse a pinned DID that is still in the pool; a retired number
    // falls through to rotation instead of failing to send.
    if (existing && pool.includes(existing)) {
      return existing;
    }
  }

  const did = nextRotatingDid(id, pool);
  if (conversationId) setConversationDid(id, conversationId, did);
  return did;
}

// The sidebar shows a one-line preview. Sending whole message bodies for every
// contact costs about 1.5 MB of the response and none of it is ever displayed.
const PREVIEW_CHARS = 140;

function getConversations(tenantId) {
  const tid = requireTenant(tenantId);
  return db.prepare(`
    SELECT c.*,
           (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message_direction,
           (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND direction = 'inbound') as last_inbound_at,
           (SELECT substr(body, 1, ${PREVIEW_CHARS}) FROM messages WHERE conversation_id = c.id AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1) as last_inbound_text
    FROM conversations c
    WHERE c.tenant_id = ?
    ORDER BY
      CASE WHEN last_inbound_at IS NOT NULL THEN 0 ELSE 1 END,
      last_inbound_at DESC,
      last_message_at DESC,
      created_at DESC
  `).all(tid);
}

/**
 * The conversation list for the sidebar.
 *
 * Identical to getConversations() except the preview string is cut to what the
 * list actually renders. An earlier version also dropped columns the list does
 * not read, which broke the opt-out audit fields the detail pane needs - the
 * integration suite caught it. Responses are gzipped now, so trimming columns
 * bought very little and risked a lot; every field is kept.
 */

/**
 * One conversation by id, within this tenant.
 *
 * The tenant_id in the WHERE clause is what turns another tenant's id into a
 * miss rather than a read. Callers surface that as a 404, so an agent walking
 * integers cannot even tell whether the row exists.
 */
function getConversationById(tenantId, id) {
  const tid = requireTenant(tenantId);
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, tid) || null;
}

function getConversationsForList(tenantId) {
  return getConversations(tenantId).map(row => ({
    ...row,
    last_message_text: row.last_message_text
      ? String(row.last_message_text).slice(0, PREVIEW_CHARS)
      : row.last_message_text
  }));
}

/**
 * Find or create this tenant's conversation with a contact.
 *
 * `contactName`, `city` and `zip` stay positional because a dozen call sites
 * already pass them that way; everything else arrives in `extra`, keyed by
 * merge column. Both are folded into one object and the merge fields are then
 * handled as a list - the previous version carried a near-identical if-block
 * per field, which is how a fourth field gets added to the insert and forgotten
 * in the update.
 */
function getOrCreateConversation(tenantId, phoneNumber, contactName = null, city = null, zip = null, extra = null) {
  const tid = requireTenant(tenantId);
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone) {
    throw new Error("Invalid phone number");
  }

  const incoming = Object.assign({ name: contactName, city, zip }, extra || {});

  // Scoped by tenant: two tenants holding the same contact get two independent
  // conversations, which is the whole point of UNIQUE(tenant_id, phone_number).
  let conv = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND phone_number = ?')
               .get(tid, cleanPhone);
  if (!conv) {
    try {
      // tenant_id and phone_number are written literally rather than folded
      // into the generated column list. The scoping audit reads this file as
      // text, and a statement whose tenant column only appears at runtime is a
      // statement it cannot vouch for - which is exactly the kind it exists to
      // catch. Keeping them visible costs nothing and keeps the check honest.
      const placeholders = MERGE_COLUMNS.map(() => '?').join(', ');
      const result = db.prepare(
        `INSERT INTO conversations (tenant_id, phone_number, ${MERGE_COLUMNS.join(', ')})
         VALUES (?, ?, ${placeholders})`
      ).run(tid, cleanPhone, ...MERGE_COLUMNS.map(c => (incoming[c] == null ? null : incoming[c])));

      conv = {
        id: result.lastInsertRowid,
        tenant_id: tid,
        phone_number: cleanPhone,
        last_message_text: null,
        last_message_at: null,
        created_at: new Date().toISOString()
      };
      for (const column of MERGE_COLUMNS) {
        conv[column] = incoming[column] == null ? null : incoming[column];
      }
    } catch (e) {
      // Handle race condition
      conv = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND phone_number = ?')
               .get(tid, cleanPhone);
    }
  } else {
    const updateFields = [];
    const updateValues = [];

    // Only a supplied value overwrites: a later import that omits a column must
    // not blank what an earlier one filled in.
    for (const column of MERGE_COLUMNS) {
      const value = incoming[column];
      if (value == null || value === '') continue;
      if (conv[column] === value) continue;
      conv[column] = value;
      updateFields.push(`${column} = ?`);
      updateValues.push(value);
    }

    if (updateFields.length) {
      updateValues.push(conv.id, tid);
      db.prepare(`UPDATE conversations SET ${updateFields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...updateValues);
    }
  }
  return conv;
}


function getMessages(tenantId, conversationId) {
  const tid = requireTenant(tenantId);
  return db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ? AND tenant_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(conversationId, tid);
}

function insertMessage(tenantId, msg) {
  const tid = requireTenant(tenantId);

  // The conversation must belong to this tenant. Without this a caller could
  // attach a message to someone else's thread by passing a foreign id.
  const owner = db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?')
                  .get(msg.conversation_id, tid);
  if (!owner) {
    throw new Error(`Conversation ${msg.conversation_id} does not belong to tenant ${tid}`);
  }

  const result = db.prepare(`
    INSERT INTO messages (
      tenant_id, conversation_id, direction, from_number, to_number, body, media_urls, status, scheduled_at, ref_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tid,
    msg.conversation_id,
    msg.direction,
    msg.from_number,
    msg.to_number,
    msg.body || '',
    msg.media_urls ? JSON.stringify(msg.media_urls) : null,
    msg.status,
    msg.scheduled_at || null,
    // Inbound carries the carrier's own message id. Storing it is what makes
    // the webhook idempotent - see inboundExists().
    msg.ref_id || null
  );
  
  const inserted = {
    id: result.lastInsertRowid,
    tenant_id: tid,
    ...msg
  };

  // Update last message in conversation
  db.prepare(`
    UPDATE conversations
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime')
    WHERE id = ? AND tenant_id = ?
  `).run(msg.body || (msg.media_urls ? '[Attachment]' : ''), msg.conversation_id, tid);

  // Auto-transition to responded substage if inbound reply
  if (msg.direction === 'inbound') {
    db.prepare("UPDATE conversations SET unread = 1 WHERE id = ? AND tenant_id = ?").run(msg.conversation_id, tid);

    // Classify the reply and persist suppression. recordOptOut is idempotent
    // and first-wins, so a later message never overwrites an earlier opt-out,
    // and a later non-opt-out message never clears one.
    const replyClass = classification.classifyReply(msg.body);
    db.prepare('UPDATE conversations SET reply_classification = ? WHERE id = ? AND tenant_id = ?')
      .run(replyClass, msg.conversation_id, tid);

    if (replyClass === classification.CLASSIFICATIONS.OPT_OUT) {
      recordOptOut(tid, msg.conversation_id, { source: 'inbound_keyword', text: msg.body });
    } else if (replyClass === classification.CLASSIFICATIONS.WRONG_NUMBER) {
      recordWrongNumber(tid, msg.conversation_id, { source: 'inbound_keyword', text: msg.body });
    }

    const conv = db.prepare('SELECT stage FROM conversations WHERE id = ? AND tenant_id = ?').get(msg.conversation_id, tid);
    if (conv) {
      let newStage = conv.stage;
      if (conv.stage === 'Stage 1') newStage = 'Stage 1-Responded';
      else if (conv.stage === 'Stage 2') newStage = 'Stage 2-Responded';
      else if (conv.stage === 'Stage 3') newStage = 'Stage 3-Responded';
      
      if (newStage !== conv.stage) {
        db.prepare('UPDATE conversations SET stage = ? WHERE id = ? AND tenant_id = ?').run(newStage, msg.conversation_id, tid);
      }
    }
  }

  // Auto-transition if manual outbound message sent directly
  if (msg.direction === 'outbound') {
    db.prepare("UPDATE conversations SET unread = 0 WHERE id = ? AND tenant_id = ?").run(msg.conversation_id, tid);
    const conv = db.prepare('SELECT stage FROM conversations WHERE id = ? AND tenant_id = ?').get(msg.conversation_id, tid);
    if (conv && ['Stage 1', 'Stage 2', 'Stage 3'].includes(conv.stage)) {
      const outboundCount = db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE conversation_id = ? AND tenant_id = ? AND direction = 'outbound' AND status = 'sent'
      `).get(msg.conversation_id, tid).count;

      let newStage = 'Stage 1';
      if (outboundCount === 1) newStage = 'Stage 2';
      else if (outboundCount >= 2) newStage = 'Stage 3';

      if (newStage !== conv.stage) {
        db.prepare('UPDATE conversations SET stage = ? WHERE id = ? AND tenant_id = ?').run(newStage, msg.conversation_id, tid);
      }
    }
  }

  return inserted;
}

function updateMessageStatus(tenantId, id, status, refId = null, errorMessage = null) {
  const tid = requireTenant(tenantId);
  if (status === 'sent') {
    db.prepare(`
      UPDATE messages
      SET status = ?, ref_id = ?, sent_at = datetime('now', 'localtime')
      WHERE id = ? AND tenant_id = ?
    `).run(status, refId, id, tid);

    // Update conversation stage if outbound
    const msg = db.prepare('SELECT conversation_id, direction FROM messages WHERE id = ? AND tenant_id = ?').get(id, tid);
    if (msg && msg.direction === 'outbound') {
      const conv = db.prepare('SELECT stage FROM conversations WHERE id = ? AND tenant_id = ?').get(msg.conversation_id, tid);
      if (conv && ['Stage 1', 'Stage 2', 'Stage 3'].includes(conv.stage)) {
        const outboundCount = db.prepare(`
          SELECT COUNT(*) as count FROM messages
          WHERE conversation_id = ? AND tenant_id = ? AND direction = 'outbound' AND status = 'sent'
        `).get(msg.conversation_id, tid).count;

        let newStage = 'Stage 1';
        if (outboundCount === 2) newStage = 'Stage 2';
        else if (outboundCount >= 3) newStage = 'Stage 3';

        if (newStage !== conv.stage) {
          db.prepare('UPDATE conversations SET stage = ? WHERE id = ? AND tenant_id = ?').run(newStage, msg.conversation_id, tid);
        }
      }
    }
  } else if (status === 'failed') {
    db.prepare(`
      UPDATE messages
      SET status = ?, error_message = ?
      WHERE id = ? AND tenant_id = ?
    `).run(status, errorMessage, id, tid);
  } else {
    db.prepare(`
      UPDATE messages
      SET status = ?
      WHERE id = ? AND tenant_id = ?
    `).run(status, id, tid);
  }
}

/* ------------------------------------------------------------------
 * Reminder state
 *
 * Persisted so a reminder fires once per (conversation, scheduled time,
 * tier) and survives refreshes and restarts. Rescheduling clears the rows
 * for the old time, so a moved appointment can remind again.
 * ------------------------------------------------------------------ */
const REMINDER_TIERS = ['overdue', 'due_now', 'due_15', 'due_60'];

function getNotifiedReminders(tenantId) {
  const tid = requireTenant(tenantId);
  // Only rows still matching a live schedule matter; the rest are noise.
  return db.prepare(`
    SELECT r.conversation_id, r.scheduled_at, r.tier, r.notified_at
    FROM reminder_state r
    JOIN conversations c ON c.id = r.conversation_id AND c.scheduled_at = r.scheduled_at
    WHERE r.tenant_id = ? AND c.tenant_id = ?
  `).all(tid, tid);
}

function acknowledgeReminder(tenantId, conversationId, scheduledAt, tier) {
  const tid = requireTenant(tenantId);
  const owned = db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?')
                  .get(conversationId, tid);
  if (!owned) return null;
  db.prepare(`
    INSERT OR IGNORE INTO reminder_state (tenant_id, conversation_id, scheduled_at, tier)
    VALUES (?, ?, ?, ?)
  `).run(tid, conversationId, scheduledAt, tier);
  console.log(`[reminder] delivered ${tier} for conversation ${conversationId} @ ${scheduledAt}Z`);
}

/**
 * Record a carrier delivery receipt. status='sent' only means the carrier
 * accepted the message; this is the only signal that it reached a handset.
 */
function recordDelivery(tenantId, messageId, carrierStatus) {
  const tid = requireTenant(tenantId);
  db.prepare(`
    UPDATE messages
    SET delivered_at = datetime('now'), carrier_status = ?
    WHERE id = ? AND tenant_id = ?
  `).run(carrierStatus || 'DELIVRD', messageId, tid);
}

/** Record a non-delivery carrier status without claiming delivery. */
function recordCarrierStatus(tenantId, messageId, carrierStatus) {
  const tid = requireTenant(tenantId);
  db.prepare('UPDATE messages SET carrier_status = ? WHERE id = ? AND tenant_id = ?')
    .run(carrierStatus, messageId, tid);
}

/**
 * Find an outbound message by the carrier's reference id.
 *
 * Deliberately NOT tenant-scoped, and the only such read of a tenant-owned
 * table. A delivery receipt arrives from the carrier with nothing but a ref_id;
 * this is where the owning tenant is DISCOVERED. The row carries tenant_id, and
 * the webhook uses it to scope every write that follows.
 */
/**
 * Has this exact inbound message already been stored?
 *
 * Carriers deliver the same message more than once: a retry after a slow
 * response, or - as happened here - two separate callbacks configured on the
 * same number both firing. The carrier's message id is stable across all of
 * those, so it is the thing to key on.
 *
 * Scoped to the tenant and to inbound, so it can never collide with an
 * outbound row that happens to carry the same ref_id from a send receipt.
 */
function inboundExists(tenantId, refId) {
  const tid = requireTenant(tenantId);
  if (!refId) return false;
  return !!db.prepare(
    `SELECT 1 FROM messages WHERE tenant_id = ? AND ref_id = ? AND direction = 'inbound'`
  ).get(tid, String(refId));
}

function getMessageByRefId(refId) {
  if (!refId) return null;
  return db.prepare('SELECT * FROM messages WHERE ref_id = ?').get(refId) || null;
}

// Queue functions
//
// A message can sit in the queue (or be future-scheduled) for a long time. If
// the contact opts out in the meantime, the queued message must NOT go out, so
// the queue re-checks suppression at dequeue time rather than trusting the
// check performed when the row was created.
function getNextQueuedMessage() {
  return db.prepare(`
    SELECT * FROM messages
    WHERE status = 'queued'
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get();
}

/**
 * A window of due messages for the pacing layer to choose from.
 *
 * The old worker took the single oldest queued message and slept a fixed
 * interval. That serialises the whole pool behind one number. Handing the
 * worker a window instead lets it skip a message whose DID is rate limited or
 * whose recipient is asleep, and send one that is eligible right now.
 *
 * Ordered oldest-first, so the queue still drains in FIFO order within each DID.
 */
// Substitution lives in merge_fields.js, re-exported here because the import
// and campaign paths have always reached for it on the db module.

/**
 * The widest merge values a campaign will actually substitute.
 *
 * A template cannot be measured for length directly: "[Name]" is six characters
 * but becomes "Christopher" or "Jo". To know what a message really costs, the
 * placeholders have to be filled at the widest values in the contact list.
 *
 * The 95th percentile is used rather than the absolute maximum: a single
 * pathological row (a whole address pasted into the name field) would otherwise
 * make every template look like it needs an extra segment.
 */
function getPlaceholderWidths(tenantId, conversationIds = null) {
  const tid = requireTenant(tenantId);
  const percentile = (column, ids) => {
    const scope = ids && ids.length
      ? `AND id IN (${ids.map(() => '?').join(',')})`
      : '';
    const rows = db.prepare(`
      SELECT length(${column}) AS len
      FROM conversations
      WHERE tenant_id = ? AND ${column} IS NOT NULL AND ${column} <> '' ${scope}
      ORDER BY len ASC
    `).all(tid, ...(ids && ids.length ? ids : []));
    if (!rows.length) return null;
    return rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.95))].len;
  };

  // A large explicit recipient list would blow past SQLite's variable limit,
  // so scope only when it is small enough to bind safely.
  const ids = Array.isArray(conversationIds) && conversationIds.length <= 500
    ? conversationIds
    : null;

  const widths = {};
  for (const column of MERGE_COLUMNS) {
    widths[column] = percentile(column, ids) || DEFAULT_MERGE_WIDTHS[column];
  }
  return widths;
}

/**
 * Pick this recipient's template from a variant pool.
 *
 * Variants are generated from the template with its placeholders intact, then
 * merged per recipient. That way one small pool (a couple of LLM calls) covers
 * a whole campaign, and because the merge fields differ per contact the actual
 * bodies that go out are close to unique anyway.
 *
 * Index 0 is always the original approved template, so a pool of size 1 is the
 * old behaviour exactly.
 */
function pickVariant(pool, index) {
  if (!Array.isArray(pool) || pool.length === 0) return { text: null, source: 'template' };
  const slot = index % pool.length;
  return { text: pool[slot], source: slot === 0 ? 'template' : 'llm' };
}

function getDueQueuedMessages(limit = 200) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE status = 'queued'
    AND direction = 'outbound'
    AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(limit);
}

/**
 * Surface messages left in 'sending' by a crash or restart.
 *
 * 'sending' is written just before the carrier call and overwritten by the
 * result, so a row still in that state at startup belongs to a process that
 * died mid-send. It is not safe to re-queue: the carrier may well have accepted
 * it, and re-sending would double-text the contact. It is also not safe to
 * ignore, because the row sits invisible forever and the concurrency this
 * worker now uses makes several at once possible.
 *
 * So they are failed with an explicit message and left for a human to judge
 * against the carrier's own logs.
 */
function failStaleSendingMessages(olderThanMinutes = 15) {
  // Deliberately NOT tenant-scoped. The queue worker is a single global
  // process; a crash strands rows across every tenant at once, and there is no
  // caller with a tenant to scope to at startup.
  const result = db.prepare(`
    UPDATE messages
    SET status = 'failed',
        error_message = 'Interrupted mid-send (server restarted). Check the carrier log before resending.'
    WHERE status = 'sending'
      AND created_at <= datetime('now', 'localtime', ?)
  `).run(`-${Math.max(1, olderThanMinutes)} minutes`);

  if (result.changes > 0) {
    console.warn(`[queue] ${result.changes} message(s) were stuck in 'sending' from a previous run and have been marked failed for review.`);
  }
  return result.changes;
}

/**
 * Send history per DID, used to seed the in-memory pacing state on start.
 *
 * Without this a restart hands every number a fresh daily allowance and forgets
 * that it is already past its warm-up, which is exactly the volume spike the
 * warm-up exists to prevent.
 *
 * from_number is normalised in JS rather than SQL because the column holds a
 * mix of 10-digit FracTEL DIDs and the legacy +1-prefixed BulkVS sender.
 * sent_at is written with datetime('now','localtime'), so date(sent_at) is the
 * server-local day and matches the pacer's own day boundary.
 */
function getDidSendSummary() {
  const rows = db.prepare(`
    SELECT
      from_number,
      MIN(date(sent_at)) AS first_send_day,
      SUM(CASE WHEN date(sent_at) = date('now', 'localtime') THEN 1 ELSE 0 END) AS sent_today
    FROM messages
    WHERE status = 'sent'
      AND direction = 'outbound'
      AND sent_at IS NOT NULL
    GROUP BY from_number
  `).all();

  const today = new Date().toLocaleDateString('en-CA');
  const summary = {};
  for (const row of rows) {
    const key = toDidFormat(row.from_number) || String(row.from_number || '').replace(/\D/g, '');
    if (!key) continue;
    const existing = summary[key];
    const firstDay = existing && existing.firstSendDay < row.first_send_day
      ? existing.firstSendDay
      : row.first_send_day;
    summary[key] = {
      firstSendDay: firstDay,
      sentToday: (existing ? existing.sentToday : 0) + (row.sent_today || 0),
      day: today
    };
  }
  return summary;
}

/**
 * Cancel a queued message whose contact became suppressed after it was queued.
 * Returns the block when the message was cancelled, or null when it may send.
 */
function cancelIfSuppressed(msg) {
  if (!msg || msg.direction !== 'outbound') return null;
  // The queue worker is global, but every message row carries its own tenant,
  // so the suppression check stays inside that tenant's data.
  const tid = requireTenant(msg.tenant_id);

  const block = getSuppressionBlock(tid, msg.conversation_id, { scope: 'individual' });
  if (!block) return null;

  db.prepare(`
    UPDATE messages
    SET status = 'failed', error_message = ?
    WHERE id = ? AND tenant_id = ?
  `).run(`Blocked before send: ${block.label}`, msg.id, tid);

  logSuppressionEvent(tid, msg.conversation_id, msg.to_number, 'blocked_send', block.reason,
                      `queued message ${msg.id} cancelled at dequeue`, 'queue');
  console.warn(`[suppression] queued message ${msg.id} cancelled: ${block.label}`);
  return block;
}

function getQueueStats(tenantId) {
  const tid = requireTenant(tenantId);
  const stats = db.prepare(`
    SELECT
      SUM(case when status='queued' then 1 else 0 end) as queued,
      SUM(case when status='sending' then 1 else 0 end) as sending,
      SUM(case when status='sent' then 1 else 0 end) as sent,
      SUM(case when status='failed' then 1 else 0 end) as failed
    FROM messages
    WHERE tenant_id = ?
  `).get(tid);
  
  return {
    queued: stats.queued || 0,
    sending: stats.sending || 0,
    sent: stats.sent || 0,
    failed: stats.failed || 0
  };
}

/* ==================================================================
 * Contact suppression
 *
 * Suppression is PERSISTED STATE, never inferred from the latest reply.
 * A contact who texts STOP and then texts again next week is still
 * suppressed. The only way out is the explicit re-opt-in workflow.
 *
 * Two independent axes:
 *   - Legal/hard suppression: opted_out, wrong_number.
 *   - Business disposition:   no, unqualified, customer.
 * Both block bulk sending. Only the first blocks individual sending.
 * ================================================================== */

// Dispositions excluded from bulk sends. These are business decisions, not
// legal opt-outs, so a human may still message them one to one.
const BLOCKED_DISPOSITIONS = ['no', 'unqualified', 'customer'];

const SUPPRESSION_REASONS = {
  GLOBAL_DNC: 'global_dnc',
  OPTED_OUT: 'opted_out',
  WRONG_NUMBER: 'wrong_number',
  DISPOSITION_NO: 'disposition_no',
  DISPOSITION_UNQUALIFIED: 'disposition_unqualified',
  DISPOSITION_CUSTOMER: 'disposition_customer',
  MISSING: 'missing_conversation'
};

const SUPPRESSION_LABELS = {
  global_dnc: 'Global do-not-contact',
  opted_out: 'Opted out',
  wrong_number: 'Wrong number',
  disposition_no: 'Marked No',
  disposition_unqualified: 'Marked Unqualified',
  disposition_customer: 'Already a customer',
  missing_conversation: 'Conversation not found'
};

function logSuppressionEvent(tenantId, conversationId, phoneNumber, event, reason, detail, actor) {
  const tid = requireTenant(tenantId);
  try {
    db.prepare(`
      INSERT INTO suppression_events (tenant_id, conversation_id, phone_number, event, reason, detail, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(tid, conversationId || null, phoneNumber || null, event, reason || null,
           detail ? String(detail).slice(0, 500) : null, actor || null);
  } catch (err) {
    // The audit log must never break a send path.
    console.error('[suppression] failed to write audit event:', err.message);
  }
}

/**
 * Record a permanent opt-out. Idempotent: the FIRST opt-out wins so the audit
 * trail keeps the original message and timestamp.
 */
function recordOptOut(tenantId, conversationId, { source = 'inbound_keyword', text = null, actor = null } = {}) {
  const tid = requireTenant(tenantId);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
  if (!conv) return null;
  if (conv.opted_out) return conv; // already suppressed - do not overwrite

  db.prepare(`
    UPDATE conversations
    SET opted_out = 1,
        opted_out_at = datetime('now'),
        opt_out_source = ?,
        opt_out_text = ?,
        suppression_reason = 'opted_out',
        opted_in_at = NULL,
        opted_in_by = NULL
    WHERE id = ? AND tenant_id = ?
  `).run(source, text ? String(text).slice(0, 500) : null, conversationId, tid);

  logSuppressionEvent(tid, conversationId, conv.phone_number, 'opt_out', source, text, actor);
  console.log(`[suppression] opt-out recorded for conversation ${conversationId} (source=${source})`);
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
}

/** Flag a number as belonging to the wrong person. Idempotent. */
function recordWrongNumber(tenantId, conversationId, { source = 'inbound_keyword', text = null, actor = null } = {}) {
  const tid = requireTenant(tenantId);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
  if (!conv) return null;
  if (conv.wrong_number) return conv;

  db.prepare(`
    UPDATE conversations
    SET wrong_number = 1,
        wrong_number_at = datetime('now'),
        suppression_reason = COALESCE(suppression_reason, 'wrong_number')
    WHERE id = ? AND tenant_id = ?
  `).run(conversationId, tid);

  logSuppressionEvent(tid, conversationId, conv.phone_number, 'wrong_number', source, text, actor);
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
}

/**
 * Explicit re-opt-in. This is the ONLY thing that clears an opt-out, and it
 * requires a named actor. Nothing automatic ever calls this.
 */
function recordOptIn(tenantId, conversationId, actor) {
  const tid = requireTenant(tenantId);
  if (!actor) throw new Error('Re-opt-in requires an actor');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
  if (!conv) return null;

  // A re-opt-in is a tenant decision and cannot clear the global list: a
  // litigator stays blocked no matter which tenant tries to reinstate them.
  const global = isGloballySuppressed(conv.phone_number);
  if (global) {
    throw new Error(`${conv.phone_number} is on the global do-not-contact list and cannot be re-opted in`);
  }

  db.prepare(`
    UPDATE conversations
    SET opted_out = 0,
        wrong_number = 0,
        opted_in_at = datetime('now'),
        opted_in_by = ?,
        suppression_reason = NULL
    WHERE id = ? AND tenant_id = ?
  `).run(String(actor).slice(0, 120), conversationId, tid);

  logSuppressionEvent(tid, conversationId, conv.phone_number, 'opt_in', 'manual',
                      `previous opt-out: ${conv.opt_out_text || 'n/a'}`, actor);
  console.log(`[suppression] re-opt-in for conversation ${conversationId} by ${actor}`);
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversationId, tid);
}

/**
 * THE single suppression gate. Every outbound path calls this.
 *
 * @param {object|number} conversation  conversation row or id
 * @param {object} options
 *        options.scope 'individual' blocks only hard suppression;
 *                      'bulk' (default) also blocks business dispositions.
 * @returns {null|{reason, label, hard}}  null when sending is allowed
 */
function getSuppressionBlock(tenantId, conversation, { scope = 'bulk' } = {}) {
  const tid = requireTenant(tenantId);
  const conv = typeof conversation === 'object' && conversation !== null
    ? conversation
    : db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(conversation, tid);

  if (!conv) {
    return { reason: SUPPRESSION_REASONS.MISSING, label: SUPPRESSION_LABELS.missing_conversation, hard: true };
  }
  // A row handed in as an object still has to belong to this tenant.
  if (conv.tenant_id !== undefined && conv.tenant_id !== null && Number(conv.tenant_id) !== tid) {
    return { reason: SUPPRESSION_REASONS.MISSING, label: SUPPRESSION_LABELS.missing_conversation, hard: true };
  }

  // The global list outranks everything and is checked first: it blocks every
  // tenant, and no tenant-level state can clear it.
  if (isGloballySuppressed(conv.phone_number)) {
    return { reason: SUPPRESSION_REASONS.GLOBAL_DNC, label: SUPPRESSION_LABELS.global_dnc, hard: true };
  }

  // Hard suppression applies to every path, including one-to-one sends.
  if (conv.opted_out) {
    return { reason: SUPPRESSION_REASONS.OPTED_OUT, label: SUPPRESSION_LABELS.opted_out, hard: true };
  }
  if (conv.wrong_number) {
    return { reason: SUPPRESSION_REASONS.WRONG_NUMBER, label: SUPPRESSION_LABELS.wrong_number, hard: true };
  }

  if (scope === 'individual') return null;

  if (conv.disposition && BLOCKED_DISPOSITIONS.includes(conv.disposition)) {
    const reason = `disposition_${conv.disposition}`;
    return { reason, label: SUPPRESSION_LABELS[reason], hard: false };
  }

  return null;
}

/** Convenience wrapper used by the bulk paths. Returns a reason string or null. */
function getBulkSendBlockReason(tenantId, conv) {
  const block = getSuppressionBlock(tenantId, conv, { scope: 'bulk' });
  return block ? block.reason : null;
}

/**
 * Scan EVERY historical inbound message (not just the latest) and permanently
 * suppress contacts who ever sent explicit opt-out language.
 *
 * Idempotent: contacts already opted out are left untouched so the original
 * timestamp and message survive. A manual re-opt-in is also respected — if
 * someone was deliberately opted back in after the opt-out, we do not undo it.
 *
 * A plain "No" is NOT treated as a legal opt-out here; it is counted under
 * ambiguous so a human can decide.
 */
function backfillSuppression(tenantId, { dryRun = false } = {}) {
  const tid = requireTenant(tenantId);
  const summary = {
    conversations_scanned: 0,
    inbound_messages_scanned: 0,
    opt_outs_identified: 0,
    wrong_numbers_identified: 0,
    records_updated: 0,
    already_suppressed: 0,
    skipped_due_to_opt_in: 0,
    ambiguous_left_for_review: 0,
    dry_run: dryRun
  };

  const conversations = db.prepare('SELECT * FROM conversations WHERE tenant_id = ?').all(tid);
  summary.conversations_scanned = conversations.length;

  const inboundStmt = db.prepare(`
    SELECT id, body, created_at FROM messages
    WHERE conversation_id = ? AND tenant_id = ? AND direction = 'inbound'
    ORDER BY created_at ASC, id ASC
  `);

  const apply = db.transaction(() => {
    for (const conv of conversations) {
      const inbound = inboundStmt.all(conv.id, tid);
      summary.inbound_messages_scanned += inbound.length;

      let firstOptOut = null;
      let firstWrongNumber = null;
      let sawNegative = false;

      for (const msg of inbound) {
        const cls = classification.classifyReply(msg.body);
        if (cls === classification.CLASSIFICATIONS.OPT_OUT && !firstOptOut) {
          firstOptOut = msg;
        } else if (cls === classification.CLASSIFICATIONS.WRONG_NUMBER && !firstWrongNumber) {
          firstWrongNumber = msg;
        } else if (cls === classification.CLASSIFICATIONS.NEGATIVE) {
          sawNegative = true;
        }
      }

      if (firstOptOut) summary.opt_outs_identified++;
      if (firstWrongNumber) summary.wrong_numbers_identified++;
      if (!firstOptOut && !firstWrongNumber && sawNegative) summary.ambiguous_left_for_review++;

      // Someone was explicitly opted back in after their opt-out; respect that.
      if (conv.opted_in_at && conv.opted_in_by) {
        if (firstOptOut || firstWrongNumber) summary.skipped_due_to_opt_in++;
        continue;
      }

      if (conv.opted_out && firstOptOut) {
        summary.already_suppressed++;
        continue;
      }

      let updated = false;

      if (firstOptOut && !conv.opted_out) {
        if (!dryRun) {
          db.prepare(`
            UPDATE conversations
            SET opted_out = 1,
                opted_out_at = ?,
                opt_out_source = 'backfill',
                opt_out_text = ?,
                suppression_reason = 'opted_out'
            WHERE id = ? AND tenant_id = ?
          `).run(firstOptOut.created_at, String(firstOptOut.body || '').slice(0, 500), conv.id, tid);
          logSuppressionEvent(tid, conv.id, conv.phone_number, 'opt_out', 'backfill', firstOptOut.body, 'backfill');
        }
        updated = true;
      }

      if (firstWrongNumber && !conv.wrong_number) {
        if (!dryRun) {
          db.prepare(`
            UPDATE conversations
            SET wrong_number = 1,
                wrong_number_at = ?,
                suppression_reason = COALESCE(suppression_reason, 'wrong_number')
            WHERE id = ? AND tenant_id = ?
          `).run(firstWrongNumber.created_at, conv.id, tid);
          logSuppressionEvent(tid, conv.id, conv.phone_number, 'wrong_number', 'backfill', firstWrongNumber.body, 'backfill');
        }
        updated = true;
      }

      // Keep the display classification in step with the newest reply.
      if (!dryRun && inbound.length) {
        const latest = inbound[inbound.length - 1];
        db.prepare('UPDATE conversations SET reply_classification = ? WHERE id = ? AND tenant_id = ?')
          .run(classification.classifyReply(latest.body), conv.id, tid);
      }

      if (updated) summary.records_updated++;
    }
  });

  apply();
  return summary;
}

function bulkImportLeads(tenantId, leads, messageTemplate, fromNumber = null, options = {}) {
  const tid = requireTenant(tenantId);
  const variantPool = options.variantPool || null;
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      tenant_id, conversation_id, direction, from_number, to_number, body, status,
      original_body, variation_source
    ) VALUES (?, ?, 'outbound', ?, ?, ?, 'queued', ?, ?)
  `);

  const updateConvStmt = db.prepare(`
    UPDATE conversations
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime'), stage = 'Stage 1'
    WHERE id = ? AND tenant_id = ?
  `);

  const insertedMessages = [];
  const skipped = [];
  const result = {
    total_submitted: 0,
    new_contacts: 0,
    existing_contacts: 0,
    contacts_updated: 0,
    invalid_rows: 0,
    duplicate_rows: 0,
    messages_queued: 0,
    skipped_suppressed: 0,
    skipped_opted_out: 0,
    skipped_wrong_number: 0,
    skipped_disposition: 0,
    errors: []
  };

  const existsStmt = db.prepare('SELECT id FROM conversations WHERE tenant_id = ? AND phone_number = ?');
  const seenPhones = new Set();

  const transaction = db.transaction((leadsList) => {
    for (const lead of leadsList) {
      result.total_submitted++;

      const normalized = normalizePhoneNumber(lead && lead.phone_number);
      if (!normalized || normalized.replace(/\D/g, '').length < 10) {
        result.invalid_rows++;
        continue;
      }
      if (seenPhones.has(normalized)) {
        result.duplicate_rows++;
        continue;
      }
      seenPhones.add(normalized);

      // Distinguish genuinely new contacts from ones we already had, BEFORE
      // the upsert. Previously every row counted as "imported", including
      // rows that were then skipped.
      const preexisting = existsStmt.get(tid, normalized);

      let conv;
      try {
        conv = getOrCreateConversation(tid, normalized, lead.name, lead.city, lead.zip, lead);
      } catch (err) {
        result.invalid_rows++;
        result.errors.push({ phone_number: normalized, error: err.message });
        continue;
      }

      if (preexisting) {
        result.existing_contacts++;
      } else {
        result.new_contacts++;
      }

      // Re-importing must not resurrect someone who opted out or was closed.
      // Note this runs BEFORE the stage reset, so a suppressed contact keeps
      // whatever stage they already had.
      const blockReason = getBulkSendBlockReason(tid, conv);
      if (blockReason) {
        skipped.push({ id: conv.id, phone_number: conv.phone_number, reason: blockReason });
        result.skipped_suppressed++;
        if (blockReason === 'opted_out') result.skipped_opted_out++;
        else if (blockReason === 'wrong_number') result.skipped_wrong_number++;
        else result.skipped_disposition++;
        logSuppressionEvent(tid, conv.id, conv.phone_number, 'blocked_send', blockReason,
                            'csv import', 'import');
        continue;
      }

      result.contacts_updated++;

      // Reset stage to Stage 1 upon re-import/new import
      db.prepare("UPDATE conversations SET stage = 'Stage 1' WHERE id = ? AND tenant_id = ?").run(conv.id, tid);

      if (messageTemplate) {
        // Each recipient draws a template from the variant pool, then the merge
        // fields are substituted. original_body keeps the approved template
        // merged for this same contact, so the audit trail shows both halves.
        // Prefer the stored row: it holds values an earlier import supplied
        // that this file may omit.
        const contact = {};
        for (const column of MERGE_COLUMNS) {
          contact[column] = lead[column] != null && lead[column] !== ''
            ? lead[column]
            : (conv ? conv[column] : null);
        }
        const variant = pickVariant(variantPool, insertedMessages.length);
        const body = mergePlaceholders(variant.text || messageTemplate, contact);
        const originalBody = mergePlaceholders(messageTemplate, contact);

        const fromNum = resolveSenderNumber(tid, conv.id, fromNumber);

        const result = insertMessageStmt.run(
          tid, conv.id, fromNum, conv.phone_number, body, originalBody, variant.source
        );
        insertedMessages.push({
          id: result.lastInsertRowid,
          tenant_id: tid,
          conversation_id: conv.id,
          direction: 'outbound',
          from_number: fromNum,
          to_number: conv.phone_number,
          body: body,
          original_body: originalBody,
          variation_source: variant.source,
          status: 'queued'
        });

        updateConvStmt.run(body, conv.id, tid);
      }
    }
  });

  transaction(leads);
  result.messages_queued = insertedMessages.length;
  console.log('[import] summary:', JSON.stringify(result));
  return { ...result, messages: insertedMessages, skipped };
}

function sendBulkMessages(tenantId, conversationIds, messageTemplate, fromNumber = null, options = {}) {
  const tid = requireTenant(tenantId);
  const variantPool = options.variantPool || null;
  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (
      tenant_id, conversation_id, direction, from_number, to_number, body, status,
      original_body, variation_source
    ) VALUES (?, ?, 'outbound', ?, ?, ?, 'queued', ?, ?)
  `);

  const updateConvStmt = db.prepare(`
    UPDATE conversations
    SET last_message_text = ?, last_message_at = datetime('now', 'localtime')
    WHERE id = ? AND tenant_id = ?
  `);

  const updateConvStageStmt = db.prepare(`
    UPDATE conversations
    SET stage = ?
    WHERE id = ? AND tenant_id = ?
  `);

  // Scoped, so an id belonging to another tenant simply is not found and the
  // recipient is skipped rather than messaged.
  const getConvStmt = db.prepare(`
    SELECT * FROM conversations WHERE id = ? AND tenant_id = ?
  `);

  const insertedMessages = [];
  const skipped = [];

  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      const conv = getConvStmt.get(id, tid);
      if (!conv) continue;

      // Never blast someone who opted out or was dispositioned out
      const blockReason = getBulkSendBlockReason(tid, conv);
      if (blockReason) {
        skipped.push({ id: conv.id, phone_number: conv.phone_number, reason: blockReason });
        continue;
      }

      // Calculate next stage for follow-up message
      const outboundCount = db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE conversation_id = ? AND tenant_id = ? AND direction = 'outbound' AND status = 'sent'
      `).get(conv.id, tid).count;

      let nextStage = 'Stage 1';
      if (outboundCount === 1) nextStage = 'Stage 2';
      else if (outboundCount >= 2) nextStage = 'Stage 3';

      updateConvStageStmt.run(nextStage, conv.id, tid);

      // Each recipient draws a template from the variant pool, then the merge
      // fields are substituted.
      const variant = pickVariant(variantPool, insertedMessages.length);
      const body = mergePlaceholders(variant.text || messageTemplate, conv);
      const originalBody = mergePlaceholders(messageTemplate, conv);

      const fromNum = resolveSenderNumber(tid, conv.id, fromNumber);

      const result = insertMessageStmt.run(
        tid, conv.id, fromNum, conv.phone_number, body, originalBody, variant.source
      );
      insertedMessages.push({
        id: result.lastInsertRowid,
        tenant_id: tid,
        conversation_id: conv.id,
        direction: 'outbound',
        from_number: fromNum,
        to_number: conv.phone_number,
        body: body,
        original_body: originalBody,
        variation_source: variant.source,
        status: 'queued'
      });

      updateConvStmt.run(body, conv.id, tid);
    }
  });

  transaction(conversationIds);
  return { messages: insertedMessages, skipped };
}

function deleteConversation(tenantId, id) {
  const tid = requireTenant(tenantId);
  const deleteMsgs = db.prepare('DELETE FROM messages WHERE conversation_id = ? AND tenant_id = ?');
  const deleteNotes = db.prepare('DELETE FROM notes WHERE conversation_id = ? AND tenant_id = ?');
  const deleteReminders = db.prepare('DELETE FROM reminder_state WHERE conversation_id = ? AND tenant_id = ?');
  const deleteConv = db.prepare('DELETE FROM conversations WHERE id = ? AND tenant_id = ?');
  const transaction = db.transaction((convId) => {
    deleteMsgs.run(convId, tid);
    deleteNotes.run(convId, tid);
    deleteReminders.run(convId, tid);
    return deleteConv.run(convId, tid);
  });
  return transaction(id);
}

function getRecentMessages(tenantId, limit = 10) {
  const tid = requireTenant(tenantId);
  return db.prepare(`
    SELECT 
      m.id, 
      m.conversation_id, 
      m.direction, 
      m.from_number, 
      m.to_number, 
      m.body, 
      m.status, 
      m.error_message,
      m.created_at,
      c.name as contact_name
    FROM messages m
    LEFT JOIN conversations c ON m.conversation_id = c.id
    WHERE m.tenant_id = ?
    ORDER BY m.id DESC
    LIMIT ?
  `).all(tid, limit);
}

function markConversationRead(tenantId, id) {
  const tid = requireTenant(tenantId);
  return db.prepare("UPDATE conversations SET unread = 0 WHERE id = ? AND tenant_id = ?").run(id, tid);
}

// Lead dispositions. 'appointment' and 'follow_up' carry a scheduled date/time;
// passing null clears the disposition and returns the lead to the New tab.
const VALID_DISPOSITIONS = ['appointment', 'follow_up', 'no', 'unqualified', 'customer'];

/**
 * Set or clear the business disposition.
 *
 * This NEVER touches opted_out / wrong_number. Clearing a disposition returns
 * the lead to New for triage but leaves any legal suppression intact — undoing
 * a "No" must not resurrect someone who texted STOP.
 */
function setConversationDisposition(tenantId, id, disposition, scheduledAt = null, note = null, actor = null) {
  const tid = requireTenant(tenantId);
  if (disposition !== null && !VALID_DISPOSITIONS.includes(disposition)) {
    throw new Error(`Invalid disposition: ${disposition}`);
  }
  if ((disposition === 'appointment' || disposition === 'follow_up') && !scheduledAt) {
    throw new Error(`A date and time is required for the '${disposition}' disposition`);
  }

  const existing = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, tid);
  if (!existing) return undefined;

  // Only the scheduled dispositions keep a date on the record
  const keepsSchedule = disposition === 'appointment' || disposition === 'follow_up';
  const nextSchedule = keepsSchedule ? scheduledAt : null;

  db.prepare(`
    UPDATE conversations
    SET disposition = ?,
        disposition_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
        scheduled_at = ?,
        disposition_note = ?
    WHERE id = ? AND tenant_id = ?
  `).run(disposition, disposition, nextSchedule, note || null, id, tid);

  // Rescheduling or clearing invalidates any reminders already fired.
  if (existing.scheduled_at && existing.scheduled_at !== nextSchedule) {
    db.prepare('DELETE FROM reminder_state WHERE conversation_id = ? AND scheduled_at = ? AND tenant_id = ?')
      .run(id, existing.scheduled_at, tid);
  }

  console.log(`[disposition] conversation ${id}: ${existing.disposition || 'none'} -> ${disposition || 'none'}` +
              `${nextSchedule ? ` @ ${nextSchedule}Z` : ''}${actor ? ` by ${actor}` : ''}`);

  return db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, tid);
}

/** Exclusive upper bound: midnight UTC at the start of the following day. */
function nextUtcDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Performance stats for a date range (inclusive, YYYY-MM-DD).
 *
 * TERMINOLOGY — these names match what the carrier data actually supports,
 * and the UI must not rename them:
 *
 *   attempted        outbound rows created in the window
 *   carrier_accepted status='sent' — the carrier took the message. This is
 *                    NOT proof of handset delivery.
 *   delivered        a carrier delivery receipt confirmed handset delivery
 *                    (delivered_at set). Only DLR-capable routes report this.
 *   failed           carrier rejected, or a DLR reported UNDELIV/REJECTD/EXPIRED
 *   queued           still waiting in the send queue
 *   unknown_delivery carrier-accepted but no DLR ever arrived
 *
 * Every rate documents its denominator in `rate_definitions`.
 */
function getStats(tenantId, fromDate, toDate, options = {}) {
  const tid = requireTenant(tenantId);
  // Timestamps are stored UTC, but the user picks dates in THEIR timezone.
  // Filtering on date(created_at) therefore attributed anything sent after
  // local midnight-minus-offset to the wrong day - for a US user that is
  // every message after ~8pm. The client sends the exact UTC instants that
  // bound its local day range; when absent we fall back to UTC day bounds.
  const startUtc = options.startUtc || `${fromDate} 00:00:00`;
  const endUtc = options.endUtc || nextUtcDay(toDate);
  // Minutes to add to a UTC timestamp to get the viewer's local time.
  const tzShift = `${Number(options.tzOffsetMinutes) || 0} minutes`;
  // Every query below is bound as [tenant, start, end]; the tenant leads so the
  // composite indexes are usable and no aggregate can straddle two tenants.
  const range = [tid, startUtc, endUtc];

  const outbound = db.prepare(`
    SELECT
      COUNT(*) as attempted,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as carrier_accepted,
      SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status IN ('queued', 'sending') THEN 1 ELSE 0 END) as queued,
      COUNT(DISTINCT conversation_id) as contacts_reached
    FROM messages
    WHERE tenant_id = ? AND direction = 'outbound' AND created_at >= ? AND created_at < ?
  `).get(...range);

  // Contacts actually handed to a carrier: the only defensible denominator for
  // a reply rate. Someone whose message is still queued has had no chance to reply.
  const contactsAccepted = db.prepare(`
    SELECT COUNT(DISTINCT conversation_id) as c
    FROM messages
    WHERE tenant_id = ? AND direction = 'outbound' AND status = 'sent' AND created_at >= ? AND created_at < ?
  `).get(...range).c || 0;

  // Inbound replies, classified through the single canonical module.
  const inboundRows = db.prepare(`
    SELECT conversation_id, body
    FROM messages
    WHERE tenant_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?
  `).all(...range);

  const messageCounts = { positive: 0, negative: 0, opt_out: 0, wrong_number: 0, unknown: 0 };
  const responders = new Set();
  // Each contact counted once, under their strongest signal, so one chatty
  // lead cannot inflate the positive count.
  const contactBest = new Map();
  const RANK = { opt_out: 4, wrong_number: 3, negative: 2, positive: 1, unknown: 0 };

  inboundRows.forEach(row => {
    responders.add(row.conversation_id);
    const cls = classification.classifyReply(row.body);
    messageCounts[cls]++;
    const current = contactBest.get(row.conversation_id);
    if (!current || RANK[cls] > RANK[current]) {
      contactBest.set(row.conversation_id, cls);
    }
  });

  const uniqueCounts = { positive: 0, negative: 0, opt_out: 0, wrong_number: 0, unknown: 0 };
  contactBest.forEach(cls => { uniqueCounts[cls]++; });

  const daily = db.prepare(`
    SELECT
      date(created_at, ?) as day,
      SUM(CASE WHEN direction = 'outbound' AND status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN direction = 'outbound' AND status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as replies
    FROM messages
    WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY date(created_at, ?)
    ORDER BY day ASC
  `).all(tzShift, ...range, tzShift);

  const dispositionRows = db.prepare(`
    SELECT disposition, COUNT(*) as count
    FROM conversations
    WHERE tenant_id = ? AND disposition IS NOT NULL AND disposition_at >= ? AND disposition_at < ?
    GROUP BY disposition
  `).all(...range);

  const dispositions = { appointment: 0, follow_up: 0, no: 0, unqualified: 0, customer: 0 };
  dispositionRows.forEach(row => {
    if (row.disposition in dispositions) dispositions[row.disposition] = row.count;
  });

  const newLeads = db.prepare(`
    SELECT COUNT(*) as count FROM conversations WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
  `).get(...range).count;

  const suppression = db.prepare(`
    SELECT
      SUM(CASE WHEN opted_out_at >= ? AND opted_out_at < ? THEN 1 ELSE 0 END) as opt_outs,
      SUM(CASE WHEN wrong_number_at >= ? AND wrong_number_at < ? THEN 1 ELSE 0 END) as wrong_numbers
    FROM conversations
    WHERE tenant_id = ?
  `).get(startUtc, endUtc, startUtc, endUtc, tid);

  // Minutes between our last outbound and their reply. Negative gaps are
  // impossible by construction, but the guard stops a clock change from
  // poisoning the average.
  const replyLag = db.prepare(`
    SELECT AVG(gap) as avg_minutes FROM (
      SELECT (julianday(m.created_at) - julianday((
        SELECT MAX(o.created_at) FROM messages o
        WHERE o.conversation_id = m.conversation_id
          AND o.tenant_id = m.tenant_id
          AND o.direction = 'outbound'
          AND o.created_at < m.created_at
      ))) * 1440 as gap
      FROM messages m
      WHERE m.tenant_id = ? AND m.direction = 'inbound' AND m.created_at >= ? AND m.created_at < ?
    ) WHERE gap IS NOT NULL AND gap >= 0
  `).get(...range).avg_minutes;

  const peakHour = db.prepare(`
    SELECT strftime('%H', created_at, ?) as hour, COUNT(*) as count
    FROM messages
    WHERE tenant_id = ? AND direction = 'inbound' AND created_at >= ? AND created_at < ?
    GROUP BY hour
    ORDER BY count DESC, hour ASC
    LIMIT 1
  `).get(tzShift, ...range);

  const attempted = outbound.attempted || 0;
  const carrierAccepted = outbound.carrier_accepted || 0;
  const delivered = outbound.delivered || 0;
  const failed = outbound.failed || 0;

  const rate = (numerator, denominator) =>
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

  return {
    from: fromDate,
    to: toDate,
    sent: {
      attempted,
      carrier_accepted: carrierAccepted,
      delivered,
      unknown_delivery: Math.max(0, carrierAccepted - delivered),
      failed,
      queued: outbound.queued || 0,
      contacts_reached: outbound.contacts_reached || 0,
      contacts_accepted: contactsAccepted,
      acceptance_rate: rate(carrierAccepted, carrierAccepted + failed),
      confirmed_delivery_rate: rate(delivered, carrierAccepted)
    },
    responses: {
      total_messages: inboundRows.length,
      unique_responders: responders.size,
      positive_messages: messageCounts.positive,
      negative_messages: messageCounts.negative,
      opt_out_messages: messageCounts.opt_out,
      wrong_number_messages: messageCounts.wrong_number,
      unknown_messages: messageCounts.unknown,
      positive_contacts: uniqueCounts.positive,
      negative_contacts: uniqueCounts.negative,
      opt_out_contacts: uniqueCounts.opt_out,
      wrong_number_contacts: uniqueCounts.wrong_number,
      unknown_contacts: uniqueCounts.unknown,
      response_rate: rate(responders.size, contactsAccepted),
      positive_rate_of_responders: rate(uniqueCounts.positive, responders.size),
      positive_rate_of_contacted: rate(uniqueCounts.positive, contactsAccepted),
      negative_rate_of_responders: rate(uniqueCounts.negative, responders.size),
      opt_out_rate_of_contacted: rate(uniqueCounts.opt_out, contactsAccepted)
    },
    suppression: {
      opt_outs_recorded: suppression.opt_outs || 0,
      wrong_numbers_recorded: suppression.wrong_numbers || 0
    },
    dispositions,
    new_leads: newLeads,
    avg_reply_minutes: replyLag === null || replyLag === undefined ? null : Math.round(replyLag),
    peak_reply_hour: peakHour ? parseInt(peakHour.hour, 10) : null,
    daily,
    // Rendered as tooltips so no metric on screen is ambiguous.
    rate_definitions: {
      acceptance_rate: 'Carrier-accepted / (carrier-accepted + failed) messages',
      confirmed_delivery_rate: 'Messages with a carrier delivery receipt / carrier-accepted messages',
      response_rate: 'Unique contacts who replied / unique contacts whose message the carrier accepted',
      positive_rate_of_responders: 'Contacts whose strongest reply was positive / unique contacts who replied',
      positive_rate_of_contacted: 'Contacts whose strongest reply was positive / unique contacts whose message the carrier accepted',
      negative_rate_of_responders: 'Contacts whose strongest reply was negative / unique contacts who replied',
      opt_out_rate_of_contacted: 'Contacts who opted out / unique contacts whose message the carrier accepted'
    }
  };
}

// Password Hashing
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const checkHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === checkHash;
}

// User CRUD & Validation
/** Global by design: used only to decide whether the install is bootstrapped. */
function countUsers() {
  const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
  return row ? row.count : 0;
}

const USER_ROLES = ['superadmin', 'owner', 'agent'];

/**
 * Create a user.
 *
 * A superadmin belongs to no tenant and may act as any; everyone else must
 * have one. The two are mutually exclusive, and that is enforced here rather
 * than left to callers.
 */
function createUser(username, password, { tenantId = null, role = 'agent' } = {}) {
  if (!USER_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  let tid = null;
  if (role === 'superadmin') {
    if (tenantId) throw new Error('A superadmin cannot belong to a tenant');
  } else {
    tid = requireTenant(tenantId);
    if (!getTenantById(tid)) throw new Error(`Unknown tenant: ${tenantId}`);
  }
  const passwordHash = hashPassword(password);
  return db.prepare(
    'INSERT INTO users (username, password_hash, tenant_id, role) VALUES (?, ?, ?, ?)'
  ).run(username.trim().toLowerCase(), passwordHash, tid, role);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?')
           .get(String(username || '').trim().toLowerCase()) || null;
}

function listUsers(tenantId) {
  const tid = requireTenant(tenantId);
  return db.prepare(
    'SELECT id, username, tenant_id, role, created_at FROM users WHERE tenant_id = ? ORDER BY username ASC'
  ).all(tid);
}

function validateUser(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (verifyPassword(password, user.password_hash)) {
    return { id: user.id, username: user.username, tenant_id: user.tenant_id, role: user.role };
  }
  return null;
}

// Sessions Management
function createSession(username, tenantId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  // Expires in 7 days
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, username, tenant_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, username.trim().toLowerCase(), tenantId || null, expiresAt);
  return { token, username, tenant_id: tenantId || null, expires_at: expiresAt };
}

/**
 * Resolve a session token to the acting identity.
 *
 * Returns the session joined to its user, so callers get `role` and the active
 * `tenant_id` in one read. The session's tenant_id is authoritative: an owner
 * or agent can only ever hold their own, and a superadmin's is whatever tenant
 * they last switched to.
 */
function validateSession(token) {
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;

  const now = new Date().toISOString();
  if (session.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const user = getUserByUsername(session.username);
  if (!user) {
    // The account was deleted while the session was live.
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  // A non-superadmin is always pinned to their own tenant, whatever the session
  // row says, so a stale or tampered session cannot widen access.
  const tenantId = user.role === 'superadmin' ? session.tenant_id : user.tenant_id;

  return {
    ...session,
    tenant_id: tenantId,
    role: user.role,
    user_id: user.id
  };
}

/** Point a superadmin's session at a different tenant. */
function setSessionTenant(token, tenantId) {
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  const user = getUserByUsername(session.username);
  if (!user || user.role !== 'superadmin') {
    throw new Error('Only a superadmin may switch tenants');
  }
  const tid = requireTenant(tenantId);
  if (!getTenantById(tid)) throw new Error(`Unknown tenant: ${tenantId}`);
  db.prepare('UPDATE sessions SET tenant_id = ? WHERE token = ?').run(tid, token);
  return validateSession(token);
}

function deleteSession(token) {
  return db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getNotesForTarget(tenantId, { conversationId, phoneNumber }) {
  const tid = requireTenant(tenantId);
  const convIdNum = typeof conversationId === 'number' ? conversationId : (parseInt(conversationId, 10) || 0);
  const phone = (phoneNumber && typeof phoneNumber === 'string') ? phoneNumber.trim() : null;

  // The phone-number branch matters most here: notes can be looked up by number
  // alone, and two tenants may hold the same number, so without the tenant
  // filter one tenant's notes would surface in the other's drawer.
  if (convIdNum > 0 && phone) {
    return db.prepare(`
      SELECT * FROM notes
      WHERE tenant_id = ?
        AND (conversation_id = ? OR (phone_number IS NOT NULL AND phone_number != '' AND phone_number = ?))
      ORDER BY created_at DESC, id DESC
    `).all(tid, convIdNum, phone);
  } else if (convIdNum > 0) {
    return db.prepare(`
      SELECT * FROM notes
      WHERE tenant_id = ? AND conversation_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(tid, convIdNum);
  } else if (phone) {
    return db.prepare(`
      SELECT * FROM notes
      WHERE tenant_id = ? AND phone_number = ?
      ORDER BY created_at DESC, id DESC
    `).all(tid, phone);
  }
  return [];
}

function getNotesForConversation(tenantId, conversationId) {
  return getNotesForTarget(tenantId, { conversationId });
}

function addNoteForTarget(tenantId, { conversationId, phoneNumber, noteText }) {
  const tid = requireTenant(tenantId);
  const convIdNum = typeof conversationId === 'number' ? conversationId : (parseInt(conversationId, 10) || 0);
  const phone = (phoneNumber && typeof phoneNumber === 'string') ? phoneNumber.trim() : null;

  // A note may only be attached to a conversation this tenant owns.
  if (convIdNum > 0) {
    const owned = db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?')
                    .get(convIdNum, tid);
    if (!owned) throw new Error(`Conversation ${convIdNum} does not belong to tenant ${tid}`);
  }

  const stmt = db.prepare(`
    INSERT INTO notes (tenant_id, conversation_id, phone_number, note_text, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(tid, convIdNum, phone, noteText ? noteText.trim() : '');
  return db.prepare('SELECT * FROM notes WHERE id = ? AND tenant_id = ?')
           .get(result.lastInsertRowid, tid);
}

function addNoteForConversation(tenantId, conversationId, noteText, phoneNumber = null) {
  return addNoteForTarget(tenantId, { conversationId, phoneNumber, noteText });
}

function deleteNote(tenantId, noteId) {
  const tid = requireTenant(tenantId);
  return db.prepare('DELETE FROM notes WHERE id = ? AND tenant_id = ?').run(noteId, tid);
}

module.exports = {
  db,
  initDatabase,
  requireTenant,
  insertRecruitingInquiry,

  // Tenancy
  createTenant,
  getTenants,
  getTenantById,
  getTenantBySlug,
  setTenantStatus,
  slugify,
  TENANT_STATUSES,

  // DID ownership
  assignDidToTenant,
  removeDidFromTenant,
  getTenantDids,
  getTenantDidPool,
  resolveTenantForDid,

  // Settings
  getTenantSettings,
  getEffectiveSettings,
  updateTenantSettings,
  GLOBAL_ONLY_SETTINGS,

  // Global (cross-tenant) suppression
  addGlobalSuppression,
  removeGlobalSuppression,
  getGlobalSuppression,
  isGloballySuppressed,

  // Users
  getUserByUsername,
  listUsers,
  setSessionTenant,
  USER_ROLES,

  getMessageByRefId,
  inboundExists,
  getNotesForTarget,
  addNoteForTarget,
  getNotesForConversation,
  addNoteForConversation,
  deleteNote,
  getSettings,
  updateSettings,
  getConversations,
  getConversationsForList,
  getConversationById,
  getOrCreateConversation,
  resolveSenderNumber,
  setConversationDid,
  getMessages,
  insertMessage,
  updateMessageStatus,
  getNextQueuedMessage,
  getDueQueuedMessages,
  getDidSendSummary,
  failStaleSendingMessages,
  mergePlaceholders,
  MERGE_FIELDS,
  MERGE_COLUMNS,
  pickVariant,
  getPlaceholderWidths,
  getQueueStats,
  bulkImportLeads,
  sendBulkMessages,
  deleteConversation,
  getRecentMessages,
  markConversationRead,
  setConversationDisposition,
  VALID_DISPOSITIONS,
  BLOCKED_DISPOSITIONS,
  classifyReply: classification.classifyReply,
  CLASSIFICATIONS: classification.CLASSIFICATIONS,
  getBulkSendBlockReason,
  getSuppressionBlock,
  recordOptOut,
  recordWrongNumber,
  recordOptIn,
  logSuppressionEvent,
  backfillSuppression,
  cancelIfSuppressed,
  recordDelivery,
  recordCarrierStatus,
  getNotifiedReminders,
  acknowledgeReminder,
  REMINDER_TIERS,
  SUPPRESSION_REASONS,
  SUPPRESSION_LABELS,
  getStats,
  countUsers,
  createUser,
  validateUser,
  createSession,
  validateSession,
  deleteSession
};

