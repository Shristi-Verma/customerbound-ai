#!/usr/bin/env node
/**
 * Renders the widget locally, with real data, without an MCP host.
 *
 * Claude Desktop is the eventual target, but it is a heavy dependency to put in
 * front of "does my card work". This stands in for a host: it starts the MCP
 * server, serves the widget over http://localhost, and forwards the widget's
 * callServerTool() straight through to the server's tools. So the buttons work
 * here exactly as they would in a real host.
 *
 *   npm run preview     # start, print the URL
 *   npm run demo        # ...and open the browser
 *
 * What this proves: the tool contract, the live Track A data, the card markup,
 * and the round trip when you click. What it does NOT prove: that a real host
 * renders it. Only Claude Desktop, Agentforce or Slack can prove that.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = Number(process.env.PREVIEW_PORT || 4321);

/* ------------------------------------------------------------------ *
 * Talk to the MCP server exactly as a host would
 * ------------------------------------------------------------------ */
const child = spawn(process.execPath, [path.join(root, 'mcp', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    } catch { /* not a json line */ }
  }
});

let id = 0;
const rpc = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    waiters.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'hxl-preview', version: '1.0.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const first = await rpc('tools/call', { name: 'get_my_orders', arguments: {} });
const payload = JSON.parse(first.result.content[0].text);
console.log('payload from the MCP tool:');
console.log(JSON.stringify(payload, null, 2));

/* ------------------------------------------------------------------ *
 * Stand in for the host: serve the widget, forward its tool calls
 * ------------------------------------------------------------------ */
const stub = `
globalThis.ExtApps = {
  App: class {
    constructor() { this._handler = null; }
    set ontoolresult(fn) { this._handler = fn; }
    get ontoolresult() { return this._handler; }
    async connect() {
      // Fire after the widget's own render(SAMPLE), so real data wins.
      setTimeout(() => this._handler?.({
        content: [{ type: 'text', text: ${JSON.stringify(JSON.stringify(payload))} }]
      }), 30);
    }
    async callServerTool(params) {
      const res = await fetch('/call-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return res.json();
    }
  }
};`;

const html = readFileSync(path.join(root, 'mcp', 'widgets', 'hxl-order-card.html'), 'utf8')
  .replace('/*__EXT_APPS_BUNDLE__*/', () => stub)
  .replace('<body>', '<body style="background:#f5f4f0;padding:24px;max-width:520px;margin:0 auto">');

// Also written to disk for screenshots and archiving. Note the buttons need the
// server running - a file:// open renders the card but cannot call tools.
writeFileSync(path.join(root, 'preview.html'), html);

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/call-tool') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let out;
    try {
      const params = JSON.parse(body);
      console.log(`  -> tools/call ${params.name} ${JSON.stringify(params.arguments || {})}`);
      const r = await rpc('tools/call', params);
      out = r.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(r.error) }] };
    } catch (err) {
      out = { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\npreview running at ${url}   (Ctrl+C to stop)`);
  console.log('wrote', path.join(root, 'preview.html'), '(static - buttons need this server)');
  if (process.argv.includes('--open')) {
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(process.platform === 'win32' ? 'cmd' : 'open', args, { detached: true, stdio: 'ignore' }).unref();
  }
});

const shutdown = () => { child.kill(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
