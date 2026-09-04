#!/usr/bin/env node
/**
 * Repoint FracTEL inbound webhooks at this application.
 *
 * Every DID registered in tenant_dids has its SMS `receive_notify` callback set
 * to this app's /webhook/inbound. That is the step that actually moves inbound
 * traffic; assigning a number in tenant_dids only tells THIS app it owns the
 * number, it does not tell the carrier where to deliver.
 *
 * Credentials come from the settings table (Gateway Settings in the UI), never
 * from the command line, so they are not exposed in shell history or the
 * process list.
 *
 *   node scripts/repoint-webhooks.js --dry-run   # show current vs intended
 *   node scripts/repoint-webhooks.js             # apply
 *
 * Optional: --url https://... to override the target (defaults to
 * WEBHOOK_BASE_URL, then https://messaging.netenroll.com).
 *
 * Idempotent: a number already pointing at the target is reported and skipped.
 */
'use strict';

const db = require('../database');

const AUTH_URL = 'https://api.fonestorm.com/v2/auth';
const NUMBER_URL = did => `https://api.fonestorm.com/v2/fonenumbers/${did}`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const urlFlagIndex = args.indexOf('--url');
const TARGET_BASE = (urlFlagIndex !== -1 && args[urlFlagIndex + 1])
  || process.env.WEBHOOK_BASE_URL
  || 'https://messaging.netenroll.com';
const TARGET = `${TARGET_BASE.replace(/\/+$/, '')}/webhook/inbound`;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function getToken(username, password) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, expires: 3600 })
  });
  if (!res.ok) {
    fail(`FracTEL auth failed: HTTP ${res.status}. Check the credentials in Gateway Settings.`);
  }
  const data = await res.json();
  const token = data.auth && data.auth.token;
  if (!token) fail('FracTEL returned no auth token.');
  return token;
}

/**
 * What the carrier currently has configured for this number.
 *
 * The payload nests everything under `fonenumber`. Reading `data.sms_options`
 * directly returns undefined, which silently looks like "no webhook set" - so
 * the whole block is returned and the caller decides.
 */
async function readNumber(did, token) {
  const res = await fetch(NUMBER_URL(did), { headers: { token } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  const opts = data && data.fonenumber && data.fonenumber.sms_options;
  if (!opts) return { error: 'no sms_options in response' };
  const notify = opts.receive_notify || {};
  return {
    url: notify.url || null,
    smsOptions: opts,
    // A second, independent consumer of the same number. Not ours to touch.
    otherReceiver: (opts.receive && opts.receive.url) || null
  };
}

/**
 * Read-modify-write, deliberately.
 *
 * These numbers carry more than one setting: a separate `receive` URL feeding
 * another system, plus sms_enabled/mms_enabled. PUTting only `receive_notify`
 * risks the carrier treating it as a replacement and dropping the rest, which
 * would silently unhook another integration or disable messaging on the number.
 * The full block goes back with exactly one field changed.
 */
async function writeNumber(did, token, currentOptions) {
  const next = JSON.parse(JSON.stringify(currentOptions));
  next.receive_notify = {
    ...(next.receive_notify || {}),
    type: 'Callback',
    method: 'JSON',
    url: TARGET
  };

  const res = await fetch(NUMBER_URL(did), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ sms_options: next })
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body.slice(0, 200) };
}

(async () => {
  db.initDatabase();

  const settings = db.getSettings();
  const username = (settings.fractel_username || '').trim();
  const password = (settings.fractel_password || '').trim();

  if (!username || !password) {
    fail('FracTEL credentials are not set.\n' +
         '  Enter them in Gateway Settings at ' + TARGET_BASE + ' and run this again.\n' +
         '  Nothing was changed.');
  }

  // Every enabled DID across every tenant. Ownership already lives in one place.
  const dids = db.db.prepare(`
    SELECT d.did, d.tenant_id, t.name AS tenant_name
    FROM tenant_dids d
    JOIN tenants t ON t.id = d.tenant_id
    WHERE d.enabled = 1
    ORDER BY d.did
  `).all();

  if (!dids.length) {
    fail('No enabled DIDs in tenant_dids. Assign numbers to a tenant first.');
  }

  console.log(`\n  Target: ${TARGET}`);
  console.log(`  Numbers: ${dids.length}${DRY_RUN ? '   (DRY RUN - nothing will be changed)' : ''}\n`);

  const token = await getToken(username, password);

  let changed = 0, already = 0, failed = 0;

  for (const row of dids) {
    const current = await readNumber(row.did, token);
    const label = `${row.did}  ${row.tenant_name}`;

    if (current.error) {
      console.log(`  ?  ${label}  could not read current config (${current.error})`);
      failed++;
      continue;
    }
    if (current.url === TARGET) {
      console.log(`  =  ${label}  already pointed here`);
      already++;
      continue;
    }

    console.log(`  ${DRY_RUN ? '~' : '>'}  ${label}`);
    console.log(`       from: ${current.url || '(none set)'}`);
    console.log(`       to:   ${TARGET}`);
    if (current.otherReceiver) {
      console.log(`       note: separate 'receive' URL preserved -> ${current.otherReceiver}`);
    }

    if (DRY_RUN) { changed++; continue; }

    const result = await writeNumber(row.did, token, current.smsOptions);
    if (result.ok) {
      // Confirm from the carrier rather than trusting the response code.
      const after = await readNumber(row.did, token);
      if (after.url === TARGET) {
        console.log('       confirmed');
        changed++;
      } else {
        console.log(`       WROTE BUT DID NOT TAKE: still ${after.url || '(none)'}`);
        failed++;
      }
    } else {
      console.log(`       FAILED: HTTP ${result.status} ${result.body}`);
      failed++;
    }
  }

  console.log(`\n  ${DRY_RUN ? 'Would change' : 'Changed'}: ${changed}   Already correct: ${already}   Failed: ${failed}\n`);

  if (!DRY_RUN && changed > 0) {
    console.log('  Inbound replies to these numbers now arrive here.');
    console.log('  Whatever they pointed at previously will stop receiving them.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => fail(err.stack || err.message));
