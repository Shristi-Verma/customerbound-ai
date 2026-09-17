/**
 * hxl.js - a thin client for the Salesforce Headless Identity APIs.
 *
 * Every call here goes to the *Experience Cloud site* host (SF_SITE_URL),
 * not to login.salesforce.com and not to the my.salesforce.com instance URL.
 * Headless Identity is a site feature; against the wrong host you get a
 * redirect to a hosted login page, which is exactly what HXL exists to avoid.
 *
 * All four flows land in the same place: an authorization code, exchanged at
 * the token endpoint with the standard grant_type=authorization_code. The
 * headless part is only *how the code is obtained* - Salesforce never renders
 * a page and the user never leaves your front end.
 *
 * Shapes verified against the Salesforce Headless Identity docs:
 *   - Headless Login Flow            (Auth-Request-Type: Named-User)
 *   - Headless Registration Flow     (Auth-Request-Type: user-registration)
 *   - Headless Passwordless Login    (Auth-Request-Type: passwordless-login)
 *   - Headless Forgot Password Flow  (no authorize step - resets in place)
 */

import { createHash, randomBytes } from 'node:crypto';

const cfg = () => ({
  site: (process.env.SF_SITE_URL || '').replace(/\/+$/, ''),
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  redirectUri: process.env.SF_REDIRECT_URI,
  debug: process.env.HXL_DEBUG === '1',
  // Newer orgs refuse to enable the passwordless / forgot-password APIs unless
  // the endpoint is protected by either authentication or reCAPTCHA. With
  // "Require authentication to access this API" ticked, the init endpoints
  // additionally want a client-credentials bearer token.
  // Which init endpoints have "Require authentication to access this API"
  // ticked on the site. Per-flow, because the org enforces it per-flow - and
  // sending a bearer to an endpoint that is not expecting one is itself an
  // "authentication failure". Comma-separated: registration, passwordless,
  // forgot_password.
  initAuthFlows: (process.env.SF_INIT_AUTH_FLOWS || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean),
});

const basic = (a, b) => 'Basic ' + Buffer.from(`${a}:${b}`).toString('base64');

const b64url = (buf) => buf.toString('base64url');

/**
 * PKCE pair. Required when the connected app has "Require Proof Key for Code
 * Exchange" on - which some orgs enforce and do not let you switch off. The
 * verifier stays in this process for the life of one flow; only the S256
 * challenge goes out with the authorize call.
 */
function pkcePair() {
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/**
 * Host for authenticated data calls. Identity happens on the site host, but the
 * site bounces /services/apexrest to its login page - those go to the
 * instance_url that came back with the token.
 */
const apiHost = (instanceUrl) =>
  (instanceUrl || cfg().site).replace(/\/+$/, '');

export class HxlError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Salesforce returns errors as JSON with an `error` key, or as HTML on a misroute. */
async function call(url, init, label, { redirectOk = false } = {}) {
  const { debug } = cfg();
  if (debug) console.log(`\n[hxl] -> ${label}  ${init.method} ${url}`);

  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual' });
  } catch (cause) {
    throw new HxlError(502, `Could not reach ${new URL(url).host}. Check SF_SITE_URL.`, {
      cause: String(cause.cause || cause),
    });
  }
  const text = await res.text();

  let body;
  let isJson = true;
  try {
    body = JSON.parse(text);
  } catch {
    isJson = false;
    body = { raw: text.slice(0, 500) };
  }

  if (debug) console.log(`[hxl] <- ${label}  ${res.status}`, JSON.stringify(body).slice(0, 600));

  // The authorize endpoint answers a successful headless request with a 302
  // whose Location carries the authorization code - that is the happy path, not
  // a bounce to a hosted login page. Callers that expect it opt in.
  if (redirectOk && res.status >= 300 && res.status < 400) {
    return { __location: res.headers.get('location') };
  }
  // Any other 3xx means the site bounced us to a hosted login page: almost
  // always a connected-app or site config problem, not a credential problem.
  if (res.status >= 300 && res.status < 400) {
    throw new HxlError(
      502,
      'Salesforce redirected instead of answering headlessly. Check that the connected app has the Authorization Code and Credentials Flow enabled and that the site allows headless requests.',
      { location: res.headers.get('location') }
    );
  }
  // HTML back from an API endpoint means we never reached Salesforce's API at
  // all - a wrong host, an unpublished site, or an edge/proxy error page.
  if (!isJson) {
    throw new HxlError(
      502,
      `${new URL(url).host} answered with HTML, not JSON (HTTP ${res.status}). The site URL is wrong, the site is not published, or that headless API is not enabled.`,
      body
    );
  }
  if (!res.ok) {
    throw new HxlError(
      res.status,
      body.error_description || body.message || body.error || 'Salesforce rejected the request',
      body
    );
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Client-credentials token for the protected `init` endpoints.
 * ------------------------------------------------------------------ */

let appTokenCache = null; // { token, expiresAt }

/**
 * Fetches (and briefly caches) an app-level access token via the client
 * credentials grant. This is the *app* identifying itself, not a user - it
 * only gates access to the init endpoints. The connected app needs the client
 * credentials flow enabled with a Run As user.
 */
export async function getAppAccessToken() {
  const { site, clientId, clientSecret } = cfg();
  const now = Date.now();
  if (appTokenCache && appTokenCache.expiresAt > now) return appTokenCache.token;

  const res = await call(
    `${site}/services/oauth2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    'client credentials token'
  );
  // No expires_in on this grant in some releases; 10 minutes is well inside any
  // real lifetime and a re-fetch is cheap.
  appTokenCache = { token: res.access_token, expiresAt: now + 10 * 60 * 1000 };
  return appTokenCache.token;
}

/** JSON headers for an init call, with the app bearer token when that flow needs it. */
async function initHeaders(flow) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg().initAuthFlows.includes(flow)) {
    headers.Authorization = `Bearer ${await getAppAccessToken()}`;
  }
  return headers;
}

/**
 * Step common to every flow: trade the authorization code for tokens.
 * Runs on the server so the client secret never reaches the browser.
 */
export async function exchangeCodeForTokens(code, codeVerifier) {
  const { site, clientId, clientSecret, redirectUri } = cfg();
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (clientSecret) form.set('client_secret', clientSecret);
  if (codeVerifier) form.set('code_verifier', codeVerifier);

  return call(
    `${site}/services/oauth2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    },
    'token exchange'
  );
}

/** Shared authorize call. The `authHeaders` are what make each flow different. */
async function authorize(authHeaders, label, codeChallenge) {
  const { site, clientId, redirectUri } = cfg();
  const body = new URLSearchParams({
    response_type: 'code_credentials',
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (codeChallenge) {
    body.set('code_challenge', codeChallenge);
    body.set('code_challenge_method', 'S256');
  }

  const res = await call(
    `${site}/services/oauth2/authorize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders },
      body,
    },
    label,
    { redirectOk: true }
  );

  // Three shapes across releases: a `code` field, a `redirect_uri` string with
  // the code in its query, or a 302 whose Location header carries it.
  const fromUrl = (u) => (u ? new URL(u).searchParams.get('code') : null);
  const code = res.code || fromUrl(res.redirect_uri) || fromUrl(res.__location);
  if (!code) throw new HxlError(502, 'No authorization code in the authorize response', res);
  return code;
}

/* ------------------------------------------------------------------ *
 * 1. Headless Login - username + password, no hosted page
 * ------------------------------------------------------------------ */
export async function login(username, password) {
  const pkce = pkcePair();
  const code = await authorize(
    {
      Authorization: basic(username, password),
      'Auth-Request-Type': 'Named-User',
    },
    'headless login',
    pkce.challenge
  );
  return exchangeCodeForTokens(code, pkce.verifier);
}

/* ------------------------------------------------------------------ *
 * 2. Headless Registration - create the user and log them straight in
 * ------------------------------------------------------------------ */
export async function registerInit({ email, lastName, password, verificationMethod = 'email' }) {
  const { site } = cfg();
  const res = await call(
    `${site}/services/auth/headless/init/registration`,
    {
      method: 'POST',
      headers: await initHeaders('registration'),
      body: JSON.stringify({
        password,
        userdata: { username: email, lastName, email },
        verificationmethod: verificationMethod,
      }),
    },
    'registration init'
  );
  // Salesforce has used both names for this handle across releases.
  return { identifier: res.identifier || res.request_id, raw: res };
}

export async function registerVerify(identifier, otp, verificationMethod = 'email') {
  const pkce = pkcePair();
  const code = await authorize(
    {
      Authorization: basic(identifier, otp),
      'Auth-Request-Type': 'user-registration',
      'Auth-Verification-Type': verificationMethod,
    },
    'registration verify',
    pkce.challenge
  );
  return exchangeCodeForTokens(code, pkce.verifier);
}

/* ------------------------------------------------------------------ *
 * 3. Headless Passwordless Login - OTP to email or SMS, no password at all
 * ------------------------------------------------------------------ */
export async function passwordlessInit(username, verificationMethod = 'email') {
  const { site } = cfg();
  const res = await call(
    `${site}/services/auth/headless/init/passwordless/login`,
    {
      method: 'POST',
      headers: await initHeaders('passwordless'),
      body: JSON.stringify({ username, verificationmethod: verificationMethod }),
    },
    'passwordless init'
  );
  return { identifier: res.identifier || res.request_id, email: res.email, raw: res };
}

export async function passwordlessVerify(identifier, otp, verificationMethod = 'email') {
  const pkce = pkcePair();
  const code = await authorize(
    {
      Authorization: basic(identifier, otp),
      'Auth-Request-Type': 'passwordless-login',
      'Auth-Verification-Type': verificationMethod,
    },
    'passwordless verify',
    pkce.challenge
  );
  return exchangeCodeForTokens(code, pkce.verifier);
}

/* ------------------------------------------------------------------ *
 * 4. Headless Forgot Password - same endpoint twice, no authorize step
 * ------------------------------------------------------------------ */
export async function forgotPasswordInit(username) {
  const { site } = cfg();
  return call(
    `${site}/services/auth/headless/forgot_password`,
    {
      method: 'POST',
      headers: await initHeaders('forgot_password'),
      body: JSON.stringify({ username }),
    },
    'forgot password init'
  );
}

export async function forgotPasswordReset(username, otp, newPassword) {
  const { site } = cfg();
  return call(
    `${site}/services/auth/headless/forgot_password`,
    {
      method: 'POST',
      headers: await initHeaders('forgot_password'),
      body: JSON.stringify({ username, otp, newpassword: newPassword }),
    },
    'forgot password reset'
  );
}

/* ------------------------------------------------------------------ *
 * The data half of HXL: the same access token, used against Apex REST
 * ------------------------------------------------------------------ */
export async function getMyOrders(accessToken, instanceUrl) {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    'GET orders'
  );
}

/**
 * channel is an audit label for the surface the click came from (web, claude,
 * chatgpt, slack, codex). Apex validates it against the picklist; it never
 * affects who the order belongs to - that is still the token.
 */
/**
 * One order by record Id or ORD-number. No owner filter anywhere in the chain:
 * a 404 here is Salesforce sharing refusing the token, which is the point.
 */
export async function getOrder(accessToken, lookup, instanceUrl) {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders/${encodeURIComponent(lookup)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    'GET order ' + lookup
  );
}

/** Unfiltered search: every order the token can see whose number contains q. */
export async function searchOrders(accessToken, q, instanceUrl) {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders?q=${encodeURIComponent(q)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    'SEARCH orders ' + JSON.stringify(q)
  );
}

/** Cancel one of the customer's own orders. 404 if sharing hides it, 409 if not cancellable. */
export async function cancelOrder(accessToken, orderNumber, instanceUrl, channel = 'web') {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-HXL-Channel': channel,
      },
      body: JSON.stringify({ orderNumber }),
    },
    'PATCH cancel ' + orderNumber
  );
}

/** Staff-only state transition. Salesforce custom permission and sharing enforce access. */
export async function staffOrderAction(accessToken, orderNumber, action, staffNote, instanceUrl, channel = 'web') {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-HXL-Channel': channel,
      },
      body: JSON.stringify({ orderNumber, action, staffNote }),
    },
    `PATCH staff ${action} ${orderNumber}`
  );
}

export async function createOrder(accessToken, totalAmount, instanceUrl, channel = 'web') {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/apexrest/hxl/orders`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalAmount, channel }),
    },
    'POST order'
  );
}

export async function userinfo(accessToken, instanceUrl) {
  const host = apiHost(instanceUrl);
  return call(
    `${host}/services/oauth2/userinfo`,
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    'userinfo'
  );
}
