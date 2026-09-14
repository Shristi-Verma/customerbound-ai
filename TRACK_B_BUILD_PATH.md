# Track B — Build Path (8 steps, plus what a POC needs around them)

*The eight-step happy path, one checkable target each. Steps 6 and 7 are widened to cover
three hosts — Claude Desktop, ChatGPT, Slack — because "render anywhere" is only a shown fact
once it has been shown on more than one vendor's surface. Detail for each step lives in
`TRACK_B_SETUP.md`; divergences in `TRACK_B_ORG_CONTEXT.md`.*

---

## 1 · Enable HXL in the org
Setup → Quick Find **"Headless Experience Layer Settings"** → accept beta terms → toggle on.
One-time, org-wide. Confirms the org is on API 67.0+.

**Target:** the toggle reads on *after a page reload*, not just after clicking — this org's
Setup UI has silently failed to persist toggles before (Track A, divergence list).

## 2 · Set up the local project
`sf update`, authorize the SFDX project against the org, confirm `sourceApiVersion` is
`67.0`+ in `sfdx-project.json`. This is new enough metadata that an outdated CLI silently
mis-validates it.

**Target:** `sf org list` shows the alias; `sf org list metadata --metadata-type UiWidgetBundle`
returns without error (empty is fine — an error means the CLI doesn't know the type yet).

## 3 · Compose and preview the widget in the Playground
Don't write project files yet. Build the widget declaratively in the HXL Playground, Beta-tier
components only. Use the preview toggle across at least two host previews before copying
anything into a real project.

**Target:** the same JSON previews correctly in two hosts, and each component's own
Documentation-tab support table lists **Claude, ChatGPT and Slackbot** at Beta — support is
rated per component, not platform-wide, so a widget can be Slack-safe or not based on one
child block.

## 4 · Build the real widget bundle and deploy it
`uiWidgets/<name>/<name>.json` (root wraps the component in `"definition": "tile/widget"`)
plus `<name>.uiwidget-meta.xml`. Deploy with
`sf project deploy start --metadata UiWidgetBundle:<name>`. There's no Setup UI page to
browse it — verify with a retrieve, not a search.

**Target:** the retrieve comes back. Expect it to be *larger* than what went in (platform adds
`title`, block `id`s and default `align/width` values) — that's normal, not corruption.

## 5 · Wire a Salesforce action's output to the widget
Create a Custom Lightning Type with `schema.json` (the shape of the action's output) and
`renderer.json` pointing at `@widget/c/<name>`. Test inside Agentforce Builder's own preview
before going further — this proves real data can reach the widget at all.

**Target:** Agentforce preview shows the card with real field values from an Apex action.
**This is the Agentforce path.** It does not carry over to Claude, ChatGPT or Slack — those
go through Step 6.

## 6 · Build the MCP server — and host it for the hosts that need it
Agentforce consumes the CLT path directly. Claude, ChatGPT and Slack cannot — they require a
custom MCP server that authenticates and fetches data on the caller's behalf, and serves the
widget as an **MCP Apps** resource. Test the server standalone, independent of any chat
client, before involving a real host.

The three hosts differ in *how they reach the server*, not in what the server is:

| Host | Reaches the server via | What you need |
|---|---|---|
| **Claude Desktop** | Launches it locally over **stdio** | `claude_desktop_config.json` entry with absolute paths; fully restart Claude Desktop after editing |
| **ChatGPT** | A public **HTTPS** URL, Streamable HTTP | A second entry point mounting the same server on `StreamableHTTPServerTransport`, exposed via `cloudflared`/`ngrok`; ChatGPT Developer Mode → Apps & Connectors → add URL |
| **Slack** | A public **HTTPS** URL, via **Slackbot MCP Apps** | Same hosted endpoint as ChatGPT, registered with Slackbot. **Block Kit is not a route** — Salesforce states HXL widgets don't render in Block Kit today |

**Target:** `initialize` + `tools/list` return identical results over stdio and over the
hosted `/mcp` URL (curl from a different network for the latter). Same `createServer()`,
two transports.

**Identity note that becomes a blocker at Step 8:** a hosted endpoint that signs in as one
customer from env vars means *every* ChatGPT or Slack user sees that customer. Acceptable for
a throwaway tunnel URL used for one screenshot; not acceptable for anything else — see the
`sign_in` tool in `TRACK_B_SETUP.md` Step 6.

## 7 · Confirm the widget renders in real hosts
Connect Claude Desktop first (fastest path), trigger the tool in a live chat. Then ChatGPT.
Then Slack — **after** confirming the workspace actually has Slackbot MCP Apps enabled, which
is a Slack plan/rollout question, not something this repo controls.

**Target, per host:** an actual visual card renders, with data matching a direct SOQL check —
not a text description, not the Playground preview. One screenshot per host. For any host
that didn't render, one written line saying why. Claude Desktop must pass; the other two are
each a yes/no with evidence.

## 8 · Close the write-back loop and prove it's governed
Wire the card's action button to a real Apex write, with a permission check and an audit
record. Click it from inside the chat client, then cut to Salesforce and show the record
changed, plus the audit entry naming who did it and through which channel.

**Target:** one SOQL —
`SELECT Name, Owner_Contact__r.Name, Channel__c, CreatedDate FROM HXL_Order__c ORDER BY CreatedDate DESC`
— shows rows from at least two channels (`claude`, `chatgpt`, `slack`, `web`), each owned by
the customer who clicked. The channel comes from a header the MCP server sets per transport;
the owner comes from the token, never from the caller. Click the button on **every** host
that rendered in Step 7 — the write path is where host sandbox/CSP differences show up first,
and "renders but the button is dead" on one host is a finding worth having.

---

## What to add for a POC audience (beyond the 8 steps)

None of these is required for the pattern to work. Each is under two hours and turns a claim
into something the room watches happen.

| Addition | Why it earns its place |
|---|---|
| **Negative-path tool** `get_order(orderNumber)` | Ask Ada's chat for Grace Hopper's $9,999 order; get empty. Turns "sharing is enforced" from a footnote into a live refusal, from inside the agent surface, on every host |
| **`Channel__c` audit field** on the order | Step 8's "who and through which channel" becomes a three-column query instead of narration |
| **`sign_in` tool keyed per MCP session** (~30 lines) | The only way two different people can use one hosted server. Prerequisite for the two-identity proof in `TRACK_B_HOST_VERIFICATION.md` §4 on any host other than local Claude Desktop |
| **Live JSON edit → redeploy → both hosts update** | The single strongest visual in the demo (`PRESENTATION.md` Part 5). Rehearse the deploy time; if it's over ~60s, show before/after screenshots instead |
| **`sample data` badge on the card** (already built) | A dead identity bridge degrades visibly instead of crashing — say so, it reads as engineering maturity |
| **One line on `McpServerDefinition`** | The org can host MCP servers itself. Not used here *on purpose*: the server would then run inside Salesforce with Salesforce's identity, which is the pattern this POC exists to avoid. Naming the choice pre-empts the question |

---

## Order of operations and where to stop

1 → 2 → 3 → 4 → **6 (stdio only)** → **7 (Claude Desktop)** → 8 (Claude Desktop) →
6 (hosted) → 7 (ChatGPT) → 7 (Slack, if available) → 8 on each → 5 (Agentforce) → additions.

Step 5 is moved late deliberately: it's a separate rendering path from the MCP hosts, it
proves nothing about them, and Agentforce Builder's preview is the one host that doesn't need
the MCP server at all. Do it once the MCP story is solid, so a CLT/renderer syntax fight
(already noted as costly in `TRACK_B_SETUP.md`) can't stall the part with the differentiated
claim.

If hours run out: a fully verified Claude Desktop + one hosted host, with the write-back and
the audit row, beats three hosts with an unconfirmed button on two of them.
