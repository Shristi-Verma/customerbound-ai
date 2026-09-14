/**
 * Front end for the HXL demo.
 *
 * Note what is absent: no Salesforce SDK, no client id in this file, no token
 * handling. The browser knows about `/api/*` on its own origin and nothing
 * else. Swapping this for React or a native app changes nothing behind it.
 */

/** What each BFF route actually drives on the Salesforce side, for the wire log. */
const SF_CALLS = {
  'login': ['POST /services/oauth2/authorize  (Auth-Request-Type: Named-User)', 'POST /services/oauth2/token'],
  'register/init': ['POST /services/auth/headless/init/registration'],
  'register/verify': ['POST /services/oauth2/authorize  (Auth-Request-Type: user-registration)', 'POST /services/oauth2/token'],
  'passwordless/init': ['POST /services/auth/headless/init/passwordless/login'],
  'passwordless/verify': ['POST /services/oauth2/authorize  (Auth-Request-Type: passwordless-login)', 'POST /services/oauth2/token'],
  'forgot/init': ['POST /services/auth/headless/forgot_password'],
  'forgot/reset': ['POST /services/auth/headless/forgot_password  (otp + newpassword)'],
  'me': ['GET /services/oauth2/userinfo', 'GET /services/apexrest/hxl/orders'],
  'orders': ['POST /services/apexrest/hxl/orders'],
  'logout': ['(local session drop only)'],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const logEl = $('#log');
const errEl = $('#error');

function log(kind, text, detail) {
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<span class="ts">${new Date().toLocaleTimeString()}</span><span class="msg"></span>`;
  $('.msg', li).textContent = text;
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    li.appendChild(pre);
  }
  logEl.prepend(li);
}

function showError(message) {
  errEl.textContent = message;
  errEl.hidden = !message;
}

async function api(route, body) {
  showError('');
  log('out', `POST /api/${route}`, (SF_CALLS[route] || []).map((c) => '→ ' + c).join('\n'));

  const res = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    log('err', `${res.status} ${data.error || 'request failed'}`, data.detail ? JSON.stringify(data.detail, null, 2) : null);
    showError(data.error || `Request failed (${res.status})`);
    throw Object.assign(new Error(data.error || 'failed'), { data, status: res.status });
  }
  log('in', `${res.status} ok`, JSON.stringify(data, null, 2).slice(0, 800));
  return data;
}

/* ---------------------------------------------------------------- *
 * Tabs
 * ---------------------------------------------------------------- */
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.tab));
  showError('');
});

/** Reads a form's named inputs, ignoring blanks. */
function values(form) {
  const out = {};
  for (const el of $$('input', form)) if (el.value.trim()) out[el.name] = el.value.trim();
  return out;
}

function advance(form, note) {
  $('[data-step="1"]', form).hidden = true;
  const two = $('[data-step="2"]', form);
  two.hidden = false;
  const noteEl = $('[data-otp-note]', two);
  if (noteEl && note) noteEl.textContent = note;
}

function resetSteps(form) {
  const one = $('[data-step="1"]', form);
  const two = $('[data-step="2"]', form);
  if (one) one.hidden = false;
  if (two) two.hidden = true;
  form.reset();
}

/* ---------------------------------------------------------------- *
 * Flow submission - one handler, the button says which step it is
 * ---------------------------------------------------------------- */
$$('.tabpane').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.dataset.action || 'login';
    const v = values(form);

    try {
      if (action === 'register/init') {
        await api(action, { email: v.email, lastName: v.lastName, password: v.password });
        advance(form, `Code sent to ${v.email}. Check the email, or Setup → Debug Logs if delivery is off.`);
      } else if (action === 'passwordless/init') {
        const out = await api(action, { username: v.username });
        advance(form, `Code sent to ${out.otpSentTo}.`);
      } else if (action === 'forgot/init') {
        await api(action, { username: v.username });
        form.dataset.username = v.username;
        advance(form);
      } else if (action === 'forgot/reset') {
        await api(action, { username: form.dataset.username, otp: v.otp, newPassword: v.newPassword });
        resetSteps(form);
        showError('');
        log('note', 'Password reset. Sign in on the Login tab with the new password.');
      } else {
        // login, register/verify, passwordless/verify - all end signed in
        await api(action, v);
        resetSteps(form);
        await loadAccount();
      }
    } catch {
      /* already surfaced by api() */
    }
  });
});

/* ---------------------------------------------------------------- *
 * Signed-in view
 * ---------------------------------------------------------------- */
function renderTokens(t) {
  const dl = $('#token-facts');
  dl.innerHTML = '';
  const rows = {
    'Access token': t.accessTokenPreview || '—',
    'Type': t.tokenType || '—',
    'Scope': t.scope || '—',
    'Refresh token': t.hasRefreshToken ? 'yes' : 'no',
    'ID token': t.hasIdToken ? 'yes' : 'no',
    'Community URL': t.communityUrl || '—',
  };
  for (const [k, val] of Object.entries(rows)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    dl.append(dt, dd);
  }
}

/** "6 Sep 14:11" - short enough to sit in a column without wrapping. */
function shortDate(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${time}`;
}

function renderOrders(orders) {
  const body = $('#orders tbody');
  body.innerHTML = '';
  $('#no-orders').hidden = orders.length > 0;
  $('#orders').hidden = orders.length === 0;

  for (const o of orders) {
    const tr = document.createElement('tr');
    for (const cell of [
      o.orderNumber,
      o.status,
      o.totalAmount != null ? '$' + Number(o.totalAmount).toFixed(2) : '—',
      o.placedOn ? shortDate(o.placedOn) : '—',
    ]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

async function loadAccount() {
  try {
    const me = await api('me');
    $('#account').hidden = false;
    $('#acct-name').textContent = me.name || me.profile?.name || 'Signed in';
    $('#acct-email').textContent = me.email || me.profile?.email || '';
    renderTokens(me.tokens || {});
    renderOrders(me.orders || []);
    if (!me.contactId) {
      log('note', 'Token has no Contact behind it - Apex returned an empty envelope rather than leaking data.');
    }
  } catch (err) {
    // 401 just means "nobody signed in yet" - not worth a red banner.
    if (err.status === 401) {
      $('#account').hidden = true;
      showError('');
    }
  }
}

$('#new-order').addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = $('input[name="totalAmount"]', e.target).value;
  try {
    await api('orders', { totalAmount: Number(amount) });
    await loadAccount();
  } catch {
    /* surfaced */
  }
});

$('#logout').addEventListener('click', async () => {
  await api('logout', {});
  $('#account').hidden = true;
  log('note', 'Session dropped. Tokens discarded server-side.');
});

$('#clear-log').addEventListener('click', () => (logEl.innerHTML = ''));

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */
(async function boot() {
  const el = $('#config');
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.configured) {
      el.className = 'config ok';
      el.textContent = `site: ${cfg.siteUrl}`;
    } else {
      el.className = 'config bad';
      el.textContent = `not configured — set ${cfg.missing.join(', ')} in .env`;
    }
  } catch {
    el.className = 'config bad';
    el.textContent = 'BFF unreachable';
  }
  // Resume a live session if the cookie survived a page reload.
  await loadAccount().catch(() => {});
})();
