/**
 * Outbound email over SMTP, with nothing but the standard library.
 *
 * Implicit TLS on port 465 with AUTH LOGIN, which every transactional
 * provider and Gmail app-password setup accepts. Configure with SMTP_HOST,
 * SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM. Plain-text messages only.
 *
 * ponytail: no STARTTLS (587) and no attachments; add a `net` + STARTTLS
 * branch if a provider ever refuses 465.
 */
'use strict';

const tls = require('tls');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function sendMail({ to, subject, text }) {
  if (!isConfigured()) return Promise.reject(new Error('SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)'));
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => step());
    socket.setEncoding('utf8');
    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);

    let buffer = '';
    let waiting = null;   // { expect, resolve }

    // A reply is complete at the first line whose code is followed by a
    // space; "250-" lines are continuations.
    function check() {
      const m = buffer.match(/^(\d{3})[ ](?:.*)\r?\n/m);
      if (!m || !waiting) return;
      const reply = buffer; buffer = '';
      const { expect, resolve: next } = waiting; waiting = null;
      if (m[1] !== expect) return fail(new Error(`SMTP expected ${expect}, got: ${reply.trim()}`));
      next();
    }
    socket.on('data', chunk => { buffer += chunk; check(); });

    // check() runs here too, in case the reply landed before we asked for it.
    const expect = (code) => new Promise(r => { waiting = { expect: code, resolve: r }; check(); });
    const send = (line, code) => { socket.write(line + '\r\n'); return expect(code); };
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

    async function step() {
      try {
        await expect('220');
        await send('EHLO netenroll.com', '250');
        await send('AUTH LOGIN', '334');
        await send(b64(process.env.SMTP_USER), '334');
        await send(b64(process.env.SMTP_PASS), '235');
        await send(`MAIL FROM:<${from}>`, '250');
        await send(`RCPT TO:<${to}>`, '250');
        await send('DATA', '354');
        const body = [
          `From: NetEnroll <${from}>`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          `Date: ${new Date().toUTCString()}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
        ].join('\r\n');
        await send(body + '\r\n.', '250');
        await send('QUIT', '221');
        socket.end();
        resolve();
      } catch (err) { fail(err); }
    }

    function fail(err) { socket.destroy(); reject(err); }
  });
}

module.exports = { sendMail, isConfigured };
