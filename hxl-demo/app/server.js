/**
 * server.js - the "L" in Headless Experience Layer.
 *
 * A backend-for-frontend. The browser talks only to this process; this process
 * is the only thing that holds the client secret and the Salesforce tokens.
 * That is the whole security argument for HXL as a *layer* rather than a
 * browser calling Salesforce directly:
 *
 *   browser  --(session cookie)-->  HXL BFF  --(OAuth + Bearer)-->  Salesforce
 *
 * Tokens live in a Map here. For a demo that is the point - you can print the
 * session table on stage. For production this is Redis and the cookie is
 * Secure + SameSite=Lax over HTTPS.
 */

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import * as hxl from './hxl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

/* ------------------------------------------------------------------ *
 * Sessions - server-side token custody
 * ------------------------------------------------------------------ */
const sessions = new Map(); // sid -> { tokens, pending, createdAt }
const SESSION_TTL_MS = 60 * 60 * 1000;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function session(req, res) {
  let sid = readCookie(req, 'hxl_sid');
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, { tokens: null, pending: null, createdAt: Date.now() });
    // Secure would be added here behind TLS; localhost demo runs plain http.
    res.setHeader('Set-Cookie', `hxl_sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
  }
  return sessions.get(sid);
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, s] of sessions) if (s.createdAt < cutoff) sessions.delete(sid);
}, 60_000).unref();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Wraps a handler so HxlError surfaces as a clean JSON error to the UI. */
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    console.error(`[hxl] ${req.method} ${req.path} failed (${status}):`, err.message);
    res.status(status).json({ error: err.message, detail: err.detail ?? null });
  }
};

/** Never let tokens cross to the browser - only the fact that we hold them. */
function tokenSummary(tokens) {
  if (!tokens) return null;
  return {
    tokenType: tokens.token_type,
    scope: tokens.scope,
    hasRefreshToken: Boolean(tokens.refresh_token),
    hasIdToken: Boolean(tokens.id_token),
    instanceUrl: tokens.instance_url,
    communityUrl: tokens.sfdc_community_url,
    accessTokenPreview: tokens.access_token
      ? `${tokens.access_token.slice(0, 12)}...${tokens.access_token.slice(-6)}`
      : null,
  };
}

function requireTokens(s) {
  if (!s.tokens?.access_token) {
    const e = new hxl.HxlError(401, 'Not signed in');
    throw e;
  }
  return s.tokens.access_token;
}

/* ------------------------------------------------------------------ *
 * Config banner
 * ------------------------------------------------------------------ */
app.get(
  '/api/config',
  route(async (req, res) => {
    const missing = ['SF_SITE_URL', 'SF_CLIENT_ID', 'SF_REDIRECT_URI'].filter(
      (k) => !process.env[k] || process.env[k].includes('YOURDOMAIN')
    );
    res.json({
      siteUrl: process.env.SF_SITE_URL || null,
      clientIdPreview: process.env.SF_CLIENT_ID
        ? `${process.env.SF_CLIENT_ID.slice(0, 10)}...`
        : null,
      redirectUri: process.env.SF_REDIRECT_URI || null,
      configured: missing.length === 0,
      missing,
    });
  })
);

/* ------------------------------------------------------------------ *
 * Flow 1: Headless Login
 * ------------------------------------------------------------------ */
app.post(
  '/api/login',
  route(async (req, res) => {
    const s = session(req, res);
    const { username, password } = req.body;
    if (!username || !password) throw new hxl.HxlError(400, 'username and password are required');

    s.tokens = await hxl.login(username, password);
    res.json({ ok: true, flow: 'headless-login', tokens: tokenSummary(s.tokens) });
  })
);

/* ------------------------------------------------------------------ *
 * Flow 2: Headless Registration
 * ------------------------------------------------------------------ */
app.post(
  '/api/register/init',
  route(async (req, res) => {
    const s = session(req, res);
    const { email, lastName, password } = req.body;
    if (!email || !lastName || !password)
      throw new hxl.HxlError(400, 'email, lastName and password are required');

    const { identifier } = await hxl.registerInit({ email, lastName, password });
    s.pending = { kind: 'registration', identifier };
    res.json({ ok: true, otpSentTo: email, identifierPreview: `${String(identifier).slice(0, 8)}...` });
  })
);

app.post(
  '/api/register/verify',
  route(async (req, res) => {
    const s = session(req, res);
    if (s.pending?.kind !== 'registration')
      throw new hxl.HxlError(409, 'Start the registration flow first');
    const { otp } = req.body;
    if (!otp) throw new hxl.HxlError(400, 'otp is required');

    s.tokens = await hxl.registerVerify(s.pending.identifier, otp);
    s.pending = null;
    res.json({ ok: true, flow: 'headless-registration', tokens: tokenSummary(s.tokens) });
  })
);

/* ------------------------------------------------------------------ *
 * Flow 3: Headless Passwordless Login
 * ------------------------------------------------------------------ */
app.post(
  '/api/passwordless/init',
  route(async (req, res) => {
    const s = session(req, res);
    const { username } = req.body;
    if (!username) throw new hxl.HxlError(400, 'username is required');

    const { identifier, email } = await hxl.passwordlessInit(username);
    s.pending = { kind: 'passwordless', identifier };
    res.json({ ok: true, otpSentTo: email || username });
  })
);

app.post(
  '/api/passwordless/verify',
  route(async (req, res) => {
    const s = session(req, res);
    if (s.pending?.kind !== 'passwordless')
      throw new hxl.HxlError(409, 'Start the passwordless flow first');
    const { otp } = req.body;
    if (!otp) throw new hxl.HxlError(400, 'otp is required');

    s.tokens = await hxl.passwordlessVerify(s.pending.identifier, otp);
    s.pending = null;
    res.json({ ok: true, flow: 'headless-passwordless', tokens: tokenSummary(s.tokens) });
  })
);

/* ------------------------------------------------------------------ *
 * Flow 4: Headless Forgot Password
 * ------------------------------------------------------------------ */
app.post(
  '/api/forgot/init',
  route(async (req, res) => {
    const { username } = req.body;
    if (!username) throw new hxl.HxlError(400, 'username is required');
    const out = await hxl.forgotPasswordInit(username);
    res.json({ ok: true, status: out.status_code || out.status });
  })
);

app.post(
  '/api/forgot/reset',
  route(async (req, res) => {
    const { username, otp, newPassword } = req.body;
    if (!username || !otp || !newPassword)
      throw new hxl.HxlError(400, 'username, otp and newPassword are required');
    const out = await hxl.forgotPasswordReset(username, otp, newPassword);
    res.json({ ok: true, status: out.status_code || out.status });
  })
);

/* ------------------------------------------------------------------ *
 * The data half: same token, real Salesforce records
 * ------------------------------------------------------------------ */
app.get(
  '/api/me',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const inst = s.tokens.instance_url;
    const [profile, orders] = await Promise.all([
      hxl.userinfo(token, inst).catch(() => null),
      hxl.getMyOrders(token, inst),
    ]);
    res.json({ profile, ...orders, tokens: tokenSummary(s.tokens) });
  })
);

app.get(
  '/api/orders/search',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    // Deliberately no owner filter anywhere below this line. Sharing decides.
    const q = String(req.query.q ?? '').slice(0, 40);
    res.json(await hxl.searchOrders(token, q, s.tokens.instance_url));
  })
);

app.post(
  '/api/orders/:lookup/cancel',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const lookup = String(req.params.lookup || '').slice(0, 40);
    const channel = String(req.headers['x-hxl-channel'] || 'web').toLowerCase().slice(0, 32);
    res.json(await hxl.cancelOrder(token, lookup, s.tokens.instance_url, channel));
  })
);

app.post(
  '/api/orders/:lookup/staff-action',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const lookup = String(req.params.lookup || '').slice(0, 40);
    const action = String(req.body.action || '').toLowerCase();
    const staffNote = String(req.body.staffNote || '').slice(0, 1000);
    if (!['request_info', 'approve', 'supervisor_approve', 'fulfill'].includes(action))
      throw new hxl.HxlError(400, 'unsupported staff action');
    const channel = String(req.headers['x-hxl-channel'] || 'web').toLowerCase().slice(0, 32);
    res.json(await hxl.staffOrderAction(token, lookup, action, staffNote, s.tokens.instance_url, channel));
  })
);

app.post(
  '/api/orders/:lookup/respond',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const lookup = String(req.params.lookup || '').slice(0, 40);
    const customerMessage = String(req.body.customerMessage || '').trim().slice(0, 1000);
    if (!customerMessage) throw new hxl.HxlError(400, 'customerMessage is required');
    const channel = String(req.headers['x-hxl-channel'] || 'web').toLowerCase().slice(0, 32);
    res.json(await hxl.respondToInformation(token, lookup, customerMessage, s.tokens.instance_url, channel));
  })
);

app.get(
  '/api/orders/:lookup',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const lookup = String(req.params.lookup || '').slice(0, 40);
    if (!lookup) throw new hxl.HxlError(400, 'order id or number required');
    // Salesforce answers 404 when sharing hides the record; call() rethrows
    // that status, so the caller sees exactly what the platform said.
    res.json(await hxl.getOrder(token, lookup, s.tokens.instance_url));
  })
);

app.post(
  '/api/orders',
  route(async (req, res) => {
    const s = session(req, res);
    const token = requireTokens(s);
    const amount = Number(req.body.totalAmount);
    if (!Number.isFinite(amount) || amount <= 0)
      throw new hxl.HxlError(400, 'totalAmount must be a positive number');
    // Audit label only. The MCP server sets it per host (claude/chatgpt/slack);
    // the web app sends nothing and gets 'web'. Apex maps anything else to 'other'.
    const channel = String(req.headers['x-hxl-channel'] || 'web').toLowerCase().slice(0, 32);
    res.status(201).json(await hxl.createOrder(token, amount, s.tokens.instance_url, channel));
  })
);

app.post(
  '/api/logout',
  route(async (req, res) => {
    const sid = readCookie(req, 'hxl_sid');
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'hxl_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    res.json({ ok: true });
  })
);

/**
 * Registered as the connected app callback URL. The headless flows hand the
 * code back in the authorize *response body*, so nothing actually lands here -
 * but the URL still has to be registered, and a real page beats a 404 if a
 * misconfigured flow falls back to a browser redirect.
 */
app.get('/callback', (req, res) => {
  res.type('html').send(
    `<pre>HXL callback reached with: ${JSON.stringify(req.query, null, 2)}
If you are seeing this during a demo, a flow fell back to a browser redirect -
check the connected app's "Authorization Code and Credentials Flow" setting.</pre>`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n  HXL demo on http://localhost:${port}`);
  console.log(`  Salesforce site: ${process.env.SF_SITE_URL || '(not configured - copy .env.example to .env)'}\n`);
});
