#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const BFF = (process.env.HXL_BFF_URL || 'http://localhost:3000').replace(/\/$/, '');
const personas = readFileSync(path.join(root, 'DEMO_PERSONAS.local.md'), 'utf8');

function credentials(heading) {
  const block = personas.match(new RegExp(`## ${heading} persona([\\s\\S]*?)(?=\\n## |$)`, 'i'))?.[1] || '';
  const username = block.match(/Username:\s*`([^`]+)`/i)?.[1];
  const password = block.match(/Password:\s*`([^`]+)`/i)?.[1];
  if (!username || !password) throw new Error(`Missing ${heading} credentials in DEMO_PERSONAS.local.md`);
  return { username, password };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const check = (condition, label) => {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`PASS ${passed}: ${label}`);
};

async function login(label) {
  const res = await fetch(`${BFF}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials(label)),
  });
  check(res.ok, `${label} signs in as a named user`);
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .filter(Boolean).map((value) => value.split(';')[0]).join('; ');
  check(Boolean(cookie), `${label} receives an isolated server session`);
  return cookie;
}

async function call(cookie, url, options = {}) {
  const res = await fetch(`${BFF}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-HXL-Channel': 'codex', Cookie: cookie, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function waitForVisible(cookie, orderNumber) {
  for (let i = 0; i < 15; i += 1) {
    const out = await call(cookie, `/api/orders/${encodeURIComponent(orderNumber)}`);
    if (out.res.ok) return out;
    await sleep(1000);
  }
  throw new Error(`FAIL: automatic staff routing did not expose ${orderNumber}`);
}

try {
  const customer = await login('Customer');
  const staff = await login('Staff');
  const supervisor = await login('Supervisor');

  const customerMe = await call(customer, '/api/me');
  check(customerMe.body.persona === 'customer', 'customer session has customer persona');

  const created = await call(customer, '/api/orders', { method: 'POST', body: JSON.stringify({ totalAmount: 750 }) });
  check(created.res.status === 201 && created.body.orderNumber, 'customer creates high-value activity');
  const item = created.body.orderNumber;

  await waitForVisible(staff, item);
  check(true, 'new activity is automatically routed into the staff portfolio');

  const requested = await call(staff, `/api/orders/${item}/staff-action`, {
    method: 'POST', body: JSON.stringify({ action: 'request_info', staffNote: 'Please confirm the delivery requirement.' }),
  });
  check(requested.res.ok && requested.body.status === 'Information Required', 'staff requests more information');

  const responded = await call(customer, `/api/orders/${item}/respond`, {
    method: 'POST', body: JSON.stringify({ customerMessage: 'Confirmed: standard delivery is acceptable.' }),
  });
  check(responded.res.ok && responded.body.status === 'Resubmitted', 'customer responds and resubmits');

  const escalated = await call(staff, `/api/orders/${item}/staff-action`, {
    method: 'POST', body: JSON.stringify({ action: 'approve', staffNote: 'Validated by operations.' }),
  });
  check(escalated.res.ok && escalated.body.status === 'Pending Supervisor Approval', 'high-value work requires second approval');

  const blocked = await call(staff, `/api/orders/${item}/staff-action`, {
    method: 'POST', body: JSON.stringify({ action: 'supervisor_approve', staffNote: 'Attempted bypass.' }),
  });
  check(blocked.res.status === 409, 'ordinary staff cannot complete supervisor approval');

  const approved = await call(supervisor, `/api/orders/${item}/staff-action`, {
    method: 'POST', body: JSON.stringify({ action: 'supervisor_approve', staffNote: 'Independent approval complete.' }),
  });
  check(approved.res.ok && approved.body.status === 'Approved' && approved.body.supervisorApproved, 'named supervisor completes second approval');

  const fulfilled = await call(staff, `/api/orders/${item}/staff-action`, {
    method: 'POST', body: JSON.stringify({ action: 'fulfill', staffNote: 'Completed after approvals.' }),
  });
  check(fulfilled.res.ok && fulfilled.body.status === 'Fulfilled', 'staff completes approved work');

  const finalCustomer = await call(customer, `/api/orders/${item}`);
  check(finalCustomer.res.ok && finalCustomer.body.orders?.[0]?.status === 'Fulfilled', 'customer sees final status');
  check(!JSON.stringify(finalCustomer.body).includes('Independent approval complete'), 'internal notes remain hidden from customer');

  console.log(`\nCustomerBound acceptance matrix passed: ${passed} checks.`);
  console.log(`Created demo record: ${item}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
