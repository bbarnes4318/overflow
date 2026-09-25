const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const dotenv = require('dotenv');
const db = require('./database');
const mergeFields = require('./merge_fields');
const queueWorker = require('./queue');
const variation = require('./variation');
const contentLint = require('./content_lint');
const mail = require('./mail');

// Load environment variables from backend/.env if present
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Initialize database
db.initDatabase();

// Start SMS queue worker
queueWorker.start();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Helper to parse cookies
// Session cookies get Secure when the request arrived over HTTPS (behind
// nginx that shows up as x-forwarded-proto).
function sessionCookie(req, token, maxAgeSeconds) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim();
  const secure = proto === 'https' ? ' Secure;' : '';
  return `session_token=${token}; Path=/; HttpOnly;${secure} Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function getCookie(cookieString, name) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

/* ------------------------------------------------------------------
 * Request validation helpers
 *
 * TIME MODEL: every timestamp this application stores is UTC.
 * SQLite datetime('now') is UTC. The browser sends scheduled times as a
 * full ISO-8601 instant, which is converted to UTC here. The browser is
 * the only place local time is rendered.
 * ------------------------------------------------------------------ */

// CSV imports post the whole parsed batch as JSON; the express default of
// 100 kb silently rejected large lists.
const JSON_BODY_LIMIT = '4mb';
const MAX_MESSAGE_LENGTH = 1600;   // 10 SMS segments
const MAX_LEADS_PER_UPLOAD = 20000;
const MAX_BULK_RECIPIENTS = 20000;

// Schedules must land inside a sane window; guards against typos like year 202.
const MIN_SCHEDULE_MS = Date.UTC(2000, 0, 1);
const MAX_SCHEDULE_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;

function parseConversationId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Validate a client-supplied schedule instant and normalise it to a UTC
 * 'YYYY-MM-DD HH:MM:SS' string for storage.
 */
function validateScheduleInput(value, { allowPast = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'A date and time is required' };
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return { ok: false, error: 'Invalid date and time' };
  }
  const ms = date.getTime();
  if (ms < MIN_SCHEDULE_MS) {
    return { ok: false, error: 'Date is before the earliest supported date (2000-01-01)' };
  }
  if (ms > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, error: 'Date is more than 5 years in the future' };
  }
  if (!allowPast && ms < Date.now() - 60000) {
    return { ok: false, error: 'Date and time is in the past' };
  }
  return { ok: true, utc: date.toISOString().slice(0, 19).replace('T', ' ') };
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Middleware
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Never leak internals to the browser; log the detail server-side instead.
function fail(res, status, publicMessage, err) {
  if (err) console.error(`[error] ${publicMessage}:`, err.message);
  return res.status(status).json({ error: publicMessage });
}

// Auth status (public check). The superadmin is seeded at boot, so an install
// is always "configured" - the login page never offers a signup form.
app.get('/api/auth/status', (req, res) => {
  try {
    res.json({ has_admin: db.countUsers() > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-service signup is deliberately gone.
//
// On a single-tenant install "first user becomes admin" was reasonable. On a
// multi-tenant one it hands the platform to whoever loads the page first, and
// every account created that way would have no tenant. Accounts are created by
// a superadmin (POST /api/tenants, POST /api/tenants/:id/users) against a
// tenant that already exists.
app.post('/api/auth/signup', (req, res) => {
  res.status(410).json({
    error: 'Self-service signup is disabled. Ask a platform administrator for an account.'
  });
});

/**
 * Login rate limiting: a small in-memory sliding window per client IP.
 * Enough to stop credential stuffing against a single-admin deployment
 * without adding a dependency or shared store.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket.remoteAddress || 'unknown';
}

function loginRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, recent);

  // Keep the map from growing without bound on a long-lived process.
  if (loginAttempts.size > 5000) {
    for (const [key, times] of loginAttempts) {
      if (!times.length || now - times[times.length - 1] > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
  }
  return recent.length >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(req) {
  const ip = clientIp(req);
  const times = loginAttempts.get(ip) || [];
  times.push(Date.now());
  loginAttempts.set(ip, times);
}

// Login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (loginRateLimited(req)) {
    console.warn(`[auth] rate limited login attempts from ${clientIp(req)}`);
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  try {
    const user = db.validateUser(username, password);
    if (!user) {
      recordFailedLogin(req);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // A suspended tenant cannot be logged into at all. Checked here rather than
    // per-route so there is one place it can be got wrong.
    if (user.role !== 'superadmin') {
      const tenant = db.getTenantById(user.tenant_id);
      if (!tenant || tenant.status !== 'active') {
        recordFailedLogin(req);
        return res.status(403).json({ error: 'This account is not active.' });
      }
    }

    // The session opens on the user's own tenant.
    //
    // A superadmin belongs to no tenant, so their session would open with none
    // set - and since the WebSocket refuses a session without one, the dashboard
    // came up reporting "WS Disconnected" with no explanation. When exactly one
    // tenant exists there is no choice to make, so open on it. With several,
    // the session stays unset and the sidebar prompts for a switch.
    let openingTenantId = user.tenant_id || null;
    if (user.role === 'superadmin' && !openingTenantId) {
      const tenants = db.getTenants().filter(t => t.status === 'active');
      if (tenants.length === 1) openingTenantId = tenants[0].id;
    }

    const session = db.createSession(user.username, openingTenantId);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token, 7 * 24 * 60 * 60));
    res.json({
      success: true,
      username: session.username,
      role: user.role,
      tenant_id: openingTenantId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  try {
    const token = getCookie(req.headers.cookie, 'session_token');
    if (token) {
      db.deleteSession(token);
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Render login page
app.get('/login', (req, res) => {
  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (session) {
    return res.redirect('/');
  }
  res.sendFile(path.resolve(__dirname, 'public', 'login.html'));
});

// Exclude public paths from authentication
const PUBLIC_PATHS = [
  '/login',
  '/login.html',
  '/login.css',
  '/login.js',
  '/netenroll-logo-dark.png',
  '/favicon.ico',
  '/api/auth/status',
  '/api/auth/signup',
  '/api/auth/login',
  '/api/recruiting-inquiry',
  '/api/planner-lead'
];

/* ------------------------------------------------------------------
 * Recruiting inquiry — the form on netenroll.com/aca-agent-recruiting.
 *
 * Anonymous and public, so it is reached through nginx on the marketing
 * vhost rather than the app's own. The row is written before the email is
 * attempted: a mail outage must never lose an inquiry, so a failed send is
 * logged against the stored id instead of failing the request.
 * ------------------------------------------------------------------ */
const INQUIRY_WINDOW_MS = 60 * 60 * 1000;
const INQUIRY_MAX_PER_IP = 5;
const inquiryTimes = new Map();

const INQUIRY_OPTIONS = {
  agent_count: ['5 to 9', '10', '11 to 25', 'More than 25'],
  offer: ['Commission only', 'Salary plus commission', 'Draw against commission', 'A combination', 'Still deciding'],
  timing: ['Immediately', 'Before November 1', 'During open enrollment', 'After January']
};

function validateInquiry(body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const row = {
    source: str(body.source, 60) || 'aca-agent-recruiting',
    agency_name: str(body.agency_name, 200),
    contact_name: str(body.contact_name, 200),
    email: str(body.email, 254),
    phone: str(body.phone, 40),
    states: str(body.states, 500),
    agent_count: str(body.agent_count, 40),
    offer: str(body.offer, 60),
    timing: str(body.timing, 60),
    notes: str(body.notes, 4000) || null
  };
  for (const key of ['agency_name', 'contact_name', 'email', 'phone', 'states', 'agent_count', 'offer', 'timing']) {
    if (!row[key]) return { ok: false, error: `${key.replace('_', ' ')} is required` };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return { ok: false, error: 'A valid email address is required' };
  if (row.phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'A valid phone number is required' };
  for (const [key, allowed] of Object.entries(INQUIRY_OPTIONS)) {
    if (!allowed.includes(row[key])) return { ok: false, error: `${key.replace('_', ' ')} is not one of the offered choices` };
  }
  return { ok: true, row };
}

app.post('/api/recruiting-inquiry', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (inquiryTimes.get(ip) || []).filter(t => now - t < INQUIRY_WINDOW_MS);
  if (recent.length >= INQUIRY_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many requests from this connection. Please call 904-512-8487.' });
  }
  const checked = validateInquiry(req.body || {});
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  let id;
  try {
    id = db.insertRecruitingInquiry({ ...checked.row, client_ip: ip });
  } catch (err) {
    return fail(res, 500, 'The request could not be saved', err);
  }
  inquiryTimes.set(ip, [...recent, now]);
  res.json({ ok: true, id });

  const to = process.env.RECRUITING_INQUIRY_EMAIL;
  if (!to) {
    console.warn(`[inquiry] #${id} stored; RECRUITING_INQUIRY_EMAIL is not set so no email was sent`);
    return;
  }
  const r = checked.row;
  const text = [
    `Agency: ${r.agency_name}`, `Name: ${r.contact_name}`, `Email: ${r.email}`, `Phone: ${r.phone}`,
    `States: ${r.states}`, `Agents wanted: ${r.agent_count}`, `Offering: ${r.offer}`, `Needed: ${r.timing}`,
    '', r.notes || '(no notes)', '', `Source: ${r.source}  Inquiry #${id}`
  ].join('\n');
  mail.sendMail({ to, subject: `Recruiting inquiry from ${r.agency_name}`, text })
    .then(() => console.log(`[inquiry] #${id} emailed to ${to}`))
    .catch(err => console.error(`[inquiry] #${id} stored but the email failed:`, err.message));
});

/* ------------------------------------------------------------------
 * Agency Planner lead — "Email me my plan" on netenroll.com/agency-planner.
 *
 * Same shape as the recruiting inquiry: public, rate limited per IP, stored
 * before any email so a mail outage never loses a lead. The consent wording is
 * a server-side constant: what is recorded is what the page showed, never
 * text a client could submit.
 * ------------------------------------------------------------------ */
const PLANNER_CONSENT_V1 = "Yes, NetEnroll may call and text me at this number about my plan and NetEnroll's services, including with automated technology. Consent isn't required to get my plan. Msg & data rates may apply. Reply STOP to opt out.";
const PLANNER_RESULT_KEYS = ['take_home_y1', 'take_home_y2', 'take_home_y3', 'agents_needed', 'fe_apps_day', 'md_apps_day',
  'fe_spend_day', 'md_spend_day', 'exit_y3_low', 'exit_y3_base', 'exit_y3_high'];
const plannerTimes = new Map();

function validatePlannerLead(body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const row = {
    source: str(body.source, 60) || 'agency-planner',
    contact_name: str(body.contact_name, 200),
    agency_name: str(body.agency_name, 200),
    email: str(body.email, 254),
    phone: str(body.phone, 40),
    states: str(body.states, 500),
    sells: str(body.sells, 10),
    agents_today: num(body.agents_today),
    agents_next_year: num(body.agents_next_year),
    medicare_agents: num(body.medicare_agents),
    close_rate: num(body.close_rate),
    agent_pay: num(body.agent_pay),
    goal: num(body.goal),
    partners: num(body.partners),
    plan_url: str(body.plan_url, 4000)
  };
  for (const [key, label] of [['contact_name', 'Your name'], ['agency_name', 'Agency name'], ['email', 'Email'], ['phone', 'Mobile'], ['states', 'States you write in']]) {
    if (!row[key]) return { ok: false, error: `${label} is required` };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return { ok: false, error: 'A valid email address is required' };
  if (row.phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'A valid phone number is required' };
  if (!['fe', 'md', 'both'].includes(row.sells)) return { ok: false, error: 'sells must be fe, md or both' };
  if (!intIn(row.agents_today, 1, 1000)) return { ok: false, error: 'agents today must be a whole number from 1 to 1000' };
  if (!intIn(row.agents_next_year, row.agents_today, 2000)) return { ok: false, error: 'agents next year must be a whole number from agents today to 2000' };
  if (!intIn(row.medicare_agents, 0, row.agents_today)) return { ok: false, error: 'Medicare agents must be a whole number from 0 to agents today' };
  if (!inRange(row.close_rate, 0.01, 0.5)) return { ok: false, error: 'close rate must be between 0.01 and 0.5' };
  if (!inRange(row.agent_pay, 0, 1000)) return { ok: false, error: 'agent pay must be between 0 and 1000' };
  if (!inRange(row.goal, 0, 100000000)) return { ok: false, error: 'goal must be between 0 and 100000000' };
  if (!intIn(row.partners, 1, 6)) return { ok: false, error: 'partners must be a whole number from 1 to 6' };
  const src = body.results && typeof body.results === 'object' ? body.results : {};
  const results = {};
  for (const key of PLANNER_RESULT_KEYS) {
    const v = num(src[key]);
    if (!Number.isFinite(v) || Math.abs(v) > 1e11) return { ok: false, error: `results.${key} must be a number` };
    results[key] = v;
  }
  if (!row.plan_url.startsWith('https://netenroll.com/agency-planner/') || row.plan_url.length > 2000) {
    return { ok: false, error: 'plan_url must be a netenroll.com/agency-planner link' };
  }
  const consent = body.sms_consent === true;
  return {
    ok: true,
    results,
    row: { ...row, results_json: JSON.stringify(results), sms_consent: consent ? 1 : 0, consent_text: consent ? PLANNER_CONSENT_V1 : null }
  };
}

app.post('/api/planner-lead', (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (plannerTimes.get(ip) || []).filter(t => now - t < INQUIRY_WINDOW_MS);
  if (recent.length >= INQUIRY_MAX_PER_IP) {
    return res.status(429).json({ error: 'Too many requests from this connection. Please call 904-512-8487.' });
  }
  const checked = validatePlannerLead(req.body || {});
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  let id;
  try {
    id = db.insertPlannerLead({ ...checked.row, client_ip: ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) || null });
  } catch (err) {
    return fail(res, 500, 'The request could not be saved', err);
  }
  plannerTimes.set(ip, [...recent, now]);
  res.json({ ok: true, id });

  const r = checked.row;
  const x = checked.results;
  const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  const sellsLabel = { fe: 'Final Expense', md: 'Medicare', both: 'Final Expense and Medicare' }[r.sells];
  const send = (to, subject, text, who) => mail.sendMail({ to, subject, text })
    .then(() => console.log(`[planner] lead #${id} ${who} email sent`))
    .catch(err => console.error(`[planner] lead #${id} stored but the ${who} email failed:`, err.message));

  const operator = process.env.PLANNER_LEAD_EMAIL || process.env.RECRUITING_INQUIRY_EMAIL;
  if (!operator) {
    console.warn(`[planner] lead #${id} stored; PLANNER_LEAD_EMAIL and RECRUITING_INQUIRY_EMAIL are not set so no operator email was sent`);
  } else {
    send(operator, `Agency Planner lead: ${r.agency_name} (${r.agents_today} agents)`, [
      `Name: ${r.contact_name}`, `Agency: ${r.agency_name}`, `Email: ${r.email}`, `Phone: ${r.phone}`, `States: ${r.states}`,
      `Sells: ${sellsLabel}`, `Agents today: ${r.agents_today}`, `Agents in a year: ${r.agents_next_year}`, `Medicare agents: ${r.medicare_agents}`,
      `Close rate: ${Math.round(r.close_rate * 1000) / 10}%`, `Agent pay per placed policy: ${usd(r.agent_pay)}`, `Goal: ${usd(r.goal)}/month`,
      `Partners: ${r.partners}`, '',
      `Take-home per month: Year 1 ${usd(x.take_home_y1)}, Year 2 ${usd(x.take_home_y2)}, Year 3 ${usd(x.take_home_y3)}`,
      `Agents needed for the goal: ${Math.round(x.agents_needed)}`,
      `FE applications a day: ${Math.round(x.fe_apps_day * 10) / 10}`, `Medicare applications a day: ${Math.round(x.md_apps_day * 10) / 10}`,
      `Application spend a day: FE ${usd(x.fe_spend_day)}, Medicare ${usd(x.md_spend_day)}`,
      `Exit value end of Year 3: ${usd(x.exit_y3_low)} low, ${usd(x.exit_y3_base)} base, ${usd(x.exit_y3_high)} high`,
      `Text/call consent: ${r.sms_consent ? 'yes' : 'no'}`, '',
      `Plan: ${r.plan_url}`, `Lead #${id}`
    ].join('\n'), 'operator');
  }

  const first = r.contact_name.split(/\s+/)[0];
  send(r.email, 'Your agency plan from NetEnroll', [
    `Hi ${first},`, '',
    `You'd take home about ${usd(x.take_home_y2)} a month in Year 2.`,
    `To hit ${usd(r.goal)} a month, your plan takes ${Math.round(x.agents_needed)} agents and about ${Math.round((x.fe_apps_day + x.md_apps_day) * 10) / 10} submitted applications a day.`,
    `At the end of Year 3 your agency would sell for about ${usd(x.exit_y3_base)} (range ${usd(x.exit_y3_low)} to ${usd(x.exit_y3_high)}).`, '',
    `Reopen your plan: ${r.plan_url}`,
    'Open your producer account: https://agents.netenroll.com/login?mode=create',
    'Questions? Call 904-512-8487.', '',
    'NetEnroll'
  ].join('\n'), 'user');
});

app.use((req, res, next) => {
  const isStaticAsset = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(req.path) || req.path.startsWith('/lib/');
  if (PUBLIC_PATHS.includes(req.path) || req.path.startsWith('/webhook/') || isStaticAsset) {
    return next();
  }

  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (!session) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  req.user = session;
  req.sessionToken = token;
  // The single place a request's tenant is decided. Handlers read req.tenantId
  // and never derive it from anything the client sent.
  req.tenantId = session.tenant_id || null;
  req.isSuperadmin = session.role === 'superadmin';
  next();
});

/**
 * Guard for every route that touches tenant-owned data.
 *
 * A superadmin who has not chosen a tenant yet has no tenantId, and gets a
 * clear 409 rather than a confusing empty result set.
 */
function requireTenantContext(req, res) {
  if (req.tenantId) return true;
  res.status(409).json({
    error: req.isSuperadmin
      ? 'Select a tenant first (POST /api/tenants/switch).'
      : 'This account is not attached to a tenant.',
    needs_tenant: true
  });
  return false;
}

function requireSuperadmin(req, res) {
  if (req.isSuperadmin) return true;
  res.status(403).json({ error: 'Superadmin only' });
  return false;
}

// Serve main static assets with strict no-cache headers
app.use(express.static(path.resolve(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

/**
 * WebSocket clients, bucketed by tenant.
 *
 * This used to be one flat Set, which meant every connected browser received
 * every message event on the platform - each inbound reply, each status change,
 * for every tenant. A Map of tenant to socket set makes the delivery boundary
 * the same boundary as the data.
 */
const clientsByTenant = new Map();

function registerClient(tenantId, ws) {
  if (!clientsByTenant.has(tenantId)) clientsByTenant.set(tenantId, new Set());
  clientsByTenant.get(tenantId).add(ws);
}

function unregisterClient(tenantId, ws) {
  const bucket = clientsByTenant.get(tenantId);
  if (!bucket) return;
  bucket.delete(ws);
  if (bucket.size === 0) clientsByTenant.delete(tenantId);
}

function totalClients() {
  let n = 0;
  for (const bucket of clientsByTenant.values()) n += bucket.size;
  return n;
}

wss.on('connection', (ws, req) => {
  const token = getCookie(req.headers.cookie, 'session_token');
  const session = token ? db.validateSession(token) : null;
  if (!session) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  // The handshake resolves the tenant the same way HTTP does. A socket with no
  // tenant (a superadmin who has not switched yet) is refused rather than
  // parked in a bucket where it might catch another tenant's traffic.
  const tenantId = session.tenant_id;
  if (!tenantId) {
    ws.close(4003, 'No tenant selected');
    return;
  }

  ws.tenantId = tenantId;
  registerClient(tenantId, ws);
  console.log(`Client connected (tenant ${tenantId}). Total clients:`, totalClients());

  // Send current queue status upon connection
  ws.send(JSON.stringify({
    type: 'queue_status',
    data: db.getQueueStats(tenantId)
  }));

  ws.on('close', () => {
    unregisterClient(tenantId, ws);
    console.log('Client disconnected. Total clients:', totalClients());
  });
});

/** Broadcast to one tenant's sockets only. */
function broadcast(tenantId, type, data) {
  if (!tenantId) return;
  const bucket = clientsByTenant.get(Number(tenantId));
  if (!bucket) return;
  const payload = JSON.stringify({ type, data });
  bucket.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

/** The two events almost every mutation emits. */
function broadcastQueueStatus(tenantId) {
  if (!tenantId) return;
  broadcast(tenantId, 'queue_status', db.getQueueStats(tenantId));
}

// Listen for message status changes in the queue worker. The worker is global,
// so the event carries the tenant of the message it concerns.
queueWorker.on('messageStatusChanged', (msgEvent) => {
  const tenantId = msgEvent && msgEvent.tenant_id;
  if (!tenantId) return;
  broadcast(tenantId, 'message_status', msgEvent);
  broadcastQueueStatus(tenantId);
});

/* ==================================================================
 * Tenant administration (superadmin only)
 * ================================================================== */

/** Who am I, and which tenant am I acting as. Drives the sidebar header. */
app.get('/api/me', (req, res) => {
  try {
    const tenant = req.tenantId ? db.getTenantById(req.tenantId) : null;
    res.json({
      username: req.user.username,
      role: req.user.role,
      tenant_id: req.tenantId,
      tenant_name: tenant ? tenant.name : null,
      tenant_slug: tenant ? tenant.slug : null,
      is_superadmin: req.isSuperadmin,
      // Only a superadmin gets the list; everyone else sees their own tenant.
      tenants: req.isSuperadmin ? db.getTenants() : (tenant ? [tenant] : [])
    });
  } catch (err) {
    fail(res, 500, 'Could not load session context', err);
  }
});

app.get('/api/tenants', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    res.json(db.getTenants());
  } catch (err) {
    fail(res, 500, 'Could not list tenants', err);
  }
});

app.post('/api/tenants', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { name, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    res.status(201).json(db.createTenant(name, slug || null));
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

/** Point this superadmin's session at a tenant. */
app.post('/api/tenants/switch', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { tenant_id } = req.body || {};
  try {
    const session = db.setSessionTenant(req.sessionToken, tenant_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const tenant = db.getTenantById(session.tenant_id);
    res.json({ success: true, tenant_id: session.tenant_id, tenant_name: tenant && tenant.name });
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

app.post('/api/tenants/:id/users', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const tenantId = parseInt(req.params.id, 10);
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (role && !['owner', 'agent'].includes(role)) {
    return res.status(400).json({ error: "role must be 'owner' or 'agent'" });
  }
  try {
    db.createUser(username, password, { tenantId, role: role || 'agent' });
    res.status(201).json({ success: true, username: String(username).trim().toLowerCase() });
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

/* --- DID ownership (superadmin only) --- */

app.get('/api/tenants/:id/dids', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    res.json(db.getTenantDids(parseInt(req.params.id, 10)));
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

app.post('/api/tenants/:id/dids', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { did, enabled } = req.body || {};
  if (!did) return res.status(400).json({ error: 'did is required' });
  try {
    res.status(201).json(db.assignDidToTenant(parseInt(req.params.id, 10), did, {
      enabled: enabled !== false
    }));
  } catch (err) {
    fail(res, 409, err.message, err);
  }
});

app.delete('/api/tenants/:id/dids/:did', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    db.removeDidFromTenant(parseInt(req.params.id, 10), req.params.did);
    res.json({ success: true });
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

/* --- The one cross-tenant list: litigators and DNC numbers --- */

app.get('/api/global-suppression', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    res.json(db.getGlobalSuppression());
  } catch (err) {
    fail(res, 500, 'Could not load the global list', err);
  }
});

app.post('/api/global-suppression', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  const { phone_number, reason, detail } = req.body || {};
  if (!phone_number) return res.status(400).json({ error: 'phone_number is required' });
  try {
    res.status(201).json(db.addGlobalSuppression(phone_number, {
      reason: reason || 'dnc',
      detail: detail || null,
      actor: req.user.username
    }));
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

app.delete('/api/global-suppression/:phone', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  try {
    db.removeGlobalSuppression(req.params.phone);
    res.json({ success: true });
  } catch (err) {
    fail(res, 400, err.message, err);
  }
});

// REST API Endpoints

// 1. Get all conversations
app.get('/api/conversations', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    // The list view needs a fraction of each row. Sending the full record for
    // every contact was megabytes of JSON parsed on each load for fields the
    // sidebar never renders.
    const list = db.getConversationsForList(req.tenantId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create new conversation
app.post('/api/conversations', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { phone_number, name, city, zip } = req.body;
  if (!phone_number) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    // Whatever merge columns the body carries, without naming them one by one.
    const extra = {};
    for (const column of db.MERGE_COLUMNS) {
      if (req.body[column] != null && req.body[column] !== '') extra[column] = req.body[column];
    }
    const conv = db.getOrCreateConversation(req.tenantId, phone_number, name, city || null, zip || null, extra);
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2.5. Delete conversation
app.delete('/api/conversations/:id', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseInt(req.params.id, 10);
  try {
    // Ownership is verified before the delete, so another tenant's id is a 404
    // rather than a silent no-op reported as success.
    if (!db.getConversationById(req.tenantId, convId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    db.deleteConversation(req.tenantId, convId);
    broadcast(req.tenantId, 'conversation_deleted', { id: convId });
    broadcastQueueStatus(req.tenantId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get messages for a conversation (and mark conversation read)
app.get('/api/conversations/:id/messages', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseInt(req.params.id, 10);
  try {
    if (!db.getConversationById(req.tenantId, convId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    db.markConversationRead(req.tenantId, convId);
    broadcast(req.tenantId, 'conversation_read', { id: convId });
    const messages = db.getMessages(req.tenantId, convId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.5. Mark conversation read explicitly
app.post('/api/conversations/:id/read', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseInt(req.params.id, 10);
  try {
    if (!db.getConversationById(req.tenantId, convId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    db.markConversationRead(req.tenantId, convId);
    broadcast(req.tenantId, 'conversation_read', { id: convId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.6. Set / clear a lead disposition
app.post('/api/conversations/:id/disposition', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  const { disposition, scheduled_at, note, allow_past } = req.body;
  const wantsSchedule = disposition === 'appointment' || disposition === 'follow_up';

  if (disposition !== null && disposition !== undefined &&
      !db.VALID_DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: `Invalid disposition: ${disposition}` });
  }
  if (typeof note === 'string' && note.length > 1000) {
    return res.status(400).json({ error: 'Note exceeds 1000 characters' });
  }

  let utcSchedule = null;
  if (wantsSchedule) {
    // Past times are allowed only when the client explicitly asks, so that a
    // missed appointment can be logged after the fact without a silent default.
    const validation = validateScheduleInput(scheduled_at, { allowPast: allow_past === true });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    utcSchedule = validation.utc;
  }

  try {
    const updated = db.setConversationDisposition(
      req.tenantId,
      convId,
      disposition || null,
      utcSchedule,
      note || null,
      req.user && req.user.username
    );
    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    broadcast(req.tenantId, 'conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// 3.6b. Explicit re-opt-in. Deliberately separate from disposition changes so
// that clearing a disposition can never resurrect a suppressed contact.
app.post('/api/conversations/:id/opt-in', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  if (req.body.confirm !== true) {
    return res.status(400).json({
      error: 'Re-opt-in requires explicit confirmation ({"confirm": true})'
    });
  }

  try {
    const actor = (req.user && req.user.username) || 'unknown';
    const updated = db.recordOptIn(req.tenantId, convId, actor);
    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    broadcast(req.tenantId, 'conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// Notes API
app.get('/api/conversations/:id/notes', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const paramId = req.params.id;
  const phoneNumber = req.query.phone_number || null;
  let convId = parseConversationId(paramId);

  try {
    const notes = db.getNotesForTarget(req.tenantId, { conversationId: convId, phoneNumber });
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations/:id/notes', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const paramId = req.params.id;
  const { note_text, phone_number } = req.body;
  let convId = parseConversationId(paramId);

  if (!note_text || typeof note_text !== 'string' || !note_text.trim()) {
    return res.status(400).json({ error: 'Note text is required' });
  }

  try {
    const newNote = db.addNoteForTarget(req.tenantId, {
      conversationId: convId,
      phoneNumber: phone_number || null,
      noteText: note_text
    });
    broadcast(req.tenantId, 'note_created', { conversation_id: convId, note: newNote });
    res.json(newNote);
  } catch (err) {
    // A conversation belonging to another tenant reads as not found.
    if (/does not belong to tenant/.test(err.message)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:noteId', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const noteId = parseInt(req.params.noteId, 10);
  if (isNaN(noteId)) {
    return res.status(400).json({ error: 'Invalid note id' });
  }
  try {
    const result = db.deleteNote(req.tenantId, noteId);
    if (!result.changes) {
      return res.status(404).json({ error: 'Note not found' });
    }
    broadcast(req.tenantId, 'note_deleted', { note_id: noteId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.6c. Manually suppress a contact.
app.post('/api/conversations/:id/opt-out', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }

  try {
    const actor = (req.user && req.user.username) || 'unknown';
    const kind = req.body.kind === 'wrong_number' ? 'wrong_number' : 'opt_out';
    const updated = kind === 'wrong_number'
      ? db.recordWrongNumber(req.tenantId, convId, { source: 'manual', text: req.body.reason || null, actor })
      : db.recordOptOut(req.tenantId, convId, { source: 'manual', text: req.body.reason || null, actor });

    if (!updated) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    broadcast(req.tenantId, 'conversation_disposition', updated);
    res.json(updated);
  } catch (err) {
    return fail(res, 400, err.message, err);
  }
});

// 3.6e. Reminder state. Persisted server-side so a reminder fires once per
// tier and survives page refreshes and server restarts.
app.get('/api/reminders', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    res.json({ notified: db.getNotifiedReminders(req.tenantId) });
  } catch (err) {
    return fail(res, 500, 'Could not load reminder state', err);
  }
});

app.post('/api/reminders/ack', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseConversationId(req.body.conversation_id);
  const { scheduled_at, tier } = req.body;

  if (convId === null || typeof scheduled_at !== 'string' || typeof tier !== 'string') {
    return res.status(400).json({ error: 'conversation_id, scheduled_at and tier are required' });
  }
  if (!db.REMINDER_TIERS.includes(tier)) {
    return res.status(400).json({ error: `Unknown reminder tier: ${tier}` });
  }

  try {
    const ok = db.acknowledgeReminder(req.tenantId, convId, scheduled_at, tier);
    if (ok === null) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({ success: true });
  } catch (err) {
    return fail(res, 500, 'Could not record reminder', err);
  }
});

// 3.6d. Run the historical suppression backfill on demand.
app.post('/api/admin/backfill-suppression', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    const summary = db.backfillSuppression(req.tenantId, { dryRun: req.body.dry_run === true });
    console.log('[backfill] summary:', JSON.stringify(summary));
    res.json(summary);
  } catch (err) {
    return fail(res, 500, 'Backfill failed', err);
  }
});

// 3.7. Performance stats for a date range
app.get('/api/stats', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { from, to, start, end, tz_offset } = req.query;

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must not be after to' });
  }

  // The browser sends the exact UTC instants bounding its LOCAL day range,
  // plus its offset, so a message sent at 8pm Eastern is counted on the day
  // the user actually sent it rather than rolling into the next UTC day.
  const options = {};
  if (start && end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate >= endDate) {
      return res.status(400).json({ error: 'Invalid start/end instants' });
    }
    options.startUtc = startDate.toISOString().slice(0, 19).replace('T', ' ');
    options.endUtc = endDate.toISOString().slice(0, 19).replace('T', ' ');
  }
  const offset = Number(tz_offset);
  if (Number.isFinite(offset) && Math.abs(offset) <= 900) {
    options.tzOffsetMinutes = offset;
  }

  try {
    res.json(db.getStats(req.tenantId, from, to, options));
  } catch (err) {
    return fail(res, 500, 'Could not load stats', err);
  }
});

// 4. Queue a message (Outbound)
app.post('/api/conversations/:id/messages', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const convId = parseConversationId(req.params.id);
  if (convId === null) {
    return res.status(400).json({ error: 'Invalid conversation id' });
  }
  const { body, media_urls, scheduled_at, from_number } = req.body;

  if (typeof body === 'string' && body.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message body exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (scheduled_at !== undefined && scheduled_at !== null && scheduled_at !== '') {
    const validation = validateScheduleInput(scheduled_at, { allowPast: false });
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
  }

  try {
    // Look the conversation up directly. This used to load every conversation
    // and scan the array, so a single send read all ~9,400 rows.
    const conv = db.getConversationById(req.tenantId, convId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Hard suppression blocks even a deliberate one-to-one send. Business
    // dispositions (No / Unqualified / Customer) do not — a human may still
    // reply to someone they marked as a customer.
    const block = db.getSuppressionBlock(req.tenantId, conv, { scope: 'individual' });
    if (block) {
      db.logSuppressionEvent(req.tenantId, convId, conv.phone_number, 'blocked_send', block.reason,
                             'individual send rejected', req.user && req.user.username);
      return res.status(409).json({
        error: `Cannot message this contact: ${block.label}.`,
        blocked: true,
        reason: block.reason,
        label: block.label
      });
    }

    // Sticky rotation: reuses this contact's pinned DID, or claims the next one
    // from this tenant's own pool.
    const fromNum = db.resolveSenderNumber(req.tenantId, convId, from_number);

    const msgData = {
      conversation_id: convId,
      direction: 'outbound',
      from_number: fromNum,
      to_number: conv.phone_number,
      body: body || '',
      media_urls: media_urls || null,
      status: 'queued',
      scheduled_at: scheduled_at || null
    };

    const inserted = db.insertMessage(req.tenantId, msgData);

    // Broadcast message creation
    broadcast(req.tenantId, 'message_new', inserted);
    broadcastQueueStatus(req.tenantId);

    // Proactively kick the queue worker in case it's waiting
    queueWorker.processNext();

    res.status(201).json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Build the per-campaign variant pool.
 *
 * Wrapped so a variation failure can never block a campaign: on any error the
 * caller gets a single-entry pool holding the original template, which is the
 * behaviour the system had before variation existed.
 */
async function buildVariantPool(tenantId, template, conversationIds) {
  try {
    // The Anthropic key is global, but the widths come from this tenant's own
    // contacts - measuring another tenant's names would size the template wrong.
    return await variation.buildPool(template, db.getEffectiveSettings(tenantId), {
      // Segment checks run against merged text, so they need the real widths
      // of the names and cities this campaign will substitute.
      placeholderWidths: db.getPlaceholderWidths(tenantId, conversationIds)
    });
  } catch (err) {
    console.error('[variation] pool generation failed, sending template unchanged:', err.message);
    return { pool: [template], enabled: false, stats: null, error: err.message };
  }
}

/** What the UI needs to know about how a campaign was varied. */
function summarizeVariation(variants) {
  if (!variants || !variants.pool) return { enabled: false, pool_size: 0 };
  return {
    enabled: !!variants.enabled,
    pool_size: variants.pool.length,
    // Present but 1 means variation ran and produced nothing usable, which is
    // worth surfacing: the campaign went out on a single body.
    accepted: variants.stats ? variants.stats.accepted : 0,
    rejected: variants.stats ? variants.stats.rejected : 0,
    rejections: variants.stats ? variants.stats.rejections : {},
    error: variants.error || (variants.stats ? variants.stats.error : null)
  };
}

// 4.5. Bulk Upload Leads & Campaign Sending
app.post('/api/leads/upload', async (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { leads, message_template, from_number } = req.body;
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Leads array is required' });
  }
  if (leads.length > MAX_LEADS_PER_UPLOAD) {
    return res.status(400).json({ error: `Too many leads in one upload (max ${MAX_LEADS_PER_UPLOAD})` });
  }
  if (message_template && message_template.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message template exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }

  try {
    const variants = message_template
      ? await buildVariantPool(req.tenantId, message_template)
      : { pool: null, enabled: false, stats: null };

    const result = db.bulkImportLeads(req.tenantId, leads, message_template || null, from_number || null, {
      variantPool: variants.pool
    });

    // Broadcast new messages via WebSockets if any
    if (result.messages.length > 0) {
      result.messages.forEach(msg => {
        broadcast(req.tenantId, 'message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }

    // Update queue stats on dashboard
    broadcastQueueStatus(req.tenantId);

    // Structured summary: `messages` and `skipped` are the raw arrays, the
    // rest are the audited counts. imported_count is deliberately gone —
    // it used to include contacts that were then skipped.
    const { messages, skipped, ...counts } = result;
    res.json({ success: true, ...counts, skipped, variation: summarizeVariation(variants) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.6. Send Bulk Message to Selected Conversations
app.post('/api/conversations/bulk-message', async (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { conversation_ids, message_text, from_number } = req.body;
  if (!conversation_ids || !Array.isArray(conversation_ids)) {
    return res.status(400).json({ error: 'conversation_ids array is required' });
  }
  if (!message_text) {
    return res.status(400).json({ error: 'message_text is required' });
  }
  if (conversation_ids.length > MAX_BULK_RECIPIENTS) {
    return res.status(400).json({ error: `Too many recipients (max ${MAX_BULK_RECIPIENTS})` });
  }
  if (message_text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }

  try {
    const variants = await buildVariantPool(req.tenantId, message_text, conversation_ids);
    // Ids belonging to another tenant simply are not found and are skipped.
    const { messages, skipped } = db.sendBulkMessages(
      req.tenantId, conversation_ids, message_text, from_number || null, { variantPool: variants.pool }
    );

    // Broadcast new messages via WebSockets if any
    if (messages.length > 0) {
      messages.forEach(msg => {
        broadcast(req.tenantId, 'message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }

    // Update queue stats on dashboard
    broadcastQueueStatus(req.tenantId);

    res.json({
      success: true,
      queued_count: messages.length,
      skipped_count: skipped.length,
      skipped_opted_out: skipped.filter(s => s.reason === 'opted_out').length,
      skipped_wrong_number: skipped.filter(s => s.reason === 'wrong_number').length,
      skipped_disposition: skipped.filter(s => String(s.reason).startsWith('disposition_')).length,
      skipped: skipped,
      variation: summarizeVariation(variants)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.7. Send Bulk Message to Specific Stages (Campaigns)
app.post('/api/campaigns', async (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { stages, message_text, from_number } = req.body;
  if (!stages || !Array.isArray(stages) || stages.length === 0) {
    return res.status(400).json({ error: 'stages array is required' });
  }
  if (!message_text) {
    return res.status(400).json({ error: 'message_text is required' });
  }

  try {
    // Find all conversations in target stages, within this tenant.
    const placeholders = stages.map(() => '?').join(',');
    const conversations = db.db.prepare(`
      SELECT id FROM conversations WHERE tenant_id = ? AND stage IN (${placeholders})
    `).all(req.tenantId, ...stages);

    const conversationIds = conversations.map(c => c.id);
    if (conversationIds.length === 0) {
      return res.json({
        success: true,
        queued_count: 0,
        message: 'No contacts found in selected stages.'
      });
    }

    const variants = await buildVariantPool(req.tenantId, message_text, conversationIds);
    const { messages, skipped } = db.sendBulkMessages(
      req.tenantId, conversationIds, message_text, from_number || null, { variantPool: variants.pool }
    );

    // Broadcast new messages via WebSockets if any
    if (messages.length > 0) {
      messages.forEach(msg => {
        broadcast(req.tenantId, 'message_new', msg);
      });
      // Wake up queue worker
      queueWorker.processNext();
    }

    // Update queue stats on dashboard
    broadcastQueueStatus(req.tenantId);

    res.json({
      success: true,
      queued_count: messages.length,
      skipped_count: skipped.length,
      skipped_opted_out: skipped.filter(s => s.reason === 'opted_out').length,
      skipped_wrong_number: skipped.filter(s => s.reason === 'wrong_number').length,
      skipped_disposition: skipped.filter(s => String(s.reason).startsWith('disposition_')).length,
      skipped: skipped,
      variation: summarizeVariation(variants)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4.8. Score a template for carrier spam-filter risk before queueing it.
//
// Content is not the biggest lever in 10DLC filtering - per-number volume and
// opt-out rate matter more - but it is the one that is free to fix, and it is
// far cheaper to catch a bad template here than after 5,000 copies have gone
// out from a number whose reputation then has to recover.
app.post('/api/messages/lint', (req, res) => {
  const { text, bulk } = req.body || {};
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` });
  }
  if (!requireTenantContext(req, res)) return;
  try {
    // brand_terms is a per-tenant list, so the lint runs on this tenant's brand.
    const settings = db.getEffectiveSettings(req.tenantId);
    const result = contentLint.lint(text, {
      // One-to-one replies do not need the disclosure repeated; a bulk or
      // first-touch send does.
      requireOptOut: bulk !== false,
      brandTerms: (settings.brand_terms || '').split(',').map(s => s.trim()).filter(Boolean)
    });
    res.json(result);
  } catch (err) {
    fail(res, 500, 'Could not lint message', err);
  }
});

// 5. Get current settings
app.get('/api/settings', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    // Global defaults with this tenant's overrides applied.
    const settings = db.getEffectiveSettings(req.tenantId);
    // The Anthropic key is never echoed back. The UI needs to know whether one
    // is set, not what it is. (The carrier credentials in this response predate
    // this change and are left as-is rather than silently breaking the settings
    // form that reads them.)
    const { anthropic_api_key, ...rest } = settings;

    // The numbers this tenant may send from. Derived from tenant_dids on every
    // read rather than mirrored into settings - the CSV that used to live here
    // was deleted by the multi-tenant migration precisely so there would be
    // one source of truth, and the sender dropdowns went blank because they
    // were still reading it.
    const dids = db.getTenantDids(req.tenantId)
      .filter(d => d.enabled)
      .map(d => d.did);

    res.json({
      ...rest,
      tenant_dids: dids,
      // The browser maps CSV headers and renders the placeholder help from
      // this, so both follow the server's definition instead of a second copy.
      merge_fields: mergeFields.describe(),
      anthropic_api_key_set: !!anthropic_api_key
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5.5. Get recent queue activity messages
app.get('/api/queue/recent', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const recent = db.getRecentMessages(req.tenantId, limit);
    res.json(recent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function configureFractelWebhook(settings, hostUrl) {
  const username = settings.fractel_username;
  const password = settings.fractel_password;
  const senderNumber = settings.fractel_sender_number;
  
  if (!username || !password || !senderNumber) {
    console.log("FracTEL credentials or sender number missing, skipping webhook auto-config.");
    return;
  }

  try {
    console.log("Requesting token for FracTEL webhook configuration...");
    const authRes = await fetch('https://api.fonestorm.com/v2/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, expires: 3600 })
    });
    
    if (!authRes.ok) {
      console.error("FracTEL auth failed for webhook config:", authRes.status);
      return;
    }
    
    const authData = await authRes.json();
    const token = authData.auth && authData.auth.token;
    if (!token) {
      console.error("No token in FracTEL auth response for webhook config");
      return;
    }

    let cleanNumber = senderNumber.replace(/[^\d]/g, '');
    if (cleanNumber.length === 11 && cleanNumber.startsWith('1')) {
      cleanNumber = cleanNumber.substring(1);
    }
    const webhookUrl = `${hostUrl}/webhook/inbound`;
    console.log(`Configuring FracTEL inbound webhook for DID ${cleanNumber} to: ${webhookUrl}`);
    
    const putRes = await fetch(`https://api.fonestorm.com/v2/fonenumbers/${cleanNumber}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({
        sms_options: {
          receive_notify: {
            type: 'Callback',
            method: 'JSON',
            url: webhookUrl
          }
        }
      })
    });

    const putData = await putRes.json();
    console.log("FracTEL webhook configuration response:", JSON.stringify(putData));
  } catch (err) {
    console.error("Failed to auto-configure FracTEL webhook:", err);
  }
}

// 6. Update settings
app.post('/api/settings', async (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    const incoming = { ...req.body };

    // The GET response never contains the key, so a settings form round-trip
    // sends back an empty string. Treat that as "leave it alone" rather than
    // "delete it" - otherwise saving any unrelated setting disables variation.
    if ('anthropic_api_key' in incoming && !String(incoming.anthropic_api_key).trim()) {
      delete incoming.anthropic_api_key;
    }
    delete incoming.anthropic_api_key_set;

    // Carrier credentials and the LLM key are platform-wide and only a
    // superadmin may change them; everything else is written per tenant.
    const globalKeys = {};
    const tenantKeys = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (db.GLOBAL_ONLY_SETTINGS.has(key)) globalKeys[key] = value;
      else tenantKeys[key] = value;
    }
    if (Object.keys(globalKeys).length && !req.isSuperadmin) {
      return res.status(403).json({
        error: 'Carrier and API credentials are platform-wide and can only be changed by a superadmin.',
        rejected_keys: Object.keys(globalKeys)
      });
    }
    if (Object.keys(globalKeys).length) db.updateSettings(globalKeys);
    db.updateTenantSettings(req.tenantId, tenantKeys);
    const updated = db.getEffectiveSettings(req.tenantId);

    // Pacing settings are cached in the worker; drop the cache so a change to
    // the gap, cap, or quiet hours takes effect on the next send rather than
    // after a restart.
    queueWorker.refreshConfig();

    // Determine the host URL dynamically
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const hostUrl = `${protocol}://${host}`;
    
    // Do NOT automatically configure/change webhook settings on FracTEL to protect existing campaigns/apps.
    /*
    configureFractelWebhook(updated, hostUrl).catch(err => {
      console.error("FracTEL webhook config error:", err);
    });
    */

    const { anthropic_api_key, ...safe } = updated;
    res.json({ ...safe, anthropic_api_key_set: !!anthropic_api_key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get queue status
app.get('/api/queue/status', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    const stats = db.getQueueStats(req.tenantId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7.5. Per-DID pacing state: how much each number has sent today, what its
// current allowance is, whether it is warming up or paused on a failure spike.
// This is the view that tells you why a queue is draining slowly.
app.get('/api/pacing/status', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  try {
    // Only this tenant's own numbers.
    const dids = db.getTenantDids(req.tenantId).map(row => row.did);
    res.json(queueWorker.pacingStatus(dids));
  } catch (err) {
    fail(res, 500, 'Could not read pacing status', err);
  }
});

// 7.6. Clear a failure-spike pause on one number.
app.post('/api/pacing/resume', (req, res) => {
  if (!requireTenantContext(req, res)) return;
  const { did } = req.body || {};
  if (!did) return res.status(400).json({ error: 'did is required' });
  try {
    // A tenant may only resume a number it owns.
    if (db.resolveTenantForDid(did) !== req.tenantId) {
      return res.status(404).json({ error: 'No pacing state for that number' });
    }
    const resumed = queueWorker.resumeDid(did);
    if (!resumed) return res.status(404).json({ error: 'No pacing state for that number' });
    console.log(`[pacing] DID ${did} manually resumed by ${req.user && req.user.username}`);
    res.json({ success: true, did });
  } catch (err) {
    fail(res, 500, 'Could not resume number', err);
  }
});

// 8. Inbound Webhook from Bulkvs
app.post('/webhook/inbound', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`Inbound webhook received from IP ${ip}:`, JSON.stringify(req.body));
  
  const From = req.body.From || req.body.from;
  const To = req.body.To || req.body.to;
  const Message = req.body.Message || req.body.message;
  const MediaURLs = req.body.MediaURLs || (req.body.media ? [req.body.media] : null);
  const DeliveryReceipt = req.body.DeliveryReceipt || req.body.delivery_receipt;
  const RefId = req.body.RefId || req.body.id;

  if (!From) {
    return res.status(400).send('Missing From field');
  }

  try {
    // Handle Bulkvs Delivery Receipts (DLR)
    if (DeliveryReceipt === true || DeliveryReceipt === 'true') {
      console.log(`Handling delivery receipt for RefId: ${RefId}`);
      
      const decodedMsg = decodeURIComponent(Message || '');
      const statMatch = decodedMsg.match(/stat:([A-Z]+)/);
      const errMatch = decodedMsg.match(/err:(\d+)/);
      
      const status = statMatch ? statMatch[1] : '';
      const errCode = errMatch ? errMatch[1] : '';

      // A receipt arrives with nothing but a ref_id, so the message row is
      // where its tenant is discovered. Every write below is scoped to it.
      const targetMsg = db.getMessageByRefId(RefId);
      if (targetMsg && targetMsg.tenant_id) {
        const tenantId = targetMsg.tenant_id;
        if (status === 'DELIVRD') {
          // Real handset confirmation. Without this the stats can only report
          // carrier acceptance, which is not the same thing.
          db.recordDelivery(tenantId, targetMsg.id, status);
          console.log(`[dlr] message ${targetMsg.id} confirmed delivered.`);
          broadcast(tenantId, 'message_status', {
            id: targetMsg.id,
            status: 'sent',
            delivered: true,
            conversation_id: targetMsg.conversation_id
          });
        } else if (status === 'UNDELIV' || status === 'REJECTD' || status === 'EXPIRED') {
          db.recordCarrierStatus(tenantId, targetMsg.id, status);
          const errorDetail = `Carrier delivery failed: ${status} (err: ${errCode || 'unknown'})`;
          db.updateMessageStatus(tenantId, targetMsg.id, 'failed', RefId, errorDetail);

          broadcast(tenantId, 'message_status', {
            id: targetMsg.id,
            status: 'failed',
            error_message: errorDetail,
            conversation_id: targetMsg.conversation_id
          });
          broadcastQueueStatus(tenantId);
        }
      }
      return res.status(200).send('OK');
    }

    // Get target number
    const toNum = (Array.isArray(To) ? To[0] : To) || '';
    const inboundDid = (toNum || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');

    // THE ROUTING DECISION. The number they texted identifies the tenant, and
    // it is resolved before any conversation is touched - otherwise an inbound
    // to an unknown number would create a contact belonging to nobody.
    const tenantId = db.resolveTenantForDid(inboundDid);
    if (!tenantId) {
      // 200, not an error: the carrier retries on anything else, and there is
      // nothing to retry into. Logged loudly because it means a DID is live at
      // the carrier but not registered here.
      console.warn(`[webhook] inbound to unrouted DID '${toNum}' from ${From} - ignored. ` +
                   'Assign the number to a tenant in tenant_dids to accept its replies.');
      return res.status(200).send('OK');
    }

    // The same message can arrive more than once - a carrier retry, or two
    // callbacks configured on one number both firing. Drop the repeat before
    // it becomes a second row in somebody's thread.
    if (RefId && db.inboundExists(tenantId, RefId)) {
      console.log(`[webhook] duplicate inbound ${RefId} ignored (already stored).`);
      return res.status(200).send('OK');
    }

    // Create/get conversation for sender, inside the resolved tenant.
    const conv = db.getOrCreateConversation(tenantId, From);

    // Pin the conversation to whichever of our DIDs they texted, so our reply
    // goes back from the number already showing in their thread.
    if (!conv.assigned_did) {
      db.setConversationDid(tenantId, conv.id, inboundDid);
    }

    const msgData = {
      conversation_id: conv.id,
      direction: 'inbound',
      from_number: From,
      to_number: toNum,
      body: Message || '',
      media_urls: MediaURLs || null,
      status: 'received',
      ref_id: RefId || null
    };

    // Insert message into database
    const inserted = db.insertMessage(tenantId, msgData);

    // Broadcast new message via websocket, to that tenant only
    broadcast(tenantId, 'message_new', inserted);

    // Send 200 OK as requested by Bulkvs
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error saving inbound message:', err);
    res.status(500).send('Error saving message');
  }
});

// Serve frontend routing fallback with strict no-cache headers
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Clear-Site-Data', '"cache"');
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Start Server
const port = process.env.PORT || 3100;
server.listen(port, () => {
  console.log(`NetEnroll Messaging server listening on port ${port}`);
});
