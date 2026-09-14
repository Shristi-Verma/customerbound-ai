#!/usr/bin/env node
/**
 * Talks to the MCP server as a real client would, over both transports, and
 * prints what a host would see. Use it to prove the server before involving
 * Claude Desktop, ChatGPT or Slack - a render failure later is then about the
 * host, not the server.
 *
 *   node mcp/smoke.mjs                 stdio (spawns mcp/server.mjs)
 *   node mcp/smoke.mjs http://localhost:8787/mcp/chatgpt
 *   node mcp/smoke.mjs https://<tunnel>/mcp/slack --sign-in user pass --place-order
 *   node mcp/smoke.mjs --get-order ORD-00003          (Grace Hopper's - must be found:false)
 *   node mcp/smoke.mjs --search ""                     (the prompt-injection shape: no owner filter, only Ada's rows)
 *   node mcp/smoke.mjs --cancel ORD-00003              (Grace's - "not visible"; --cancel one of Ada's Submitted orders works)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a));
const si = args.indexOf('--sign-in');
const creds = si >= 0 ? { username: args[si + 1], password: args[si + 2] } : null;

const transport = url
  ? new StreamableHTTPClientTransport(new URL(url))
  : new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, 'server.mjs')],
      env: process.env,
    });

const client = new Client({ name: 'hxl-smoke', version: '1.0.0' });
await client.connect(transport);

const caps = client.getServerCapabilities();
console.log('transport      :', url ? `http ${url}` : 'stdio');
console.log('server         :', JSON.stringify(client.getServerVersion()));
console.log('ui extension   :', caps?.extensions?.['io.modelcontextprotocol/ui'] ? 'yes' : 'NO');
if (url) console.log('session id     :', transport.sessionId);

const tools = await client.listTools();
console.log('tools          :', tools.tools.map((t) => t.name).join(', '));
const card = tools.tools.find((t) => t.name === 'get_my_orders');
console.log('card resource  :', card?._meta?.ui?.resourceUri || 'MISSING');

const resources = await client.listResources();
const widget = resources.resources[0];
const read = await client.readResource({ uri: widget.uri });
const html = read.contents[0]?.text || '';
console.log('widget html    :', html.length, 'bytes;', /globalThis\.ExtApps=/.test(html) ? 'runtime inlined' : 'RUNTIME NOT INLINED');

const text = (r) => JSON.parse(r.content[0].text);

const who = text(await client.callTool({ name: 'whoami', arguments: {} }));
console.log('whoami (before):', JSON.stringify(who));

if (creds) {
  const r = await client.callTool({ name: 'sign_in', arguments: creds });
  console.log('sign_in        :', r.isError ? 'FAILED ' + r.content[0].text : r.content[1]?.text);
}

const orders = text(await client.callTool({ name: 'get_my_orders', arguments: {} }));
console.log('get_my_orders  :', orders.customerName, '|', orders.identityMode, '|', orders.totalValue);

const gi = args.indexOf('--get-order');
if (gi >= 0) {
  const r = await client.callTool({ name: 'get_order', arguments: { lookup: args[gi + 1] } });
  console.log('get_order      :', r.isError ? 'FAILED ' + r.content[0].text : r.content[0].text);
}

const si2 = args.indexOf('--search');
if (si2 >= 0) {
  const r = await client.callTool({ name: 'search_orders', arguments: { query: args[si2 + 1] || '' } });
  const b = r.isError ? null : JSON.parse(r.content[0].text);
  console.log('search_orders  :', r.isError ? 'FAILED ' + r.content[0].text : `${b.count} visible, ownerFilterApplied=${b.ownerFilterApplied}; ` + b.orders.map((o) => o.orderNumber).join(' '));
}

const ci = args.indexOf('--cancel');
if (ci >= 0) {
  const r = await client.callTool({ name: 'cancel_order', arguments: { orderNumber: args[ci + 1] } });
  console.log('cancel_order   :', r.isError ? 'FAILED ' + r.content[0].text : r.content[1]?.text);
}

if (args.includes('--place-order')) {
  const r = await client.callTool({ name: 'place_order', arguments: { amount: 12.34 } });
  console.log('place_order    :', r.isError ? 'FAILED ' + r.content[0].text : r.content[1]?.text);
}

const who2 = text(await client.callTool({ name: 'whoami', arguments: {} }));
console.log('whoami (after) :', JSON.stringify(who2));

await client.close();
