# HXL — Headless Experience Layer (Track B)

> **Naming.** This is the Salesforce **Headless Experience Layer (HXL)** — the Beta where you
> describe a UI once as Mosaic JSON and Slack, Agentforce, ChatGPT or Claude render it
> natively. It is **not** Salesforce **Headless Identity**, which lives in `../hxl-demo/`
> despite that folder's misleading name. See `../README.md` for the map.

One widget definition, deployed to Salesforce, rendered by any MCP host — and the data
inside it belongs to **one named customer**, because the identity half comes from Track A.

```
  Claude / Slack / Agentforce          this repo renders the widget
         │  MCP tool call: get_my_orders
         ▼
    mcp/server.mjs  ─────────▶  Track A BFF  ─────────▶  Salesforce
    (no SF credentials)         named-user token         sharing enforced
```

---

## Status — what actually works (12 September 2026)

| Piece | State |
|---|---|
| `UiWidgetBundle` **deployed to the org** | ✅ `hxlOrderCard`; second button is now **Cancel <latest order>** |
| Mosaic JSON validated by the platform | ✅ passes the server-side schema validator |
| MCP server **v1.1.0** — 8 tools | ✅ `sign_in` `sign_out` `whoami` `get_my_orders` `get_order` `search_orders` `cancel_order` `place_order`; verified with a real MCP client (`mcp/smoke.mjs`) |
| **Identity per chat session** | ✅ sessions keyed by the host's session id; only the BFF cookie is held; env-var identity on stdio only |
| **Streamable HTTP** for ChatGPT / Slackbot | ✅ `mcp/server-http.mjs` on `:8787`; `/mcp/chatgpt`, `/mcp/slack` set the channel; verified end to end through a public cloudflared URL |
| **Live named-user data through Track A** | ✅ Contact `003g800000fQI05AAG`, 16 orders — no user id passed by the model |
| **Sharing enforced at the platform** | ✅ `get_order` asks by Id with **no owner filter** → Grace Hopper's $9,999 order is `found:false`. *Was `found:true` until 12 Sep — see finding 8* |
| **Prompt injection contained** | ✅ `search_orders` is deliberately unfiltered; "list every customer's orders" → 16 rows, all Ada's |
| **Write-back with audit** | ✅ `place_order` / `cancel_order` land as the customer with `Channel__c` = `claude` / `chatgpt` / `slack` |
| Rendered inside Claude Desktop | ⬜ **not confirmed — Claude Desktop not installed on this machine.** Everything up to the host is verified |
| Rendered in ChatGPT / Slack | ⬜ server path verified through the tunnel; ChatGPT connector not yet added; Slack gated on Slackbot MCP Apps availability (Block Kit cannot render HXL widgets) |
| Rendered in Agentforce | ⬜ not attempted — CLT/renderer path, no MCP server |

Per-host procedure and targets: `../TRACK_B_HOST_VERIFICATION.md`. New machine: `../SETUP_NEW_MACHINE.md`.

The bridge is the part worth showing. A tool call returns this, and every field came from
Salesforce sharing rather than from the agent's discretion:

```json
{
  "customerName": "Ada Lovelace",
  "contactId": "003g800000fQI05AAG",
  "orderCount": 16,
  "totalValue": "$890.28 across 16 orders",
  "identityMode": "named user",
  "isLiveIdentity": true,
  "scopeNote": "Apex read Contact 003g800000fQI05AAG off the access token. No user id was passed by this server or by the model. Orders belonging to any other Contact are not in this response."
}
```

Grace Hopper's $9,999 order is not in that total — and, since 12 September, that is because
the token genuinely cannot see it: `get_order("ORD-00003")` with no owner filter returns
`found:false`. Before the fix in finding 8 the list above was scoped by a WHERE clause and
the platform would have handed the order over on request.

---

## Why this combination matters

HXL answers *where the UI shows up*. It does not answer *who is asking*.

The default agent integration runs as an **integration user**: one credential with broad
visibility, where the agent decides what to reveal. A prompt-injected agent then inherits
everything that user can see. That is the design security teams reject.

This server holds **no Salesforce credentials at all**. It signs in through the Track A
Headless Identity BFF as a named customer and can only ever see what that Contact can see.
The enforcement is in `HXL_OrderAPI.cls`, which reads the Contact off the token and never
accepts a user id from the caller.

**Build once, render anywhere — as one specific person.**

---

## What's in here

| Path | What it is |
|---|---|
| `force-app/main/default/uiWidgets/hxlOrderCard/hxlOrderCard.json` | The Mosaic composition. `tile/card`, `tile/badge`, `tile/callout`, `{!$attrs.*}` bindings, `meta.if` conditionals |
| `.../hxlOrderCard/schema.json` | Attribute contract, using `lightning:type` annotations |
| `.../hxlOrderCard/hxlOrderCard.uiwidget-meta.xml` | The `UiWidgetBundle` metadata wrapper (`widgetType: JSON`) |
| `mcp/server.mjs` | The MCP app: registers the widget resource and two tools — `get_my_orders` (read) and `place_order` (write) — and bridges to Track A |
| `mcp/widgets/hxl-order-card.html` | How the card paints inside Claude. The ext-apps runtime is inlined — see the CDN note below |
| `scripts/print-claude-config.mjs` | Prints the exact `claude_desktop_config.json` block with real absolute paths |
| `scripts/preview.mjs` | **Stands in for an MCP host.** Serves the widget on `localhost:4321` and forwards its `callServerTool()` to the real server, so the buttons work exactly as they would in Claude. Proves the tool contract, the live data, the markup and the write round trip — not that a real host renders it |
| `ui-shots/widget-preview.png` | The card with live Track A data |
| `ui-shots/widget-before-click.png` / `-after-click.png` | The order count changing when the button is clicked |

---

## Run it

```powershell
# 1. Start Track A first, or the card falls back to sample data
cd ..\hxl-demo
npm start

# 2. Install and wire up this side
cd ..\hxl-experience-layer\mcp
npm install
cd ..
node scripts/print-claude-config.mjs
```

Paste the printed block into `%APPDATA%\Claude\claude_desktop_config.json`, **fully quit and
reopen Claude Desktop** (it reads that file only at launch), then ask *"show me my orders"*.

Deploy the widget to the org:

```powershell
sf project deploy start --source-dir force-app --target-org hxl
```

---

## The demo path today: local preview

For a live demo this is the route that cannot fail on stage — no host install, no network
to a third party, real org data:

```powershell
cd ..\hxl-demo && npm start          # Track A, in its own terminal
cd ..\hxl-experience-layer
npm run demo                          # renders preview.html and opens it
```

This starts a small server on `localhost:4321` that stands in for an MCP host — it forwards
the widget's tool calls to the real MCP server, so **the buttons work**. `npm run preview`
does the same without opening a browser. Ctrl+C stops it.

Clicking **Place another order** writes a real `HXL_Order__c` as Ada and the count goes up
in front of the room. That is the strongest single beat in the demo: a button in a chat-style
card creating a Salesforce record as a named customer, with sharing enforced.

If Track A isn't running the card still renders, labelled `sample data` instead of the green
`named user` — a dead BFF degrades visibly rather than crashing. **The badge is your tell.**

**What this proves:** the tool contract, the live named-user data, the card markup, and the
write round trip. **What it does not prove:** that a real host renders it. Be precise about
that distinction when presenting — it's the difference between a credible engineer and an
overclaiming one.

---

## Getting this into Slack — what it actually takes

Server side built (12 Sep); Slack itself not yet connected. Three things stand between here
and Slack, and the first is a hard constraint worth knowing before you design around it.

### 1. Block Kit does not render HXL widgets today

Per the Salesforce developer guide: HXL widgets are compatible with the **MCP Apps**
standard and work in any MCP Apps-compatible agent — *"however, HXL widgets don't currently
render when using Block Kit for Slackbot."*

So there are two different Slack paths and only one of them can show this card:

| Path | Renders the widget? |
|---|---|
| Slackbot via **MCP Apps** | Yes — same standard Claude Desktop uses |
| Slack via **Block Kit** | **No** — not currently supported |

Design for the MCP path. If someone asks for Block Kit blocks, that's a different build.

### 2. The MCP server has to be hosted

`mcp/server.mjs` speaks **stdio** and runs on your laptop. Slack cannot reach a process on
your laptop. **Done:** `mcp/server-http.mjs` + `cloudflared tunnel --url http://localhost:8787`
gives Slackbot a public `https://…/mcp/slack`. The longer-term options:

- **Salesforce Hosted MCP Servers** — the `McpServerDefinition` metadata type is already
  available in this org and still unused. This is the direction that removes the laptop from
  the architecture entirely.
- **Self-hosted HTTPS MCP endpoint** — more control, but now you own an internet-facing
  service that holds a route to customer data.

### 3. The identity bridge needs rethinking — and this is the interesting problem

**Done, 12 Sep:** the server no longer signs in as one hardcoded customer per process.
Identity is per MCP session (`sign_in` tool); over HTTP the env-var demo customer is refused
unless `HXL_ALLOW_ENV_IDENTITY=1`. What remains is the *proper* version of the same thing:

Hosted, the question becomes *"which Salesforce customer is this Slack user?"* — you need a
mapping from Slack identity to Salesforce Contact, and a token per user rather than one
shared token. Track A's BFF already does the token custody half; what's missing is the
per-user binding.

**Worth saying out loud:** this is the same "identity broker" problem in a new costume, and
it is the genuinely novel part of this whole project. Salesforce's own material covers
rendering across channels; it does not hand you per-user identity on those channels. If you
want a follow-on piece of work with real substance, this is it.

---

## Findings — things the docs don't tell you

Same standard as Track A's `HXL_ORG_CONTEXT.md`: only what was verified against the live org.

### 1. `developer.salesforce.com` 403s automated fetch

The entire HXL developer guide is unreachable to any scripted client — the same wall Track A
hit. Everything here was reconstructed from a public example repo plus the org's own error
messages. Budget for reading the docs by hand in a browser.

### 2. The platform validates Mosaic JSON server-side, strictly, and the errors are excellent

A deploy is not a rubber stamp. Two rules that cost a deploy cycle, neither of which appears
in the public example this was modelled on:

```
The block tile/card at the path $.widgetBody.children[0].children[0]
can have only 10 children.

You can't add the padding property defined at
$.widgetBody.children[0].attributes.padding because the
`additionalProperties` keyword value is set to false.
```

So: **`tile/card` caps at 10 children**, and **`tile/column` does not accept `padding`** —
only `gap`. The fix is to nest a `tile/column` inside the card and group related blocks, which
is better structure anyway. Errors name the exact JSON path, which makes this pleasant to
debug — unlike Track A's identity wall, where everything failed with `authentication failure`.

### 3. The public example's JSON would not deploy as-is

The widget in `Lakshmikanth-Paruchuru/hxl-agentic-experience-layer` puts `padding` on a
`tile/column` and 13 children in a `tile/card`. Written against API 65; this org is 67. Treat
any HXL example older than your org's API version as a sketch, not a spec.

### 4. Claude Desktop needs native stdio and absolute paths

No CDN, no `mcp-remote`, no relative paths. The widget iframe is sandboxed without network
access, so the ext-apps runtime is read off disk and inlined into the HTML at server start.
A `<script src>` to a CDN fails silently — you get a blank card and no error.

### 5. There is no "Widget" node in Setup

Quick Find for "Widget" returns nothing in this org, even with `hxlOrderCard` deployed and
holding a real record id (`1idg800000001XBAAY`). The only related entries are
`Agentforce Studio`, `Agent Config`, `Agent Analytics (Beta)` and `Get Started with
Agentforce`.

So a deployed widget is **invisible to the Setup UI**. Verify it from the CLI instead:

```powershell
sf org list metadata --metadata-type UiWidgetBundle --target-org hxl
```

Don't read an empty Quick Find as a failed deploy — they are unrelated.

### 6. The platform rewrites your JSON on save

Retrieving `hxlOrderCard` back out of the org returns something larger than what went in
(4,776 bytes vs 4,286). On save the platform:

- adds a `"title"` derived from `masterLabel`
- stamps every block with a stable `"id"` UUID
- expands defaults it never asked for — `align: "stretch"`, `width: "auto"`,
  `maxWidth: "auto"` on columns and cards

So the file on disk and the file in the org are **not byte-identical**, and a naive
`retrieve` will show your source control a diff on every round trip. Deploy from disk as
the source of truth; treat a retrieve as inspection only.

### 7. `UiWidgetBundle` and `McpServerDefinition` were both already available

Present as deployable metadata types in a plain Developer Edition org at API 67, with no
special enablement request. Nothing had ever been deployed with them before this project —
`hxlOrderCard` is the first.

---

### 6. Returning `null` from an Apex REST method on 404 yields a non-JSON body

The BFF read it as "answered with HTML, not JSON — wrong host". Return an empty DTO with the
status code set instead.

### 7. One identity per process becomes a leak the moment the server is hosted

Over stdio, `HXL_DEMO_USER` is one laptop's customer. Over a public URL it is every host user
seeing Ada. Hence per-session `sign_in`, and env identity off on HTTP by default.

### 8. "View All" on the customer profile was silently defeating the sharing claim

The **HXL customer** profile had *View All Records* on `HXL_Order__c`. View All bypasses
sharing entirely, so every earlier "sharing proof" was really the `WHERE Owner_Contact__c`
filter in `getMyOrders`. The first tool that asked **by Id with no filter** (`get_order`)
returned Grace Hopper's $9,999 order to Ada. Fixed with a Sharing Set + View All off (both in
`../hxl-demo/force-app`), re-verified from the agent surface. Full write-up:
`../hxl-demo/HXL_ORG_CONTEXT.md` §10. *A sharing claim is only real if something asks without
filtering and is refused.*

## Next

1. **Confirm a real host render.** Everything up to the host is verified; that last hop is
   not. Claude Desktop is the shortest route but is not installed on this machine.
2. **Try a second surface** — Agentforce preview or Slack — to make "render anywhere" a shown
   fact rather than a claim.
3. **`McpServerDefinition`.** This server runs locally over stdio. The org-hosted path is the
   metadata type sitting unused, and would remove the laptop from the demo.
4. ~~A negative-path tool.~~ Built: `get_order`, `search_orders`, `cancel_order` — see the
   status table and `../PRESENTATION.md` for the demo beats they enable.
