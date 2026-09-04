/**
 * Boots the REAL server.js as a child process against a throwaway database and
 * returns an authenticated HTTP client. Nothing here mocks the application.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', '..', 'server.js');

function findFreePort() {
  // Ports are picked from a high range; a collision just fails the boot wait.
  return 4700 + Number(process.hrtime.bigint() % 200n);
}

async function startServer({ label = 'api', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sms-server-${label}-`));
  const dbFile = path.join(dir, 'test.sqlite');
  const port = findFreePort();

  // The superadmin is seeded at boot from these, so the suite knows the
  // credentials without scraping them out of stdout.
  const SUPERADMIN_USERNAME = 'root-admin';
  const SUPERADMIN_PASSWORD = 'superadmin-test-password';

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SMS_DB_PATH: dbFile,
      PORT: String(port),
      NODE_ENV: 'test',
      SUPERADMIN_USERNAME,
      SUPERADMIN_PASSWORD,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  const errors = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => { errors.push(d.toString()); logs.push(d.toString()); });

  const base = `http://127.0.0.1:${port}`;

  // Wait for the port to answer.
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${base}/api/auth/status`);
      if (res.ok) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server did not start in time:\n${logs.join('')}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }

  let cookie = '';

  async function request(method, url, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* html or plain text */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    base,
    port,
    dbFile,
    logs,
    errors,
    get serverErrors() {
      // Ignore the expected websocket/carrier noise of a test environment.
      return errors.filter(e => !/ECONNREFUSED|FracTEL|BulkVS|carrier/i.test(e));
    },
    request,
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    del: (url, opts) => request('DELETE', url, undefined, opts),
    superadmin: { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD },

    /** Sign in as the seeded platform superadmin. */
    async loginSuperadmin() {
      return request('POST', '/api/auth/login',
        { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD }, { auth: false });
    },

    /**
     * The standard test setup: sign in as superadmin, create a tenant, create
     * an owner inside it, then sign in as that owner.
     *
     * Replaces the old signup() helper. Self-service signup is gone: accounts
     * only exist inside a tenant, and only a superadmin creates them.
     */
    async signup(username = 'tester', password = 'test-password-123',
                 { tenantName = 'Test Tenant', dids = ['5555550100'] } = {}) {
      const admin = await request('POST', '/api/auth/login',
        { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD }, { auth: false });
      if (admin.status !== 200) return admin;

      const tenant = await request('POST', '/api/tenants', { name: tenantName });
      if (tenant.status !== 201) return tenant;
      const tenantId = tenant.json.id;

      for (const did of dids) {
        await request('POST', `/api/tenants/${tenantId}/dids`, { did });
      }

      const created = await request('POST', `/api/tenants/${tenantId}/users`,
        { username, password, role: 'owner' });
      if (created.status !== 201) return created;

      const login = await request('POST', '/api/auth/login', { username, password }, { auth: false });
      return { ...login, tenantId, tenantName };
    },

    /** Create an additional tenant with its own owner, as superadmin. */
    async createTenantWithOwner(tenantName, username, password = 'test-password-123', dids = []) {
      const saved = cookie;
      cookie = '';
      await request('POST', '/api/auth/login',
        { username: SUPERADMIN_USERNAME, password: SUPERADMIN_PASSWORD }, { auth: false });
      const tenant = await request('POST', '/api/tenants', { name: tenantName });
      const tenantId = tenant.json.id;
      for (const did of dids) {
        await request('POST', `/api/tenants/${tenantId}/dids`, { did });
      }
      await request('POST', `/api/tenants/${tenantId}/users`, { username, password, role: 'owner' });
      cookie = saved;
      return { tenantId, username, password };
    },

    async login(username = 'tester', password = 'test-password-123') {
      return request('POST', '/api/auth/login', { username, password }, { auth: false });
    },
    clearCookie() { cookie = ''; },
    async stop() {
      child.kill();
      await new Promise(r => { child.on('exit', r); setTimeout(r, 2000); });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  };
}

module.exports = { startServer };
