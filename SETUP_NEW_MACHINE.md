# Setting up this folder on another machine

*Copy `D:\personal` (both project folders and the `.md`/`.docx` files) to the new device,
then follow this top to bottom. ~30 minutes if the org is already set up (it is — everything
here targets the existing Dev Edition org, alias `hxl`). Nothing in this file changes the
org; it only connects a new laptop to it.*

---

## 0 · What you are copying

```
personal/
├── hxl-demo/                 Track A — Headless Identity BFF + Apex + org metadata
│   ├── app/                  Node BFF (server.js, hxl.js, public/)
│   ├── force-app/            Apex, object, field, permset, profile, sharing set
│   ├── scripts/              setup.ps1, verify-setup.ps1, seed-demo-data.apex
│   ├── .env                  ← SECRETS. Copy it, or recreate from .env.example
│   └── .sf/ .sfdx/           local CLI config (safe to copy; re-created on login anyway)
├── hxl-experience-layer/     Track B — widget + MCP server
│   ├── mcp/                  server.mjs, server-http.mjs, smoke.mjs, widgets/, node_modules/
│   ├── force-app/            the UiWidgetBundle
│   ├── scripts/              print-claude-config.mjs, preview.mjs
│   └── .env                  ← SECRETS (demo customer password)
└── *.md / *.docx             all the documentation
```

**Do not copy `node_modules/`** — reinstall them (Step 3). They are OS-specific and large.
**Do copy both `.env` files** — or you will need the External Client App's consumer secret
and the demo customer's password from wherever they were first recorded.

---

## 1 · Install the tools

Run in **PowerShell as Administrator**, then open a fresh terminal so PATH refreshes.

| Tool | Command | Verify |
|---|---|---|
| Node.js 20+ (24 is what this was built on) | `winget install OpenJS.NodeJS.LTS` | `node -v` → `v2x.x.x` |
| Salesforce CLI | `npm install -g @salesforce/cli` | `sf --version` |
| cloudflared (only for ChatGPT / Slack hosting) | `winget install --id Cloudflare.cloudflared -e` | `cloudflared --version` |
| Git (optional, for Git Bash) | `winget install Git.Git` | `git --version` |
| Claude Desktop (for the Claude host render) | download from claude.ai/download | opens |
| Codex CLI (optional, OpenAI tool-contract check) | `npm i -g @openai/codex` | `codex --version` |

If `sf` was already installed: `sf update` — this metadata (`UiWidgetBundle`, `SharingSet`
at API 67) is new enough that an old CLI mis-validates it silently.

---

## 2 · Connect the org

```powershell
cd D:\personal\hxl-demo
sf org login web --alias hxl --set-default
```

Log in as the admin (`shristipatel63.c30cb1506927@agentforce.com` — see `HXL_ORG_CONTEXT.md`
"The org"). Then:

```powershell
sf org list                                   # hxl → Connected
sf org display --target-org hxl               # note Instance URL and API version 67.0
```

`hxl-experience-layer` uses the same alias (`sfdx-project.json` there points at it too), so
one login covers both.

---

## 3 · Install dependencies

```powershell
cd D:\personal\hxl-demo
npm install

cd D:\personal\hxl-experience-layer\mcp
npm install
```

That's it — the root of `hxl-experience-layer` has no dependencies of its own; the MCP
server and the smoke client both live in `mcp/`.

---

## 4 · Environment files

### `hxl-demo\.env`

If you copied it, skip. Otherwise `copy .env.example .env` and fill in:

| Key | Where it comes from |
|---|---|
| `SF_SITE_URL` | `https://orgfarm-4d60b0d1f4-dev-ed.develop.my.site.com/hxlstore` (the Experience Cloud site, **not** the my.salesforce.com login URL) |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | Setup → External Client Apps → `HXL_layer` → Settings → OAuth → consumer key/secret |
| `SF_REDIRECT_URI` | `http://localhost:3000/callback` — must match the app's registered callback exactly |
| `SF_SCOPES` | `api refresh_token openid` |
| `SF_INIT_AUTH_FLOWS` | leave empty (the three blocked flows — see `HXL_ORG_CONTEXT.md`) |
| `PORT` | `3000` |
| `HXL_DEBUG` | `1` for the demo terminal, so the wire log shows |

### `hxl-experience-layer\.env`

| Key | Value |
|---|---|
| `HXL_BFF_URL` | `http://localhost:3000` |
| `HXL_DEMO_USER` | `ada.hxl@hxlpoc.demo` |
| `HXL_DEMO_PASSWORD` | Ada's site password |
| `HXL_MCP_PORT` | `8787` |
| `HXL_ALLOW_ENV_IDENTITY` | `0` (only `1` for a throwaway tunnel screenshot — every hosted session would then act as Ada) |

---

## 5 · Verify the org is in the state the docs assume

```powershell
cd D:\personal\hxl-demo
powershell -ExecutionPolicy Bypass -File scripts\verify-setup.ps1 -TargetOrg hxl
```

Then the three checks the script can't do:

```powershell
# the widget is deployed (no Setup UI for this — CLI only)
sf org list metadata --metadata-type UiWidgetBundle --target-org hxl        # → hxlOrderCard

# sharing is real: View All must be false on every row (see HXL_ORG_CONTEXT.md §10)
sf data query --target-org hxl -q "SELECT Parent.Name, Parent.Profile.Name, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE SobjectType = 'HXL_Order__c' AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE Assignee.Username = 'ada.hxl@hxlpoc.demo')"

# Apex tests
sf apex run test --class-names HXL_OrderAPITest --target-org hxl --wait 10 --result-format human   # → 4/4 Pass
```

If the org ever drifts (someone re-enables View All, deletes the sharing set, etc.), the
source of truth is in `force-app/` on both sides — redeploy:

```powershell
cd D:\personal\hxl-demo             ; sf project deploy start --source-dir force-app --target-org hxl
cd D:\personal\hxl-experience-layer ; sf project deploy start --source-dir force-app --target-org hxl
```

---

## 6 · Prove the software, before any host

Three terminals.

```powershell
# T1 — Track A BFF
cd D:\personal\hxl-demo
npm start                                  # → HXL demo on http://localhost:3000
```

Open http://localhost:3000, log in as `ada.hxl@hxlpoc.demo`, see 15+ orders and **no**
$9,999 order. That's Track A.

```powershell
# T2 — MCP over stdio (what Claude Desktop will do), as a real MCP client
cd D:\personal\hxl-experience-layer
npm run smoke                              # → Ada Lovelace | named user | $… across N orders
node mcp/smoke.mjs --get-order ORD-00003   # → found:false   (Grace Hopper's — sharing refused it)
node mcp/smoke.mjs --get-order ORD-00001   # → found:true    (Ada's own)
node mcp/smoke.mjs --search ""              # → all visible orders, ownerFilterApplied=false, none Grace's
node mcp/smoke.mjs --cancel ORD-00003       # → "not visible"  (Grace's; sharing, before any rule)
```

```powershell
# T3 — hosted MCP (what ChatGPT / Slack will use)
npm run mcp:http                           # → http://localhost:8787
# in T2:
node mcp/smoke.mjs http://localhost:8787/mcp/chatgpt --sign-in ada.hxl@hxlpoc.demo <pw> --place-order
# → Signed in as Ada … channel "chatgpt" … Created ORD-000xx … via chatgpt
```

Then in the org:

```sql
SELECT Name, Owner_Contact__r.Name, Channel__c, CreatedDate FROM HXL_Order__c ORDER BY CreatedDate DESC LIMIT 5
```

The new row says `chatgpt`. If all of that is green, the machine is equivalent to the
original one. Everything from here is host wiring — `TRACK_B_HOST_VERIFICATION.md`.

---

## 7 · Host wiring (per host, only the ones you'll show)

| Host | One-liner | Detail |
|---|---|---|
| Claude Desktop | `npm run config` → paste into `%APPDATA%\Claude\claude_desktop_config.json` → **fully quit** and reopen Claude | `TRACK_B_HOST_VERIFICATION.md` §1 |
| ChatGPT | `cloudflared tunnel --url http://localhost:8787` → Settings → Apps & Connectors → Developer mode → add `https://<tunnel>/mcp/chatgpt` | §2 |
| Slack | same tunnel, `https://<tunnel>/mcp/slack`, **after** confirming the workspace has Slackbot MCP Apps | §3 |
| Local preview (no host at all) | `npm run demo` — a stand-in host on `localhost:4321`, buttons work, proves everything except a real host render | `hxl-experience-layer/README.md` |

---

## 8 · Things that bite on a fresh Windows machine

- **`Start-Process npm` doesn't start anything** — `npm` is a `.cmd` shim. Use a real
  terminal or `node app/server.js` / `node mcp/server-http.mjs` directly.
- **Claude Desktop needs absolute paths and native `node`** in its config. `print-claude-config.mjs`
  resolves them for the machine it runs on — rerun it on the new device, don't copy the old JSON.
- **The site's DNS blips.** Occasionally the first login fails with a 502 and the next
  succeeds. The MCP server retries once; the web app just needs a second click.
- **Tunnel URL rotates on every `cloudflared` restart.** Re-paste it into ChatGPT/Slack.
- **`sf` "Status: -" in a non-interactive shell** is the progress spinner, not a failure —
  add `--json` or `--wait` and read the result.
- **A fresh terminal opened before an install** won't see the new PATH. Open another one.
- **Two users on the laptop** (there are both `Tanishq` and `LENOVO` profiles in this
  machine's PATH): install tools for the user who will run the demo.
