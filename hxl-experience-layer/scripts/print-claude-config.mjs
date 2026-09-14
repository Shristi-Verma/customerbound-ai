#!/usr/bin/env node
/**
 * Prints the exact block to paste into claude_desktop_config.json, with real
 * absolute paths for this machine. Claude Desktop needs native stdio and
 * absolute paths - a relative path or an npx shim will fail silently.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(__dirname, '..', 'mcp', 'server.mjs');

let node = process.execPath;
try {
  node = execSync(process.platform === 'win32' ? 'where node' : 'which node')
    .toString().split(/\r?\n/)[0].trim() || process.execPath;
} catch { /* fall back to the running interpreter */ }

const block = {
  mcpServers: {
    'hxl-order-card': {
      command: node,
      args: [server],
      env: {
        HXL_BFF_URL: process.env.HXL_BFF_URL || 'http://localhost:3000',
        HXL_DEMO_USER: process.env.HXL_DEMO_USER || 'ada.hxl@hxlpoc.demo',
        HXL_DEMO_PASSWORD: process.env.HXL_DEMO_PASSWORD || '<password>',
      },
    },
  },
};

const target = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json')
  : process.platform === 'darwin'
    ? '~/Library/Application Support/Claude/claude_desktop_config.json'
    : '~/.config/Claude/claude_desktop_config.json';

console.log(`\nPaste into: ${target}\n`);
console.log(JSON.stringify(block, null, 2));
console.log(`
Then quit Claude Desktop completely and reopen it - it only reads this file at
launch. Ask: "show me my orders". Start the Track A BFF first (npm start in
../hxl-demo) or the card renders sample data.
`);
