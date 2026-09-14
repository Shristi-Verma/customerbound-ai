# Track B — Org Context and Findings (Headless Experience Layer)

*Companion to `TRACK_B_SETUP.md`. This file records where real behaviour diverged from the
happy path, and what's already confirmed working. Update it as you go — an entry here should
be something you verified, not something you expect to be true.*

---

## What's confirmed working (per Phase 1)

- `UiWidgetBundle` **hxlOrderCard** deployed successfully, record id `1idg800000001XBAAY`,
  validated by the platform's own schema checker
- The MCP server holds no stored Salesforce credentials and signs in as a named customer
- A live write triggered from the card created a real order (`ORD-00011`), owner Ada Lovelace,
  confirmed by SOQL

**Not yet confirmed:** the widget actually rendering as a visual card inside a real host
(Claude Desktop or otherwise). Everything up to that final hop is verified; that hop itself
is the open item in `TRACK_B_HOST_VERIFICATION.md` §1.

---

## Known deploy blocker: "Managed Content Type ID: bad value for restricted picklist field: JSON"

Encountered when deploying a `UiWidgetBundle` with a minimal composition file. Two things were
tried and produced contradictory results:

| Composition file has... | Error |
|---|---|
| `"type": "JSON"` at the top level | `bad value for restricted picklist field: JSON` |
| That field removed | `Widget JSON must contain a 'type' field` |

**Diagnosis:** "Managed Content Type" belongs to Salesforce CMS/Digital Experiences, not to
widgets natively — its appearance here suggests widget storage sits on top of CMS
content-type infrastructure, and the picklist value `"JSON"` wasn't registered for this org.
**Most likely fix:** Setup → Digital Experiences → confirm it's fully enabled/provisioned,
specifically the *"Allow using standard external profiles..."* setting already known to be
required and easy to miss (see Track A's `HXL_ORG_CONTEXT.md`, divergence 8 — the same
Digital Experiences dependency shows up on both tracks).

**Fill in once confirmed:** exactly which Digital Experiences setting resolved this for your
org, since the fix wasn't independently re-verified after diagnosis in this project's
history — confirm and record the actual resolution here rather than assuming the diagnosis
was the whole fix.

---

## No Setup UI page for widgets

There is no "UI Widgets" list view in Setup, at any point in the object model checked. A
deployed `UiWidgetBundle` is invisible to browsing — an empty search does not mean a failed
deployment. Verify existence only by:
```
sf project retrieve start --metadata UiWidgetBundle:<name> --target-org <alias>
```
or by checking Setup pages for whatever consumes it (an Agentforce action's renderer
configuration, for instance) rather than the widget itself.

---

## Host support is uneven, and Slack has exactly one route

Per the Callout component's own documented support table: Agentforce, Slackbot, ChatGPT,
Claude, and MS Teams are each independently rated (Beta/Planned) **per component**, not
uniformly across the whole widget system. Confirmed specifically:

- **Slack's Block Kit cannot render HXL widgets today** — Salesforce's guide says so
  explicitly. The only Slack route is **Slackbot via MCP Apps**, which is the *same* standard
  Claude Desktop and ChatGPT use, not a different one. So the server built for Claude/ChatGPT
  is the server Slack needs — the difference is only that Slack (like ChatGPT) must reach it
  over a public HTTPS URL.
- Whether a given Slack workspace can attach an MCP App to Slackbot at all is a Slack plan /
  rollout question. **Check it before budgeting hours** (`TRACK_B_SETUP.md` Step 6b). Record
  the answer here: ☐ yes ☐ no — workspace: ______, checked on: ______.
- Check each component's own support table in the Playground's Documentation tab before
  relying on it for a specific host — support level is set per component, not assumed
  platform-wide. A widget can be Claude-safe and Slackbot-unsafe because of one child block.

## How each host reaches the server (verified for Claude Desktop; planned for the others)

| Host | Transport | Status |
|---|---|---|
| Claude Desktop | stdio, launched from `claude_desktop_config.json`, absolute paths | Server verified over stdio with a real MCP client (`mcp/smoke.mjs`); render **not yet confirmed** — Claude Desktop not installed on this machine |
| ChatGPT | Streamable HTTP over public HTTPS, added via Developer Mode → Apps & Connectors | `server-http.mjs` + cloudflared **verified 2026-09-12**: `initialize`/`tools/list`/`sign_in`/`place_order` all succeed through `https://<x>.trycloudflare.com/mcp/chatgpt`, order landed with `Channel__c = chatgpt`. ChatGPT itself not yet connected |
| Slackbot | Same HTTPS endpoint (`/mcp/slack`), registered as an MCP App | Server side verified (order landed with `Channel__c = slack`); Slack not yet connected — gated on workspace availability above |
| Agentforce | CLT `renderer.json` → `@widget/c/hxlOrderCard`; **no MCP server involved** | Not attempted; separate path, proves nothing about the MCP hosts |

Two facts that follow from the table and are easy to forget:

1. **The widget iframe has no network in the host.** The ext-apps runtime is inlined into the
   widget HTML at server start; a `<script src>` to a CDN fails silently with a blank card.
   Verified in Claude's sandbox model; assume the same for ChatGPT and Slack until shown
   otherwise.
2. **A hosted endpoint makes the single-identity server a leak.** `server.mjs` signs in from
   `HXL_DEMO_USER`/`HXL_DEMO_PASSWORD`. Over stdio on a laptop that's one person's laptop.
   Over a public URL it is every ChatGPT/Slack user seeing Ada, with a password in config on
   an internet-facing service. The `sign_in`-per-session tool (`TRACK_B_SETUP.md` Step 6c)
   is a prerequisite for leaving the hosted URL up longer than one screenshot.

---

## Strict server-side validation

The experience layer validates composition JSON server-side, and strictly. Confirmed
constraints from Phase 1: a card accepts at most ten children, and a column rejects a padding
attribute. A public example modelled from elsewhere may not deploy as written — validate
against the actual Playground/Documentation examples, not a remembered or adapted structure.

---

## Two-step identity chain, not one

Track B's differentiated claim only holds if the MCP server's authentication genuinely runs
through Track A's named-user flow end to end. It is possible to build an MCP server that
*looks* identity-scoped but actually authenticates as a fixed service account behind the
scenes — that would quietly undermine the entire "build once, render anywhere, as one
specific person" claim. Explicitly re-verify, per customer:

- The token the MCP server used for a given request traces back to that specific customer's
  login, not a cached admin session
- A second customer's request genuinely produces a second, independent token — not the same
  one reused

This is exactly what the two-identity run (`TRACK_B_HOST_VERIFICATION.md` §4) is designed to prove for the
first time with two real identities, rather than assuming it from Phase 1's single-identity
result.

---

## MCP server architecture (verified from `hxl-experience-layer/mcp/server.mjs`)

- **Stack:** `@modelcontextprotocol/sdk` `McpServer` + `@modelcontextprotocol/ext-apps`
  (`registerAppTool`, `registerAppResource`) + `zod`. Node ≥ 20. Transport: `StdioServerTransport` only.
- **Declares** the `io.modelcontextprotocol/ui` capability extension; serves the widget at
  `ui://widgets/hxl-order-card.html` with the ext-apps runtime **inlined** (read off disk from
  `@modelcontextprotocol/ext-apps/app-with-deps`, rewritten to a `globalThis.ExtApps` global).
- **Tools:** `get_my_orders` (read, `readOnlyHint: true`) and `place_order(amount?)` (write).
  Both carry `_meta.ui.resourceUri` pointing at the widget so the host renders the card.
- **Holds no Salesforce credentials.** Every call does `POST {BFF}/api/login` with the demo
  customer's username/password → HttpOnly session cookie → `GET /api/me` (orders, Contact
  read off the token by Apex) or `POST /api/orders`. One retry on 502, because the site
  domain intermittently fails DNS and the BFF surfaces that as 502.
- **Degrades visibly:** with no BFF or no credentials it returns `SAMPLE` with
  `identityMode: "sample data"` and `isLiveIdentity: false`; the card shows the badge. A
  live tool call returns `identityMode: "named user"` plus a `scopeNote` naming the Contact.
- **Loads `../.env` itself** (no dotenv dependency) so `npm run demo` and a bare
  `node mcp/server.mjs` don't silently fall back to sample data.
- **2026-09-12, v1.1.0:** identity is now per MCP session (`sign_in` / `sign_out` / `whoami`
  tools); `server-http.mjs` adds Streamable HTTP with per-path channel labels; every BFF call
  carries `X-HXL-Channel`, which lands in `HXL_Order__c.Channel__c`. Verified end to end over
  stdio, local HTTP, and a public cloudflared URL — see `TRACK_B_HOST_VERIFICATION.md`.
- **`get_order(lookup)`** added 2026-09-12: one order by Id or ORD-number, no owner filter in
  the chain (MCP → BFF `GET /api/orders/:lookup` → Apex `GET /hxl/orders/<x>` with sharing).
  **First run returned Grace Hopper's order to Ada** — the customer profile had View All on
  the object. Fixed (sharing set + View All off, both in `hxl-demo/force-app`), re-verified:
  Grace's order `found:false` by number and by Id; Ada's own `found:true`. Full write-up in
  `hxl-demo/HXL_ORG_CONTEXT.md` §10. This is the tool the two-identity proof (Step 3.5) uses.
- **`search_orders(query)`** and **`cancel_order(orderNumber)`** added 2026-09-12. Search is
  deliberately unfiltered (the prompt-injection beat): an injected model asking for "every
  customer's orders" gets only the token's own rows — verified, 16 of Ada's, none of Grace's.
  Cancel is the first *update* path: own Submitted → Cancelled, own Shipped → 409, another
  customer's → 404 before any rule runs. The card's second button is now Cancel <latest>.

## Documentation access

Salesforce's own developer documentation for this feature returns 403 to automated/scripted
fetch attempts — plan to read it manually in a browser, the same finding already recorded on
the Track A side.

---

## Open items to fill in as this progresses

- [ ] Confirmed resolution to the Managed Content Type deploy error (see above)
- [ ] MCP server architecture/code reference, once stable
- [ ] `schema.json` / `renderer.json` exact structure used for the Agentforce action → widget
      connection (Step 5 of `TRACK_B_SETUP.md`)
- [ ] Result of Step 7 (host render confirmation) — per host: Claude Desktop / ChatGPT /
      Slack — success or specific failure mode, one screenshot each
- [ ] Whether the **button** (write path) works on each host that rendered
- [ ] Slack workspace: Slackbot MCP Apps available yes/no (see table above)
- [x] `server-http.mjs` + tunnel: public `/mcp` URL answers `initialize` identically to stdio (2026-09-12)
- [x] `sign_in` per-session tool in place before the hosted URL is shared with anyone (2026-09-12)
- [x] `Channel__c` populated from each path — audit SOQL shows `slack`, `chatgpt`, `claude`, owner Ada (2026-09-12, via `smoke.mjs`, not yet via a real host)
- [ ] Result of the two-identity re-verification above
