# Track B — Host Verification: Claude Desktop, ChatGPT / Codex, Slack

*What to run, what to click, and what has to be true before you can say "it renders there".
Written 2026-09-12 against `mcp/server.mjs` v1.1.0 (per-session identity) and
`mcp/server-http.mjs` (Streamable HTTP). Everything in "Verified on this machine" was actually
run today; everything under a host heading is the procedure, with its target, and has not been
run yet — the hosts aren't installed / connected here.*

---

## Verified on this machine (2026-09-12)

| Check | Result |
|---|---|
| `node mcp/smoke.mjs` (stdio, BFF down) | tools `sign_in, sign_out, whoami, get_my_orders, place_order`; ui extension yes; widget 325 KB with runtime inlined; card = `sample data (fetch failed)` — degrades, doesn't crash |
| `node mcp/smoke.mjs` (stdio, BFF up) | `Ada Lovelace \| named user \| $835.92 across 11 orders`; `whoami` → Contact `003g800000fQI05AAG`, channel `claude` |
| `node mcp/smoke.mjs http://localhost:8787/mcp/chatgpt` (no sign-in) | card = `Not signed in`; `envIdentityAllowed: false` — a hosted session cannot inherit the env customer |
| `…/mcp/slack --sign-in ada… <pw>` | `Signed in as Ada Lovelace (Contact 003g800000fQI05AAG) on channel "slack"`; card live, 11 orders |
| `GET /sessions` | one entry, channel `slack`, no cookie or token in the output |
| **`Channel__c` audit column** — `place_order` via `/mcp/slack`, `/mcp/chatgpt`, stdio | `ORD-00012 slack`, `ORD-00013 chatgpt`, `ORD-00014 claude`, all owner Ada Lovelace — from `SELECT Name, Owner_Contact__r.Name, Channel__c FROM HXL_Order__c` |
| **Apex tests** `HXL_OrderAPITest` | 4/4 pass, incl. channel recorded, unknown → `other`, missing → `web` |
| **cloudflared** | `winget install --id Cloudflare.cloudflared -e` → `cloudflared version 2026.9.1` |
| **`get_order` negative path** (no owner filter anywhere) | Ada → `ORD-00003` / `a00g8000027TtVYAA0` (Grace Hopper, $9,999): `found:false`. Ada → `ORD-00001` (hers, admin-created, via sharing set) and `ORD-00015` (hers): `found:true`. **Before the sharing fix this returned Grace's order** — see `hxl-demo/HXL_ORG_CONTEXT.md` §10 |
| **`search_orders("")` — the prompt-injection shape** (no owner filter) | 16 orders, `ownerFilterApplied:false`, all Ada's; `search_orders("ORD-00003")` → 0. Sharing scoped a deliberately unscoped query |
| **`cancel_order`** | own Submitted `ORD-00016` → `Cancelled` (SOQL confirms); own Shipped `ORD-00001` → refused (409, "is Shipped"); Grace's `ORD-00003` → "not visible"; cancelling an already-Cancelled order → refused. Card button enabled only for Draft/Submitted |
| **Public path end to end** | `cloudflared tunnel --url http://localhost:8787` → `https://<random>.trycloudflare.com`; `smoke.mjs https://…/mcp/chatgpt --sign-in … --place-order` → `ORD-00015`, channel `chatgpt`, in the org; `/sessions` via the tunnel shows the session |

So: the server is proven over both transports **and over a public URL**, per-session identity
works, the channel label follows the path all the way into Salesforce, and the audit query
already shows three channels for one owner. What remains is the last hop — a real host
painting the card.

Two things learned on the way, both now handled:
- The BFF started via `Start-Process npm` on Windows silently doesn't start (npm is a .cmd
  shim). Use `node app/server.js` directly, or a normal terminal.
- The site's intermittent DNS blip can hit `/api/me` right after a successful login;
  `sign_in` now retries once so it doesn't report "(sample)" on stage.

---

## 0 · Start everything (every time)

```powershell
# Terminal 1 — Track A identity layer (the only thing that holds a Salesforce token)
cd D:\personal\hxl-demo
npm start                                   # http://localhost:3000

# Terminal 2 — hosted MCP server (ChatGPT / Slack). Not needed for Claude Desktop.
cd D:\personal\hxl-experience-layer
npm run mcp:http                            # http://localhost:8787

# Terminal 3 — tunnel (ChatGPT / Slack only). cloudflared 2026.9.1 is installed
# (C:\Program Files (x86)\cloudflared). If a fresh terminal can't find it, it was
# opened before the install - open a new one.
cloudflared tunnel --url http://localhost:8787
#   -> look for the line:  https://<four-random-words>.trycloudflare.com
#   -> that URL changes on EVERY restart of cloudflared. Copy it each time.
```

cloudflared install steps, for another machine (done here already):
1. PowerShell **as Administrator**: `winget install --id Cloudflare.cloudflared -e`
2. Close and reopen the terminal (PATH refresh).
3. `cloudflared --version` → should print `2026.x`.
No Cloudflare account is needed for a quick tunnel (`tunnel --url …`). A named tunnel with a
stable hostname needs an account and a domain — worth it only if the tunnel URL rotating
between rehearsal and demo becomes a real problem.

Sanity check the tunnel from the **phone, not the laptop** (proves it's public):
`https://<tunnel>/healthz` → `ok`.

Then prove the MCP contract through the tunnel before touching any host:

```powershell
node mcp/smoke.mjs https://<tunnel>/mcp/chatgpt
node mcp/smoke.mjs https://<tunnel>/mcp/slack --sign-in ada.hxl@hxlpoc.demo <password>
```

Both must print the same tool list and `runtime inlined` as the local run. If they don't, the
tunnel is the problem, not the host.

**Identity per host — decide up front.** On HTTP the server refuses to act as the env-var
customer by default. Two choices:

| Mode | Set | Behaviour | Use when |
|---|---|---|---|
| `sign_in` (default) | nothing | Each chat must call `sign_in(username, password)` once; then everything acts as that customer | Anything that stays up longer than one screenshot; the two-identity proof |
| env identity | `HXL_ALLOW_ENV_IDENTITY=1` before `npm run mcp:http` | Any unsigned session acts as `HXL_DEMO_USER` — **every user of every host sees Ada** | A throwaway tunnel URL for a single render screenshot, torn down after |

---

## 1 · Claude Desktop (stdio — must pass first)

**Need:** Claude Desktop installed (not on this machine yet). BFF running. Nothing hosted.

1. `npm run config` → paste the block into `%APPDATA%\Claude\claude_desktop_config.json`.
   For the two-identity proof, duplicate the entry as `hxl-ada` and `hxl-<second>` with
   different `HXL_DEMO_USER` / `HXL_DEMO_PASSWORD` (or leave the second one's creds out and
   use `sign_in` in that chat).
2. **Quit Claude Desktop fully** (tray icon → Quit) and reopen. It reads the config only at
   launch.
3. New chat → the tools icon / connector list shows `hxl-order-card` with five tools.
   **Target A:** seen in the list. If not: Settings → Developer → check the server's log
   file there; the usual cause is a relative path or a missing `HXL_BFF_URL`.
4. Ask: **"show me my orders"**.
   **Target B:** a real card renders — name, badge, order count, a button. Not JSON, not a
   paragraph describing a card. Badge must read **`named user`** (green). `sample data`
   means the BFF isn't reachable from the process Claude launched — check `HXL_BFF_URL` in
   the config env.
5. **Target C (data is real):** in the org:
   `SELECT COUNT() FROM HXL_Order__c WHERE Owner_Contact__c = '003g800000fQI05AAG'` equals
   the card's count.
6. Click **Place another order**. **Target D:** count goes up on the card, and a new
   `HXL_Order__c` exists with owner Ada, `CreatedDate` = now.
7. Ask **"who am I"** → `whoami` returns `channel: "claude"`, Contact id, no token. Screenshot
   B and D. Those two screenshots are the Phase 2 Part 1 deliverable.

**If the card is blank:** the widget iframe tried to load something over the network. It
shouldn't — the runtime is inlined — but check `mcp/widgets/hxl-order-card.html` has no
`<script src=` left in it.

---

## 2 · ChatGPT (and Codex) — Streamable HTTP over the tunnel

### What "OpenAI" means here, precisely

| Surface | Can call the tools? | Can render the card? | Use it for |
|---|---|---|---|
| **ChatGPT** (web/desktop app, Developer Mode connector) | Yes | **Yes** — ChatGPT supports the MCP Apps standard (its Apps SDK converged on it) | The render proof. This is the one that counts |
| **Codex** (CLI / IDE agent) | Yes — it's a full MCP client | **No** — it's a terminal; there is no iframe to paint in | Proving OpenAI's client speaks to the server and gets correctly scoped data. A tool-contract check, not a render check |

Don't present a Codex tool call as "renders in OpenAI". It doesn't, and the room will know.

### 2a · ChatGPT

**Need:** a ChatGPT account where Developer Mode is available (Plus/Pro/Business/Enterprise
at the time of writing — check Settings first; if the toggle isn't there, the plan doesn't
have it and that's the finding). Tunnel up. `sign_in` mode.

1. ChatGPT → **Settings → Apps & Connectors → Advanced → Developer mode** → on.
2. **Create** connector: name `HXL Order Card`, URL **`https://<tunnel>/mcp/chatgpt`**,
   Authentication: **None** (POC). Save.
   **Target A:** the connector page lists five tools with their descriptions. If it lists
   nothing, ChatGPT couldn't complete `initialize` — re-run `smoke.mjs` against the exact
   URL you pasted (trailing slash matters: the server strips it, but check).
3. New chat → **+ → More → enable the `HXL Order Card` connector** for this chat.
4. Say: **"Sign in to HXL as ada.hxl@hxlpoc.demo with password <pw>"**. ChatGPT calls
   `sign_in`. **Target B:** reply names Ada and Contact `003g800000fQI05AAG`, channel
   `chatgpt`; the card renders inline from the sign-in result (the tool carries the widget
   meta, so the card appears without a second call). Server log shows
   `session … opened via chatgpt`.
5. Say: **"show me my orders"**. **Target C:** card renders, badge `named user`, count
   matches the SOQL from step 1.5.
6. Click **Place another order** in the card. **Target D:** card refreshes with +1; new order
   in the org, owner Ada. If the card renders but the click does nothing, open the browser
   console (F12) — ChatGPT's widget sandbox may block something Claude's allows. **That is a
   finding; write it down with the console text, don't work around it live.**
7. `GET https://<tunnel>/sessions` → one entry, channel `chatgpt`. Screenshot C, D, and this.

**Password in chat:** yes, for the POC the password is typed into the chat and ChatGPT
forwards it to the tool. Say so when presenting: the proper version is MCP OAuth with the
BFF as the authorization server, where the host opens a login page and no credential ever
transits the model. That's scoped as the follow-on, not hidden.

### 2b · Codex (tool contract only)

**Need:** Codex CLI (`npm i -g @openai/codex`) signed in.

Add to `~/.codex/config.toml` — either transport works:

```toml
[mcp_servers.hxl]
url = "https://<tunnel>/mcp/chatgpt"      # or the local HTTP server: http://localhost:8787/mcp

# or, stdio, no tunnel needed:
# [mcp_servers.hxl]
# command = "node"
# args = ["D:/personal/hxl-experience-layer/mcp/server.mjs"]
# env = { HXL_BFF_URL = "http://localhost:3000", HXL_DEMO_USER = "ada.hxl@hxlpoc.demo", HXL_DEMO_PASSWORD = "<pw>" }
```

Then `codex` → `/mcp` lists the server and tools → ask "show my orders". **Target:** the
text reply contains `"identityMode":"named user"` and `"contactId":"003g800000fQI05AAG"`.
That proves OpenAI's client reaches the server and gets Contact-scoped data. It proves
nothing about rendering — say exactly that.

---

## 3 · Slack — Slackbot via MCP Apps

### The one hard constraint, again

Salesforce's HXL guide: widgets *"don't currently render when using Block Kit for Slackbot."*
The only Slack route is **Slackbot consuming the server as an MCP App** — the same standard as
Claude and ChatGPT. There is no Block Kit fallback that shows this card; a Block Kit build
would be a different widget written by hand.

### 3a · Gate: does this workspace have it? (do this first, 15 minutes max)

1. Slack workspace **admin** → Settings & administration → **Workspace settings → AI /
   Slackbot** (naming varies by rollout) → look for the ability to add an **MCP server /
   MCP App / custom connector** to Slackbot.
2. If it's there: note the plan name, screenshot the page. Proceed to 3b.
3. If it's not: **stop.** Record in `TRACK_B_ORG_CONTEXT.md`: workspace name, plan, date,
   "Slackbot MCP Apps not available". The demo line is "Slack rendering needs Slackbot's MCP
   Apps support enabled on the workspace, which this one doesn't have yet. Not attempted, not
   claimed." Don't burn hours on it.

Also check in the HXL Playground → Documentation tab that every component in
`hxlOrderCard.json` (`tile/card`, `tile/badge`, `tile/callout`, `tile/column`, the button)
shows **Slackbot: Beta**, not Planned. Support is per component; one unsupported child block
can blank the whole card in Slack while it's fine in Claude.

### 3b · Connect and render

**Need:** tunnel up, `sign_in` mode, an admin who can add the MCP App.

1. Register the server with Slackbot: URL **`https://<tunnel>/mcp/slack`**, no auth.
   **Target A:** Slack's connector/app page lists the five tools. Server log:
   `session … opened via slack`.
2. Open a **DM with Slackbot**. Say: "Sign in to HXL as ada.hxl@hxlpoc.demo password <pw>".
   **Target B:** reply names Ada; card renders inline (or on the next step, depending on how
   Slackbot surfaces tool UI — note which).
3. Say: "show me my orders". **Target C:** card renders as a card in the Slack message,
   badge `named user`, count matches SOQL.
4. Click **Place another order**. **Target D:** count +1 in card; new order in the org, owner
   Ada. If the click is dead: finding, console/screenshot, move on.
5. `GET https://<tunnel>/sessions` → an entry with channel `slack`.

**Slack-specific things to record whatever happens:** does the card render in a channel as
well as a DM; does it re-render after the click or post a new message; does it survive the
Slack client being closed and reopened (MCP session may be dropped — the card would then say
`session expired` and the user signs in again; that's by design, note it).

---

## 4 · The two-identity proof on hosted surfaces (Phase 2 Part 3, Step 3.3–3.5)

Once one hosted host renders, this is the run that proves the pattern generalises. It needs
the second customer from the Registration flow (Part 2) or, failing that, any second
community user with its own orders.

1. **Session 1 (Claude Desktop, stdio):** Ada, via env identity. `whoami` → Ada.
2. **Session 2 (ChatGPT or Slack, HTTP):** "Sign in as <second user>". `whoami` → second
   Contact id, channel `chatgpt` / `slack`.
3. `GET /sessions` → exactly one entry (the hosted one; stdio sessions live in the other
   process). **Two processes, two Contact ids, verified from outside the UI.** Screenshot.
4. In both: "show me my orders". **Target:** two cards, different names, different counts,
   neither containing the other's latest order number.
5. In Ada's session: "show me order <second user's order number>". **Target:** the model
   calls `get_order` and gets `found:false` — an explicit refusal from Apex sharing with no
   owner filter in the chain. Then, in the second session, the same order number →
   `found:true`. Same tool, same server, two tokens, two answers.
6. Click **Place another order** in **both** sessions → audit SOQL shows two new rows, two
   owners, two channels. That query on screen is the end of the demo.

---

## 5 · What to write into `TRACK_B_ORG_CONTEXT.md` afterwards

One line per host, only true ones:

- Claude Desktop: rendered ☐ / button worked ☐ / screenshot path
- ChatGPT: Developer Mode available on plan ☐ / rendered ☐ / button worked ☐ / console text if not
- Codex: tool call returned named-user payload ☐ (no render — expected)
- Slack: MCP Apps available on workspace ☐ / rendered ☐ / button worked ☐ / DM vs channel
- Tunnel: provider, whether the URL rotated mid-demo
- `/sessions` screenshot for the two-identity run

---

## Files added / changed today

| File | What |
|---|---|
| `hxl-experience-layer/mcp/server.mjs` | v1.1.0 — identity per MCP session; `sign_in`, `sign_out`, `whoami` tools; `X-HXL-Channel` header on every BFF call; env identity only on stdio unless `HXL_ALLOW_ENV_IDENTITY=1`; `createServer()` exported; stdio runs only when invoked directly |
| `hxl-experience-layer/mcp/server-http.mjs` | Streamable HTTP entry point; `/mcp`, `/mcp/chatgpt`, `/mcp/slack`, `/mcp/claude` set the channel label; `/healthz`; `/sessions` |
| `hxl-experience-layer/mcp/smoke.mjs` | Real MCP client over stdio or HTTP; prints what a host sees; `--sign-in user pass`, `--place-order`, `--get-order ORD-xxxxx` |
| `hxl-experience-layer/mcp/server.mjs` — `search_orders` tool | Unfiltered search (`GET /api/orders/search?q=`); the tool description *invites* "list all customers' orders" so an injected model reaches for it — and sharing answers |
| `hxl-experience-layer/mcp/server.mjs` — `cancel_order` tool | `POST /api/orders/:n/cancel` → Apex `PATCH`; returns the refreshed card; 404/409 reported as plain notes, not errors |
| `hxl-experience-layer/mcp/widgets/hxl-order-card.html` + `force-app/.../hxlOrderCard.json` | Second button is now **Cancel <latest order>** (HTML: enabled only for Draft/Submitted; Mosaic label updated and redeployed) |
| `hxl-demo/.../HXL_OrderAPI.cls` — `GET ?q=` and `@HttpPatch cancelOrder` | Both `with sharing` + `WITH USER_MODE`, no owner filter; cancel returns a JSON body on 404 (a `null` return made the platform answer non-JSON) |
| `hxl-demo/.../HXL_Customer_Access`, `HXL customer` profile, sharing set | `allowEdit` on the object; sharing set raised to **Edit** so staff-created orders are cancellable by the customer |
| `hxl-experience-layer/mcp/server.mjs` — `get_order` tool | Looks up one order by Id or ORD-number **with no owner filter**; a 404 from Apex is reported as `found:false` with the reason. This is the negative-path proof from inside the chat |
| `hxl-demo/.../HXL_OrderAPI.cls` — `GET /hxl/orders/<id\|name>` | Same query shape as before, `with sharing` + `WITH USER_MODE`, no `Owner_Contact__c` filter on purpose |
| `hxl-demo/app/server.js` — `GET /api/orders/:lookup` | Passes the platform's status straight through |
| `hxl-demo/.../profiles/HXL customer.profile-meta.xml` | Partial profile: `viewAllRecords=false` on `HXL_Order__c` — **the sharing fix** |
| `hxl-demo/.../sharingSets/HXL_Customer_Orders.sharingSet-meta.xml` | Customers read orders whose `Owner_Contact__c` is their Contact |
| `package.json` scripts | `npm run mcp:http`, `npm run smoke`, `npm run smoke:http` |
| `.env.example` | `HXL_MCP_PORT`, `HXL_ALLOW_ENV_IDENTITY` |

| `hxl-demo/force-app/.../HXL_Order__c/fields/Channel__c.field-meta.xml` | New restricted picklist: `web` (default), `claude`, `chatgpt`, `slack`, `codex`, `other`. **Deployed to the org.** |
| `hxl-demo/force-app/.../HXL_OrderAPI.cls` | `createOrder(totalAmount, channel)` — validates against the picklist, unknown → `other`, blank → `web`; `channel` returned in every OrderDTO. Owner still comes from the token only. |
| `hxl-demo/force-app/.../HXL_OrderAPITest.cls` | Channel assertions; portal test user now gets `HXL_Customer_Access` assigned (inside `runAs` to avoid MIXED_DML) — without it `WITH USER_MODE` fails FLS on the new field and reports it as the misleading `Variable does not exist: tmpVar1`. 4/4 pass. |
| `hxl-demo/force-app/.../HXL_Customer_Access.permissionset-meta.xml` | FLS on `Channel__c` for site users |
| `hxl-demo/app/server.js`, `app/hxl.js` | `POST /api/orders` reads `X-HXL-Channel` (default `web`) and forwards it to Apex |

**The audit query, ready to paste:**

```sql
SELECT Name, Owner_Contact__r.Name, Channel__c, Total_Amount__c, CreatedDate
FROM HXL_Order__c ORDER BY CreatedDate DESC
```

Rows before today (`ORD-00001`–`00011`) have `Channel__c = null` — they predate the field.
Say so if asked; don't backfill them, the null is honest.
