# Track B Setup — Headless Experience Layer (Widget + MCP)

*The happy-path guide. Follow in order — later steps assume earlier ones actually succeeded,
verified, not just run without error. For where this org's real behaviour diverged from this
guide, see `TRACK_B_ORG_CONTEXT.md` — read that file before repeating any step that failed
for you previously.*

---

## What this builds

A Salesforce record's data, rendered as a real interactive widget on an AI agent surface
(Claude Desktop, ChatGPT, Slack via Slackbot, Agentforce), carrying the identity of one specific named customer rather
than a broad-access integration user. It sits on top of Track A (Headless Identity) — the MCP
server in Step 5 authenticates *as that customer*, using Track A's token flow, not as an
admin or integration user.

```
   Claude Desktop ──stdio──┐
   ChatGPT ──HTTPS─────────┤  MCP tool call (MCP Apps)
   Slackbot ──HTTPS────────┘
              │
              ▼
   Your MCP server ───(named-user token, via Track A)───▶ Salesforce
              │
              ▼
     Renders: hxlOrderCard (UiWidgetBundle)

   Agentforce ──CLT / renderer.json──▶ same UiWidgetBundle (no MCP server involved)
```

---

## Step 1 — Enable the Headless Experience Layer

**Do:** Setup → Quick Find → **"Headless Experience Layer Settings"** → accept the beta terms
→ toggle on.

**Target:** Confirms your org is on API 67.0+ and the beta feature is active. This is a
one-time, org-wide switch — not per-project.

---

## Step 2 — Set up your local project

**Do:**
- Install/update Salesforce CLI: `sf update` (do this even if already installed — this
  metadata type is new enough that an older CLI may not fully recognize it)
- Create or open an SFDX project
- Authorize it against your org: `sf org login web --alias <your-alias>`
- Confirm `sfdx-project.json` has `"sourceApiVersion"` set to `"67.0"` or higher

**Target:** `sf org list` shows your org connected and authorized under the alias you'll use
for every command below.

---

## Step 3 — Compose the widget in the HXL Playground first

**Do not** write any project files yet. Open the **HXL Playground**, browse components, and
build your widget declaratively:

- Start with something in the **Beta** tier, not "Coming soon" — check the badge next to each
  component before relying on it
- Use the **Preview** toggle to check how the same JSON renders across host previews
  (Agentforce, ChatGPT-style, Claude-style, Slackbot). Slack is reachable only through
  Slackbot's MCP Apps path — Block Kit does not render HXL widgets — so check the **Slackbot**
  column in each component's support table specifically (see `TRACK_B_ORG_CONTEXT.md`)
- Check the **Documentation** tab for your chosen component, not just the Editor tab — it
  typically shows a complete, correct example, which is more reliable than hand-editing a
  fragment

**Target:** A composition that previews correctly across at least two host previews, with the
exact JSON copied somewhere safe before you move to Step 4.

---

## Step 4 — Create the real widget bundle and deploy

**Do:** Create this exact structure in your project (folder name and file names must match):

```
force-app/main/default/uiWidgets/
  └── <widgetName>/
        ├── <widgetName>.json
        └── <widgetName>.uiwidget-meta.xml
```

**`<widgetName>.json`** — the composition file. Every real widget bundle needs a root
wrapper whose `definition` is literally `"tile/widget"`, with your actual component nested
inside `children`:

```json
{
  "definition": "tile/widget",
  "children": [
    { "...": "your component's attributes/definition from the Playground" }
  ]
}
```

**`<widgetName>.uiwidget-meta.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<UiWidgetBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Your Widget Label</masterLabel>
    <description>What this widget shows.</description>
    <widgetType>JSON</widgetType>
</UiWidgetBundle>
```

**Deploy:**
```
sf project deploy start --metadata UiWidgetBundle:<widgetName> --target-org <your-alias>
```

**Target:** Deploy reports success. **Then verify independently** — there is no Setup UI page
to browse widgets, so confirm with:
```
sf project retrieve start --metadata UiWidgetBundle:<widgetName> --target-org <your-alias>
```
If the retrieve succeeds and matches what you deployed, it's genuinely live in the org.

---

## Step 5 — Connect a Salesforce action's output to the widget

This is what turns a static widget into one that shows real data.

**Do:** Create a **Custom Lightning Type (CLT)** for the action whose output you want
rendered. At minimum it needs:
- `schema.json` — describes the shape of the structured data your action returns
- `renderer.json` — at the CLT folder's root, alongside `schema.json`, pointing at your widget
  bundle: `@widget/c/<widgetName>`

**Fill in from your own build (not documented here):** the exact `schema.json` field
structure for your specific Apex action's output shape. Follow Salesforce's own **"Use HXL
Widgets as Agentforce Action Output"** guide's worked example directly for the precise
syntax — treat anything reconstructed from memory here as a sketch, not a copy-paste source,
per the lesson already learned once this session about guessed-at syntax costing real time.

**Target:** An Agentforce action's structured output renders as your widget, with real field
values, inside Agentforce Builder's own preview — before attempting Step 6.

---

## Step 6 — Build the MCP server for MCP-based hosts

Agentforce (Lightning-native) can consume the CLT/renderer path from Step 5 directly. **Claude
and ChatGPT cannot** — per the official docs, *"to use an HXL widget on channels that support
MCP, you must create a custom MCP server."* This is the piece that carries Track A's
named-user identity into the widget.

**Do:**
- Your MCP server authenticates as a specific customer using Track A's headless login flow
  (not as an admin, not as a broad-access integration user) — this is the entire point of
  combining the two tracks
- The server exposes a tool that, when called, fetches that customer's data (via the same
  Contact-scoped Apex REST pattern as Track A) and returns it wrapped so the calling host can
  render your deployed widget

**What exists today:** `hxl-experience-layer/mcp/server.mjs` — see `TRACK_B_ORG_CONTEXT.md`
"MCP server architecture" for the verified structure. It speaks **stdio only** and signs in
as **one customer from env vars**. Both of those are fine for Claude Desktop on a laptop and
both have to change for the other hosts, below.

**Target:** The MCP server, when queried directly (independent of any chat client), returns
correctly-scoped data for a specific named customer — verified before ever involving a chat
host, so you know a rendering failure later is about the host, not the server.

### Step 6a — Claude Desktop: stdio, local (no hosting needed)

**Do:** `node scripts/print-claude-config.mjs` → paste the block into
`%APPDATA%\Claude\claude_desktop_config.json` → **fully quit and reopen** Claude Desktop (it
reads that file only at launch). Absolute paths only; no `mcp-remote`, no CDN scripts in the
widget HTML (the widget iframe has no network — the ext-apps runtime is already inlined at
server start for this reason).

**Target:** `get_my_orders` and `place_order` appear in Claude Desktop's tool list for a new
chat. Seen in the list, not inferred.

### Step 6b — ChatGPT and Slack: the same server, hosted over HTTPS

Both hosts need a public URL speaking **Streamable HTTP**. Neither can launch a local process.

**Do:**
1. Add a second entry point (`mcp/server-http.mjs`) that calls the same `createServer()` and
   mounts it on `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` at `/mcp`,
   on e.g. port 8787. No tool or resource code changes.
2. Expose it: `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`. Neither
   is installed on this machine yet. Free-tier URLs rotate on every restart — re-paste into
   each host after any restart.
3. **ChatGPT:** Settings → Apps & Connectors → enable Developer Mode → Create → the public
   `/mcp` URL, no auth for now. Toggle the connector on in a new chat.
4. **Slack:** first confirm the workspace can attach an MCP server / MCP App to Slackbot at all
   (workspace admin → Slackbot / AI settings). This is a Slack plan and rollout question. If
   it can't, stop — record it in `TRACK_B_ORG_CONTEXT.md` and don't substitute Block Kit,
   which cannot render the widget. If it can, register the same `/mcp` URL.

**Target:** `initialize` and `tools/list` return the same result over the public URL (curl
from a phone hotspot) as over stdio. ChatGPT's connector lists both tools. Slack: a written
yes/no on availability, with a screenshot of the settings page.

**Alternative, deliberately not used:** the org already has the `McpServerDefinition` type
for Salesforce-hosted MCP servers. It would remove the laptop, but the server would then run
inside Salesforce under Salesforce's identity — the exact pattern this POC avoids. Mention it
as a choice made, not an option missed.

### Step 6c — Per-session identity (required before anyone but you touches the hosted URL)

A hosted endpoint that signs in from `HXL_DEMO_USER`/`HXL_DEMO_PASSWORD` shows **that one
customer to every ChatGPT and Slack user**, with a password sitting in config on an
internet-facing service. Tolerable for one screenshot on a tunnel you tear down afterwards;
not for anything else.

**Do:** add a `sign_in(username, password)` tool that logs in through the Track A BFF and
stores the returned session cookie keyed by the MCP session id. `get_my_orders` and
`place_order` use that session's cookie and return a clearly-labelled "not signed in" card
otherwise. Remove the demo credentials from the hosted config. ~30 lines. For local Claude
Desktop, two config entries with different env is an acceptable zero-code stand-in.

**Target:** Two sessions signed in as two people → the BFF session store holds two entries
with two different Contact Ids. Verified by reading the store, not the UI.

---

## Step 7 — Confirm rendering in a real host

**Do, in this order:**
1. **Claude Desktop** (Step 6a) — new chat, "show me my orders". Must pass before hosting
   anything; if the widget doesn't render in the simplest host, a tunnel won't help.
2. **ChatGPT** (Step 6b) — same question, connector on.
3. **Slack** (Step 6b, only if availability was a yes) — DM Slackbot, same question.

**Target, per host:** The widget renders as an actual visual card in the chat, with the
green `named user` badge (not `sample data` — the badge is the tell) and data matching a
direct SOQL check against the org — not a text description of a card, not raw JSON. One
screenshot per host, saved. For any host that didn't render, one line in
`TRACK_B_ORG_CONTEXT.md` saying what it did instead. This is the step this project's Phase 2
plan calls "not yet confirmed" — treat it as the real milestone it is, not a formality.

**Also on each host that rendered:** click **Place another order**. The write path is where
host sandbox/CSP differences surface first. "Renders but the button is dead on host X" is a
finding — capture the console, record it, don't hide it.

---

## Step 8 — Prove the identity claim, not just the rendering

Getting a card to render is necessary but not sufficient. Confirm specifically:
- The MCP server holds **no** stored Salesforce admin/integration credentials — it obtains a
  token per customer, live
- A record created via the widget's action button is attributable, in Salesforce, to that
  specific customer — not to a shared service account
- Two different customers, queried through the same server, see only their own data (this is
  the two-identity run in `TRACK_B_HOST_VERIFICATION.md` §4 — Track B's half of that combined proof)

**Make the audit entry real, not narrated:** add `Channel__c` (picklist: `web`, `claude`,
`chatgpt`, `slack`) to `HXL_Order__c`. The MCP server sends an `X-HXL-Channel` header per
transport (stdio → `claude`; the HTTP entry point reads it from the host's user-agent or a
per-connector config); the BFF passes it to Apex; the web app sends `web`. Then one query
does the whole job:

```sql
SELECT Name, Owner_Contact__r.Name, Channel__c, CreatedDate
FROM HXL_Order__c ORDER BY CreatedDate DESC
```

**Also worth adding:** a `get_order(orderNumber)` tool → `GET /api/orders/:id` on the BFF →
Apex with sharing. Asking Ada's chat for Grace Hopper's order number and getting nothing back
is the sharing proof done *from the agent surface*, on every host, instead of from a curl.

**Target:** You can point at a specific record in Salesforce and say, correctly, "this exists
because of a click that named customer made on a non-Salesforce surface" — with an owner field
**and a channel value** to back it up, not narration alone. Ideally two rows from two
different channels, same owner.
