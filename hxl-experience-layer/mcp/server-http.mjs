#!/usr/bin/env node
/**
 * HXL Order Card over Streamable HTTP - the entry point for hosts that cannot
 * launch a local process: ChatGPT (Developer Mode connector) and Slackbot
 * (MCP App). Same createServer() as the stdio path; only the transport differs.
 *
 * Endpoints (all speak MCP Streamable HTTP: POST for messages, GET for the
 * event stream, DELETE to end a session):
 *
 *   /mcp             channel label "http"
 *   /mcp/chatgpt     channel label "chatgpt"   <- give this URL to ChatGPT
 *   /mcp/slack       channel label "slack"     <- give this URL to Slackbot
 *   /healthz         200 text, for the tunnel check
 *   /sessions        who is signed in per session (no cookies) - Step 3.0 target
 *
 * The path is the only thing that tells the audit trail which host a click
 * came from, so register each host against its own path.
 *
 * One McpServer + one transport per MCP session; identity lives per session in
 * server.mjs. HXL_DEMO_USER is NOT used on this transport unless
 * HXL_ALLOW_ENV_IDENTITY=1 is set on purpose - on a public URL that would show
 * one customer to every user of every host.
 *
 * Expose it with a tunnel for the POC:
 *   cloudflared tunnel --url http://localhost:8787
 *   ngrok http 8787
 */
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, setSessionChannel, dropSession, listSessions } from './server.mjs';

const PORT = Number(process.env.HXL_MCP_PORT || 8787);
const HOST = process.env.HXL_MCP_HOST || '0.0.0.0';

/** @type {Map<string, {transport: StreamableHTTPServerTransport, channel: string}>} */
const transports = new Map();

const CHANNEL_BY_PATH = {
  '/mcp': 'http',
  '/mcp/chatgpt': 'chatgpt',
  '/mcp/slack': 'slack',
  '/mcp/claude': 'claude', // Claude.ai / Claude Desktop "custom connector" over HTTP, if used
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function handleMcp(req, res, channel) {
  const sid = req.headers['mcp-session-id'];

  // Existing session: route to its transport.
  if (sid && transports.has(sid)) {
    return transports.get(sid).transport.handleRequest(req, res);
  }

  // A GET/DELETE without a known session is a protocol error.
  if (req.method !== 'POST') {
    return send(res, sid ? 404 : 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: sid ? 'Unknown session' : 'Missing Mcp-Session-Id' },
      id: null,
    });
  }

  // New session: first POST is `initialize`. The transport validates that.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, { transport, channel });
      setSessionChannel(id, channel);
      console.error(`[mcp] session ${id.slice(0, 8)} opened via ${channel}`);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (!id) return;
    transports.delete(id);
    dropSession(id);
    console.error(`[mcp] session ${id.slice(0, 8)} closed`);
  };

  await createServer().connect(transport);
  return transport.handleRequest(req, res);
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/sessions') return send(res, 200, listSessions());
    if (p in CHANNEL_BY_PATH) return await handleMcp(req, res, CHANNEL_BY_PATH[p]);
    return send(res, 404, { error: 'not found', paths: Object.keys(CHANNEL_BY_PATH) });
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

http.listen(PORT, HOST, () => {
  console.error(`HXL Order Card MCP (Streamable HTTP) on http://localhost:${PORT}`);
  for (const [path, channel] of Object.entries(CHANNEL_BY_PATH)) {
    console.error(`  ${path.padEnd(14)} -> channel "${channel}"`);
  }
  console.error(
    process.env.HXL_ALLOW_ENV_IDENTITY === '1'
      ? '  env identity: ALLOWED - every unsigned session acts as HXL_DEMO_USER. Demo only.'
      : '  env identity: off - sessions must call sign_in.'
  );
});

// Let a Ctrl+C close sessions cleanly so hosts see the stream end.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const { transport } of transports.values()) {
      try { await transport.close(); } catch { /* already gone */ }
    }
    process.exit(0);
  });
}
