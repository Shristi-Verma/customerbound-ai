#!/usr/bin/env node
/**
 * HXL Order Card - an MCP app that renders the hxlOrderCard widget in Claude,
 * ChatGPT or Slackbot, and the seam between the two projects in this folder.
 *
 * Track B (this repo) answers "where does the UI show up".
 * Track A (../../hxl-demo) answers "who is asking".
 *
 * The interesting part is the bridge: this server does NOT hold an integration
 * user's credentials and it does NOT query Salesforce directly. It signs in
 * through the Headless Identity BFF as a *named customer*, and reads back only
 * what Salesforce sharing lets that Contact see. The Apex on the other end
 * reads the Contact off the token and never accepts a user id from the caller,
 * so a prompt-injected agent cannot widen the blast radius by asking nicely.
 *
 * Identity is held PER MCP SESSION, not per process. A chat session signs in
 * with the `sign_in` tool and from then on every tool call in that session
 * carries that one customer's BFF cookie. Two chats, two people, one server.
 *
 * Transports:
 *   node server.mjs          stdio, for Claude Desktop (one session per process)
 *   node server-http.mjs     Streamable HTTP, for ChatGPT and Slackbot (many sessions)
 *
 * With no BFF reachable it falls back to sample data, clearly labelled as such,
 * so the widget still demos on a laptop with no org.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = 'ui://widgets/hxl-order-card.html';

/**
 * Load ../.env if present, without taking a dependency on dotenv.
 * Claude Desktop passes env explicitly in its config, but `npm run demo` and a
 * bare `node mcp/server.mjs` have nothing to inherit from - without this they
 * silently fall back to sample data, which looks like a broken bridge.
 * Real environment variables always win over the file.
 */
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
      return;
    }
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      const value = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env - fine, the card falls back to sample data and says so */
  }
}
loadDotEnv();

const BFF = (process.env.HXL_BFF_URL || 'http://localhost:3000').replace(/\/+$/, '');
const DEMO_USER = process.env.HXL_DEMO_USER;
const DEMO_PASSWORD = process.env.HXL_DEMO_PASSWORD;

/** Shown when no BFF is reachable. Labelled in the card so it is never mistaken for live data. */
const SAMPLE = {
  customerName: 'Ada Lovelace',
  email: 'ada@example.com',
  contactId: '(sample - no live token)',
  orderCount: 3,
  totalValue: '$443.49 across 3 orders',
  latestOrderNumber: 'ORD-00009',
  latestOrderStatus: 'Submitted',
  latestOrderAmount: '$49.99',
  latestOrderPlaced: '6 Sep 14:11',
  identityMode: 'sample data',
  isLiveIdentity: false,
  scopeNote: '',
};

/** Shown on a hosted transport before the session has signed in. */
const NOT_SIGNED_IN = {
  customerName: 'Not signed in',
  email: '',
  contactId: '—',
  orderCount: 0,
  totalValue: '—',
  latestOrderNumber: '—',
  latestOrderStatus: '—',
  latestOrderAmount: '—',
  latestOrderPlaced: '—',
  identityMode: 'not signed in',
  isLiveIdentity: false,
  scopeNote: '',
};

const money = (n) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
};

/* ------------------------------------------------------------------ *
 * Per-session identity.
 *
 * Keyed by the MCP session id the transport hands each tool call. stdio has
 * no session id, so it gets one fixed key - one Claude Desktop server entry
 * is one session, which is exactly the local two-config-entries model.
 *
 * A session holds only the BFF's HttpOnly cookie, never the password and
 * never the Salesforce token. The BFF holds the token; Salesforce holds the
 * sharing rules. If the cookie expires the session drops back to
 * "not signed in" rather than silently reusing anything.
 * ------------------------------------------------------------------ */
const STDIO_KEY = 'stdio';
/** @type {Map<string, {cookie: string, username: string, contactId?: string, channel: string, signedInAt: string}>} */
const sessions = new Map();
/** Channel label per session, set by the transport (stdio -> claude; HTTP -> path). */
const channels = new Map();

const sessionKey = (extra) => extra?.sessionId || STDIO_KEY;

/**
 * Whether a session with no explicit sign-in may fall back to the env-var
 * demo customer. Always on for stdio (Claude Desktop, one laptop, one
 * person). Off for HTTP unless HXL_ALLOW_ENV_IDENTITY=1 is set on purpose -
 * on a public URL that fallback would show one customer to everyone.
 */
function envIdentityAllowed(key) {
  if (key === STDIO_KEY) return true;
  return process.env.HXL_ALLOW_ENV_IDENTITY === '1';
}

export function setSessionChannel(sessionId, channel) {
  channels.set(sessionId || STDIO_KEY, channel);
}

export function dropSession(sessionId) {
  sessions.delete(sessionId || STDIO_KEY);
  channels.delete(sessionId || STDIO_KEY);
}

/** For verification (Step 3.0 target): who is signed in, per session. No cookies. */
export function listSessions() {
  return [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    username: s.username,
    contactId: s.contactId || null,
    channel: s.channel,
    signedInAt: s.signedInAt,
  }));
}

/* ------------------------------------------------------------------ *
 * Track A bridge
 * ------------------------------------------------------------------ */

/**
 * One retry, because the site domain intermittently fails to resolve and the
 * BFF surfaces that as a 502. Observed live: a failed login followed
 * immediately by a clean one. Without the retry a demo shows "sample data"
 * for no reason the room can see.
 */
async function bffLogin(username, password, channel, attempt = 0) {
  const login = await fetch(`${BFF}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-HXL-Channel': channel },
    body: JSON.stringify({ username, password }),
  });
  if (login.status === 502 && attempt === 0) {
    await new Promise((r) => setTimeout(r, 400));
    return bffLogin(username, password, channel, 1);
  }
  if (!login.ok) throw new Error(`BFF login failed (${login.status})`);

  // The BFF hands back an HttpOnly session cookie; the token itself never leaves it.
  const cookie = (login.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('BFF returned no session cookie');
  return cookie;
}

async function fetchMe(cookie, channel) {
  const meRes = await fetch(`${BFF}/api/me`, {
    headers: { Cookie: cookie, 'X-HXL-Channel': channel },
  });
  if (meRes.status === 401) throw new SessionExpired();
  if (!meRes.ok) throw new Error(`BFF /api/me failed (${meRes.status})`);
  return meRes.json();
}

class SessionExpired extends Error {
  constructor() {
    super('session expired - sign in again');
  }
}

/**
 * Resolve the identity for this tool call:
 *   1. the session's own sign-in, if any
 *   2. the env-var demo customer, where that is allowed (stdio only, by default)
 *   3. nothing - caller shows NOT_SIGNED_IN
 * Returns { cookie, channel } or null.
 */
async function identityFor(extra) {
  const key = sessionKey(extra);
  const channel = channels.get(key) || (key === STDIO_KEY ? 'claude' : 'http');
  const s = sessions.get(key);
  if (s) return { cookie: s.cookie, channel: s.channel, key };
  if (envIdentityAllowed(key) && DEMO_USER && DEMO_PASSWORD) {
    const cookie = await bffLogin(DEMO_USER, DEMO_PASSWORD, channel);
    sessions.set(key, {
      cookie,
      username: DEMO_USER,
      channel,
      signedInAt: new Date().toISOString(),
    });
    return { cookie, channel, key };
  }
  return null;
}

function buildPayload(me) {
  const orders = me.orders || [];
  const total = orders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
  const latest = orders[0];

  return {
    customerName: me.name || 'Signed-in customer',
    email: me.email || '',
    contactId: me.contactId || '(no Contact on this token)',
    orderCount: orders.length,
    totalValue: `${money(total)} across ${orders.length} order${orders.length === 1 ? '' : 's'}`,
    latestOrderNumber: latest?.orderNumber || '—',
    latestOrderStatus: latest?.status || '—',
    latestOrderAmount: latest ? money(latest.totalAmount) : '—',
    latestOrderPlaced: shortDate(latest?.placedOn),
    identityMode: 'named user',
    isLiveIdentity: true,
    scopeNote:
      `Apex read Contact ${me.contactId} off the access token. No user id was passed by this ` +
      `server or by the model. Orders belonging to any other Contact are not in this response.`,
  };
}

/** Card payload for the current session, with the fallbacks the card knows how to label. */
async function cardFor(extra) {
  const key = sessionKey(extra);
  let id;
  try {
    id = await identityFor(extra);
  } catch (err) {
    // A dead BFF must not fail the tool call - degrade to sample, and say so.
    return { ...SAMPLE, identityMode: `sample data (${err.message})` };
  }
  if (!id) {
    return {
      ...NOT_SIGNED_IN,
      scopeNote: 'Call sign_in with your customer username and password to see your orders.',
    };
  }
  try {
    const me = await fetchMe(id.cookie, id.channel);
    const s = sessions.get(key);
    if (s && !s.contactId) s.contactId = me.contactId;
    return buildPayload(me);
  } catch (err) {
    if (err instanceof SessionExpired) {
      sessions.delete(key);
      return { ...NOT_SIGNED_IN, identityMode: 'session expired', scopeNote: 'Sign in again.' };
    }
    return { ...SAMPLE, identityMode: `sample data (${err.message})` };
  }
}

/* ------------------------------------------------------------------ *
 * The ext-apps runtime is inlined into the widget HTML. Hosts render the
 * widget in a sandboxed iframe with no network access, so a CDN <script>
 * would silently never load.
 * ------------------------------------------------------------------ */
const bundle = readFileSync(
  require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'),
  'utf8'
).replace(/export\{([^}]+)\};?\s*$/, (_, body) =>
  'globalThis.ExtApps={' +
  body
    .split(',')
    .map((pair) => {
      const [local, exported] = pair.split(' as ').map((s) => s.trim());
      return `${exported ?? local}:${local}`;
    })
    .join(',') +
  '};'
);

const widgetHtml = readFileSync(
  path.join(__dirname, 'widgets', 'hxl-order-card.html'),
  'utf8'
).replace('/*__EXT_APPS_BUNDLE__*/', () => bundle);

const CARD_META = { ui: { resourceUri: WIDGET_URI }, 'ui/resourceUri': WIDGET_URI };

export function createServer() {
  const server = new McpServer(
    { name: 'hxl-order-card', version: '1.1.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } },
      },
    }
  );

  registerAppResource(
    server,
    'HXL Order Card',
    WIDGET_URI,
    {
      title: 'HXL Order Card',
      description: 'A customer order card, scoped by Salesforce sharing',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    })
  );

  registerAppTool(
    server,
    'sign_in',
    {
      title: 'Sign In',
      description:
        'Sign this chat session in as a Salesforce customer through the Headless Identity layer. ' +
        'The server keeps only a session cookie for this chat; the Salesforce token stays in the ' +
        'identity layer. Every later call in this chat acts as this customer and sees only what ' +
        'Salesforce sharing lets them see. Returns the customer\'s order card.',
      inputSchema: {
        username: z.string().min(1).describe('Customer username (Experience Cloud site login)'),
        password: z.string().min(1).describe('Customer password'),
      },
      annotations: { readOnlyHint: false, title: 'Sign In' },
      _meta: CARD_META,
    },
    async ({ username, password }, extra) => {
      const key = sessionKey(extra);
      const channel = channels.get(key) || (key === STDIO_KEY ? 'claude' : 'http');
      try {
        const cookie = await bffLogin(username, password, channel);
        sessions.set(key, { cookie, username, channel, signedInAt: new Date().toISOString() });
        // Read the identity back with one retry - the site's intermittent DNS blip
        // shows up here as a 502 on /api/me, and reporting "(sample)" right after a
        // successful login is confusing on stage.
        let payload = await cardFor(extra);
        if (!payload.isLiveIdentity) {
          await new Promise((r) => setTimeout(r, 400));
          payload = await cardFor(extra);
        }
        const who = payload.isLiveIdentity
          ? `${payload.customerName} (Contact ${payload.contactId})`
          : `${username} (identity layer reachable, orders temporarily unavailable: ${payload.identityMode})`;
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload) },
            { type: 'text', text: `Signed in as ${who} on channel "${channel}".` },
          ],
        };
      } catch (err) {
        sessions.delete(key);
        return {
          isError: true,
          content: [{ type: 'text', text: `Sign-in failed: ${err.message}` }],
        };
      }
    }
  );

  server.registerTool(
    'sign_out',
    {
      title: 'Sign Out',
      description: 'Forget this chat session\'s customer identity.',
      inputSchema: {},
      annotations: { readOnlyHint: false, title: 'Sign Out' },
    },
    async (_args, extra) => {
      const key = sessionKey(extra);
      const had = sessions.get(key);
      sessions.delete(key);
      return {
        content: [
          { type: 'text', text: had ? `Signed out ${had.username}.` : 'This session was not signed in.' },
        ],
      };
    }
  );

  server.registerTool(
    'whoami',
    {
      title: 'Who Am I',
      description:
        'Report which customer this chat session is acting as, and through which channel. ' +
        'Never returns a token or a cookie.',
      inputSchema: {},
      annotations: { readOnlyHint: true, title: 'Who Am I' },
    },
    async (_args, extra) => {
      const key = sessionKey(extra);
      const s = sessions.get(key);
      const channel = channels.get(key) || (key === STDIO_KEY ? 'claude' : 'http');
      const info = s
        ? { signedIn: true, username: s.username, contactId: s.contactId || null, channel, since: s.signedInAt }
        : { signedIn: false, channel, envIdentityAllowed: envIdentityAllowed(key) && !!DEMO_USER };
      return { content: [{ type: 'text', text: JSON.stringify(info) }] };
    }
  );

  registerAppTool(
    server,
    'get_my_orders',
    {
      title: 'My Orders',
      description:
        'Open the interactive HXL Order Card for the signed-in Salesforce customer. Shows their ' +
        'own orders only, scoped by Salesforce sharing to the Contact behind the access token. ' +
        'Use when the user asks to see their orders, or to demo the Headless Experience Layer.',
      inputSchema: {},
      annotations: { readOnlyHint: true, title: 'My Orders' },
      _meta: CARD_META,
    },
    async (_args, extra) => {
      const payload = await cardFor(extra);
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get Order',
      description:
        'Look up ONE order by its record Id or ORD-number, as the signed-in customer. There is ' +
        'no owner filter anywhere in this call: the request goes to Salesforce with the ' +
        "customer's own token and Salesforce sharing decides. An order that belongs to another " +
        'customer comes back as not found - refused by the platform, not by this server. Use ' +
        'this when the user asks about a specific order number, including one that may not be theirs.',
      inputSchema: {
        lookup: z
          .string()
          .min(1)
          .max(40)
          .describe('Order number like ORD-00003, or an 18-character Salesforce record Id'),
      },
      annotations: { readOnlyHint: true, title: 'Get Order' },
    },
    async ({ lookup }, extra) => {
      try {
        const id = await identityFor(extra);
        if (!id) throw new Error('not signed in - call sign_in first');
        const res = await fetch(`${BFF}/api/orders/${encodeURIComponent(lookup)}`, {
          headers: { Cookie: id.cookie, 'X-HXL-Channel': id.channel },
        });
        if (res.status === 401) {
          sessions.delete(id.key);
          throw new SessionExpired();
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 404 || body.found === false) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  lookup,
                  found: false,
                  askedAs: sessions.get(id.key)?.username || null,
                  reason:
                    'Salesforce returned no record for this token. Either it does not exist or it ' +
                    'belongs to another customer - sharing does not distinguish the two, by design.',
                }),
              },
            ],
          };
        }
        if (!res.ok) throw new Error(body.error || `BFF /api/orders/${lookup} failed (${res.status})`);
        const o = body.orders?.[0];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                lookup,
                found: true,
                order: {
                  orderNumber: o.orderNumber,
                  status: o.status,
                  totalAmount: money(o.totalAmount),
                  placedOn: shortDate(o.placedOn),
                  channel: o.channel || null,
                },
                owner: body.contactId,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Could not look up ${lookup}: ${err.message}` }],
        };
      }
    }
  );

  server.registerTool(
    'search_orders',
    {
      title: 'Search Orders',
      description:
        'Search orders by order number, or list every order visible with an empty query. ' +
        'This tool applies NO owner filter: it asks Salesforce for all matching orders and ' +
        'Salesforce sharing decides which come back. Use it when the user asks to search, to ' +
        "list all orders, or to see other customers' orders - the platform, not this server, " +
        'limits the answer to the signed-in customer.',
      inputSchema: {
        query: z.string().max(40).default('').describe('Text the order number must contain. Empty = everything visible.'),
      },
      annotations: { readOnlyHint: true, title: 'Search Orders' },
    },
    async ({ query }, extra) => {
      try {
        const id = await identityFor(extra);
        if (!id) throw new Error('not signed in - call sign_in first');
        const res = await fetch(`${BFF}/api/orders/search?q=${encodeURIComponent(query || '')}`, {
          headers: { Cookie: id.cookie, 'X-HXL-Channel': id.channel },
        });
        if (res.status === 401) {
          sessions.delete(id.key);
          throw new SessionExpired();
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `search failed (${res.status})`);
        const orders = (body.orders || []).map((o) => ({
          orderNumber: o.orderNumber,
          status: o.status,
          totalAmount: money(o.totalAmount),
          placedOn: shortDate(o.placedOn),
          channel: o.channel || null,
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query: query || '',
                ownerFilterApplied: false,
                visibleTo: sessions.get(id.key)?.username || null,
                contactId: body.contactId,
                count: orders.length,
                orders,
                note:
                  'No owner filter was applied by this server or the identity layer. Every order ' +
                  'Salesforce sharing lets this token see is listed; nothing else exists from ' +
                  "this token's point of view.",
              }),
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Search failed: ${err.message}` }] };
      }
    }
  );

  registerAppTool(
    server,
    'cancel_order',
    {
      title: 'Cancel Order',
      description:
        "Cancel one of the signed-in customer's orders by order number and return the refreshed " +
        'card. Only Draft or Submitted orders can be cancelled; Shipped ones are refused. An order ' +
        'belonging to another customer is not found - Salesforce sharing hides it before any rule runs.',
      inputSchema: {
        orderNumber: z.string().min(1).max(40).describe('Order number like ORD-00015'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, title: 'Cancel Order' },
      _meta: CARD_META,
    },
    async ({ orderNumber }, extra) => {
      try {
        const id = await identityFor(extra);
        if (!id) throw new Error('not signed in - call sign_in first');
        const res = await fetch(`${BFF}/api/orders/${encodeURIComponent(orderNumber)}/cancel`, {
          method: 'POST',
          headers: { Cookie: id.cookie, 'X-HXL-Channel': id.channel },
        });
        if (res.status === 401) {
          sessions.delete(id.key);
          throw new SessionExpired();
        }
        const body = await res.json().catch(() => ({}));
        let note;
        if (res.status === 404) {
          note = `${orderNumber} is not visible to this customer's token - it does not exist or belongs to someone else. Nothing was changed.`;
        } else if (res.status === 409) {
          note = `${orderNumber} is ${body.detail?.status || 'not cancellable'} and cannot be cancelled. Nothing was changed.`;
        } else if (!res.ok) {
          throw new Error(body.error || `cancel failed (${res.status})`);
        } else {
          note = `${body.orderNumber} is now ${body.status} (cancelled as ${sessions.get(id.key)?.username} via ${id.channel}).`;
        }
        const payload = await cardFor(extra);
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload) },
            { type: 'text', text: note },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Could not cancel ${orderNumber}: ${err.message}` }],
        };
      }
    }
  );

  registerAppTool(
    server,
    'place_order',
    {
      title: 'Place Order',
      description:
        'Create a new order for the signed-in Salesforce customer and return the refreshed order ' +
        'card. The order is written as that named user, so Salesforce records them as the owner.',
      inputSchema: {
        amount: z
          .number()
          .positive()
          .optional()
          .describe('Order amount. Defaults to 49.99.'),
      },
      annotations: { readOnlyHint: false, title: 'Place Order' },
      _meta: CARD_META,
    },
    async ({ amount }, extra) => {
      try {
        const id = await identityFor(extra);
        if (!id) throw new Error('not signed in - call sign_in first');
        const res = await fetch(`${BFF}/api/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: id.cookie,
            'X-HXL-Channel': id.channel,
          },
          body: JSON.stringify({ totalAmount: Number(amount) || 49.99 }),
        });
        if (res.status === 401) {
          sessions.delete(id.key);
          throw new SessionExpired();
        }
        if (!res.ok) throw new Error(`BFF /api/orders failed (${res.status})`);
        const created = await res.json();
        const payload = await cardFor(extra);
        // The widget re-renders from this payload; the note is for the model's reply.
        return {
          content: [
            { type: 'text', text: JSON.stringify(payload) },
            {
              type: 'text',
              text: `Created ${created.orderNumber} for ${created.totalAmount} as ${payload.customerName} via ${id.channel}.`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Could not place the order: ${err.message}` }],
        };
      }
    }
  );

  return server;
}

/* stdio entry point - only when run directly, so server-http.mjs can import createServer(). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setSessionChannel(undefined, process.env.HXL_CHANNEL || 'claude');
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
