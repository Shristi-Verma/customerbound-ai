#!/usr/bin/env node
/**
 * Installs three local-only Claude Desktop MCP entries for a smooth demo.
 * Credentials come from the gitignored DEMO_PERSONAS.local.md and are never
 * printed. Existing Claude settings are preserved and a backup is created.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('This installer currently targets Claude Desktop on Windows.');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const server = path.resolve(here, '..', 'mcp', 'server.mjs');
const personaFile = path.join(root, 'DEMO_PERSONAS.local.md');
const target = path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
const text = readFileSync(personaFile, 'utf8');

function credentials(label) {
  const block = text.match(new RegExp(`## ${label} persona([\\s\\S]*?)(?=\\n## |$)`, 'i'))?.[1] || '';
  const username = block.match(/Username:\s*`([^`]+)`/i)?.[1];
  const password = block.match(/Password:\s*`([^`]+)`/i)?.[1];
  if (!username || !password) throw new Error(`Missing ${label} credentials in ${personaFile}`);
  return { username, password };
}

const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
existing.mcpServers ||= {};
delete existing.mcpServers.customerbound;

for (const label of ['Customer', 'Staff', 'Supervisor']) {
  const { username, password } = credentials(label);
  existing.mcpServers[`customerbound-${label.toLowerCase()}`] = {
    command: process.execPath,
    args: [server],
    env: {
      HXL_BFF_URL: 'http://localhost:3000',
      HXL_DEMO_USER: username,
      HXL_DEMO_PASSWORD: password,
      HXL_CHANNEL: 'claude',
    },
  };
}

mkdirSync(path.dirname(target), { recursive: true });
if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(target, `${target}.${stamp}.bak`);
}
writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
console.log('Installed three local CustomerBound personas in Claude Desktop.');
console.log('Credentials were read from the ignored persona file and were not printed.');
console.log('Fully quit and reopen Claude Desktop to load the new connections.');
