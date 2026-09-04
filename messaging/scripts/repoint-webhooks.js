#!/usr/bin/env node
/**
 * Point FracTEL inbound SMS at this application.
 *
 * FracTEL exposes TWO fields under sms_options and only one of them delivers
 * a message:
 *
 *   receive        - the delivery action. type "URL" posts the message body to
 *                    your endpoint. type "None" means the inbound message goes
 *                    NOWHERE. This is the field that matters.
 *   receive_notify - a secondary callback. Setting it alone looks correct in
 *                    the carrier console and delivers nothing. Point it at the
 *                    same endpoint as `receive` and the message arrives TWICE.
 *
 * That distinction cost us a silent outage: all six DIDs read as "already
 * pointed here" because receive_notify was ours, while the number we were
 * actually sending from had receive.type "None" and dropped every reply.
 *
 * So this script sets `receive` and verifies it, and turns receive_notify OFF
 * wherever it points at the same endpoint - otherwise the fix for the outage
 * becomes a duplicate in every conversation.
 *
 * Credentials come from the settings table (Gateway Settings in the UI), never
 * from the command line, so they are not exposed in shell history or the
 * process list.
 *
 *   node scripts/repoint-webhooks.js --dry-run   # show current vs intended
 *   node scripts/repoint-webhooks.js             # apply
 *
 * Flags:
 *   --only <did>   restrict to one number
 *   --url  <base>  override the target (default WEBHOOK_BASE_URL, then
 *                  https://messaging.netenroll.com)
 *   --takeover     ALSO redirect numbers whose `receive` currently points at
 *                  somebody else's endpoint. Without it those are reported and
 *                  skipped, because repointing them stops inbound reaching a
 *                  third-party system that is still consuming it.
 *
 * Idempotent: a number already pointing at the target is reported and skipped.
 */
'use strict';

const db = require('../database');

const AUTH_URL = 'https://api.fonestorm.com/v2/auth';
const NUMBER_URL = did => `https://api.fonestorm.com/v2/fonenumbers/${did}`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TAKEOVER = args.includes('--takeover');
const onlyFlagIndex = args.indexOf('--only');
const ONLY_DID = onlyFlagIndex !== -1 ? args[onlyFlagIndex + 1] : null;
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
 * read the nested block and let the caller decide.
 */
async function readNumber(did, token) {
  const res = await fetch(NUMBER_URL(did), { headers: { token } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  const opts = data && data.fonenumber && data.fonenumber.sms_options;
  if (!opts) return { error: 'no sms_options in response' };
  const receive = opts.receive || {};
  const notify = opts.receive_notify || {};
  return {
    // The delivery action. null here means inbound is discarded.
    receiveType: receive.type || 'None',
    receiveUrl: receive.url || null,
    // type matters as much as url here: a stale url survives type "None".
    notifyType: notify.type || 'None',
    notifyUrl: notify.url || null,
    smsEnabled: opts.sms_enabled
  };
}

/**
 * Write the delivery action, the notification, or both.
 *
 * The read shape is not the write shape: FracTEL RETURNS `receive.url` but
 * VALIDATES `receive.value`, so echoing back what it just gave you is rejected
 * with HTTP 400. Hence the deliberate hand-built payload rather than a
 * read-modify-write of the whole block.
 */
async function writeNumber(did, token, { setReceive, clearNotify }) {
  const sms_options = {};
  if (setReceive) {
    sms_options.receive = { type: 'URL', value: TARGET, url_method: 'JSON' };
  }
  // `receive` already delivers the message. Leaving receive_notify pointed at
  // the same endpoint delivers it a second time, which is exactly what it did
  // the first time this was fixed.
  if (clearNotify) {
    sms_options.receive_notify = { type: 'None' };
  }
  const res = await fetch(NUMBER_URL(did), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', token },
    body: JSON.stringify({ sms_options })
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

  const scoped = ONLY_DID ? dids.filter(d => d.did === ONLY_DID) : dids;
  if (ONLY_DID && !scoped.length) fail(`DID ${ONLY_DID} is not assigned to any tenant.`);

  console.log(`\n  Target: ${TARGET}`);
  console.log(`  Numbers: ${scoped.length}` +
              `${DRY_RUN ? '   (DRY RUN - nothing will be changed)' : ''}` +
              `${TAKEOVER ? '   (TAKEOVER - third-party receivers will be replaced)' : ''}\n`);

  const token = await getToken(username, password);

  let changed = 0, already = 0, skipped = 0, failed = 0;

  for (const row of scoped) {
    const before = await readNumber(row.did, token);
    const label = `${row.did}  ${row.tenant_name}`;

    if (before.error) {
      console.log(`  ?  ${label}  could not read current config (${before.error})`);
      failed++;
      continue;
    }

    const receiveOk = before.receiveUrl === TARGET;
    // A notify still aimed at us alongside `receive` is a duplicate generator.
    const notifyDuplicates = before.notifyType === 'Callback' && before.notifyUrl === TARGET;
    if (receiveOk && !notifyDuplicates) {
      console.log(`  =  ${label}  delivering here already`);
      already++;
      continue;
    }

    // Someone else's endpoint is consuming this number's inbound right now.
    // Replacing it is not ours to decide silently.
    const thirdParty = before.receiveUrl && before.receiveUrl !== TARGET;
    if (thirdParty && !TAKEOVER) {
      console.log(`  !  ${label}  SKIPPED - inbound currently delivers to a third party`);
      console.log(`       ${before.receiveUrl}`);
      console.log(`       Repointing it stops that system receiving these messages.`);
      console.log(`       Re-run with --takeover to move it here anyway.`);
      skipped++;
      continue;
    }

    console.log(`  ${DRY_RUN ? '~' : '>'}  ${label}`);
    console.log(`       delivery (receive): ${before.receiveType === 'None'
      ? 'None - inbound is being DISCARDED'
      : before.receiveUrl}`);
    console.log(`       -> ${TARGET}`);
    if (notifyDuplicates) {
      console.log(`       also clearing receive_notify - it points here too and would double every message`);
    }
    if (before.smsEnabled !== 'yes') {
      console.log(`       WARNING: sms_enabled is '${before.smsEnabled}' - inbound may not flow at all.`);
    }

    if (DRY_RUN) { changed++; continue; }

    const result = await writeNumber(row.did, token, {
      setReceive: !receiveOk,
      clearNotify: notifyDuplicates
    });
    if (!result.ok) {
      console.log(`       FAILED: HTTP ${result.status} ${result.body}`);
      failed++;
      continue;
    }

    // Confirm from the carrier rather than trusting the response code.
    const after = await readNumber(row.did, token);
    if (after.receiveUrl === TARGET) {
      console.log(`       confirmed: receive.type=URL -> ${after.receiveUrl}`);
      changed++;
    } else {
      console.log(`       WROTE BUT DID NOT TAKE: receive is still ` +
                  `${after.receiveUrl || after.receiveType}`);
      failed++;
    }
  }

  console.log(`\n  ${DRY_RUN ? 'Would change' : 'Changed'}: ${changed}   ` +
              `Already correct: ${already}   Skipped: ${skipped}   Failed: ${failed}\n`);

  if (skipped > 0) {
    console.log('  Skipped numbers still deliver their inbound somewhere else.');
    console.log('  Replies to them will not appear in this app until they are moved.\n');
  }
  if (!DRY_RUN && changed > 0) {
    console.log('  Inbound to the changed numbers now arrives here.');
    console.log('  Whatever they delivered to previously will stop receiving them.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => fail(err.stack || err.message));
