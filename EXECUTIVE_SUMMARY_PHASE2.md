# Headless Salesforce POC — Phase 2 Executive Summary

*Per-user identity on AI agent surfaces, with zero Salesforce-hosted screens*

**12 September 2026** — supersedes the 8 September draft; reflects what is verified as of this date.

---

## Bottom line

A customer can sign in and act on their own Salesforce data through a front end that contains
no Salesforce UI — and that same customer's data now renders as an interactive card for AI
agent surfaces, from **one server** that speaks to Claude Desktop, ChatGPT and Slack, holds
**no Salesforce credential**, and keeps a **separate identity per chat session**. Every action
the card takes lands in Salesforce as that named customer, with the surface it came from
recorded for audit.

The differentiated claim — an agent surface that acts as one specific person rather than a
broad-access integration user — is now proven at the platform level, not the code level: a
customer asking for another customer's order **by record Id, with no filter anywhere in the
chain**, is refused by Salesforce sharing. That was not true a week ago, and finding out why
is the most important result of this phase.

## What Phase 2 set out to prove

> Two different real people, in two chat sessions on the same agent surface, each see and act
> on only their own Salesforce data — enforced by Salesforce sharing, not by which demo account
> happened to be wired into the server.

Three success criteria were set, in dependency order. Status:

| # | Criterion | Status 12 Sep |
|---|---|---|
| 1 | The widget renders in a real MCP host and its data matches a direct SOQL query | **Server side complete** — verified with a real MCP client over stdio, local HTTP and a public HTTPS URL. **Host render not yet confirmed** — Claude Desktop is not installed on the build machine; ChatGPT/Slack not yet connected. Procedure written and ready |
| 2 | Registration works end to end and creates a real, distinct Contact | **Not started** — blocked at the org's init-endpoint wall (unchanged from Phase 1); certificate route scoped |
| 3 | Two identities, two live sessions, each sees only its own data; cross-access refused | **Mechanism complete and verified** — per-session identity, `sign_in` per person, `/sessions` shows who is who; cross-access refused by sharing. **Not yet demonstrated with two people on a live host** (depends on 1 and 2) |

## What was built and verified this phase

Every item was exercised against the live org through the running software.

| Capability | Evidence |
|---|---|
| **Identity per chat session** | One MCP server; sessions keyed by the host's session id; `sign_in` / `sign_out` / `whoami` tools; only a session cookie is held — never the password, never the Salesforce token |
| **Same server, three transports** | stdio for Claude Desktop; Streamable HTTP at `/mcp/chatgpt` and `/mcp/slack` for the hosted hosts; identical tool list and widget over each; verified through a public cloudflared URL from end to end (sign-in → order created) |
| **Hosted safety default** | Over HTTP the server refuses to act as the env-var demo customer unless explicitly overridden — a public URL cannot show one customer to everyone by accident |
| **Sharing enforced at the platform** | New `get_order` tool asks Salesforce for a record by Id or number with **no owner filter**. Ada → Grace Hopper's $9,999 order: `found: false`, by number and by Id. Ada → her own orders, including ones created by staff: `found: true` |
| **Prompt injection contained by the platform** | A deliberately unfiltered search tool exists so an injected model has something to reach for. "List every customer's orders" → the model calls it → 16 orders, all the signed-in customer's, none of Grace Hopper's. The model was compromised; the blast radius was one customer's own data |
| **Updates, not just inserts** | Cancel from the card flips a real order to `Cancelled` as the customer; Shipped orders are refused by rule; another customer's order is invisible before any rule runs. Sharing set raised to Edit so staff-created orders are the customer's to cancel |
| **Audit trail with channel** | New `Channel__c` on the order; set by the layer from the transport, never by the caller; unknown → `other`. Live rows: `ORD-00012 slack`, `ORD-00013 chatgpt`, `ORD-00014 claude`, `ORD-00015 chatgpt` (via public URL), all owner Ada Lovelace |
| **Tests** | `HXL_OrderAPITest` 4/4, including: another contact's order by Id → 404; unfiltered search leaks nothing; cancel another's → 404, own Shipped → 409, own Submitted → Cancelled; channel handling |
| **Tooling** | `smoke.mjs` — a real MCP client that proves the server before any host is involved; cloudflared installed and exercised |

## The finding that matters most

**The sharing claim was false until this phase, and nothing in the earlier demo could have
revealed it.** The customer profile carried *View All Records* on the order object, which
bypasses sharing entirely. Every previous "proof" filtered the query by the customer's
Contact — which looks identical to sharing from the outside and is not sharing at all. The
new `get_order` tool, built precisely to ask without filtering, returned another customer's
$9,999 order on first run.

Fixed with the platform's intended mechanism — a Sharing Set granting customers read access
to orders linked to their own Contact — and View All removed. Both are now in source control
and deployed; the fix was re-verified from the agent surface.

The generalisable lesson, worth carrying into any Salesforce security review: *a sharing
claim is only demonstrated when something asks for a record without filtering and is
refused.* A filtered query proves nothing about the platform.

## Host support, stated precisely

| Surface | Route | Position |
|---|---|---|
| Claude Desktop | Local process (stdio) | Shortest path to the first render; install pending |
| ChatGPT | Public HTTPS + Developer Mode connector | Same MCP Apps standard; server path verified through a tunnel; connector not yet added |
| Slack | **Slackbot via MCP Apps only** | Block Kit cannot render these widgets — Salesforce's own statement. Availability of MCP Apps on the target workspace is a Slack plan question, to be checked before hours are spent |
| Codex | CLI MCP client | Can call the tools and receive correctly scoped data; cannot render — a terminal. Will not be presented as an OpenAI render |
| Agentforce | Custom Lightning Type + renderer | Separate path, no MCP server; not attempted this phase |

## What does not work, and why

- **Three of four identity flows** (Registration, Passwordless, Forgot Password) remain blocked
  at the org's init-endpoint wall. Unchanged from Phase 1; the recommended route — first-party
  client attestation with a signing certificate — is scoped at roughly 40 lines plus
  certificate setup. Registration specifically is the prerequisite for a second real identity.
- **Password transits the chat** for `sign_in`. Acceptable for a POC on a throwaway tunnel;
  not for anything else. The proper design is MCP OAuth with the identity layer as the
  authorization server, so the host opens a login page and no credential passes through the
  model. This is the natural next piece of work and the one with the most substance.
- **Demo-grade infrastructure**: in-memory sessions, plain HTTP on localhost, a free tunnel
  whose URL changes on restart.

## Engineering findings — the durable value

Seventeen specific divergences between documentation and real org behaviour are now
reproduced and written up (nine identity, seven experience layer, one sharing). New this
phase:

- View All on a community profile silently defeats sharing; nothing in Setup warns you.
- `WITH USER_MODE` on a field the running user lacks FLS for fails with the misleading
  `Variable does not exist: tmpVar1`.
- A Salesforce `PermissionSetAssignment` in a test must be isolated with `runAs` from
  ordinary DML (`MIXED_DML_OPERATION`).
- On Windows, starting the BFF via `Start-Process npm` silently starts nothing.
- The site's DNS intermittently fails on first contact; the layer retries once so the demo
  does not show "sample data" for a reason the room cannot see.

## Risks and caveats

| Risk | Position |
|---|---|
| Licensing | Experience Cloud, Customer Community users. An invisible site is not a free site. API access at this tier works but is not normally included — **confirm with Salesforce before commercial reliance** |
| Beta feature | The Experience Layer is Beta; org access arrived in August. Frame as "what is coming and what it unlocks", not "ship next sprint" |
| Host render unconfirmed | Everything up to the host boundary is proven with a real MCP client. The final hop needs Claude Desktop installed and a ChatGPT/Slack connector added — hours, not days, and the procedure is written |
| Slack availability | Depends on the workspace's plan, not on this build |
| Per-component host support | The platform rates each widget block per host; one unsupported block can blank a card in one host while it works in another |

## Recommendation and ask

The mechanism for per-user identity on agent surfaces is built, tested, and — after the View
All correction — genuinely enforced by the platform. What remains is confirmation on live
hosts and a second real identity.

The specific request, in order:

1. **Two days** to confirm the render on Claude Desktop and one hosted surface (ChatGPT
   first; Slack if the workspace allows), with the write-back and audit row shown from each.
2. **Three to five days** on the certificate route to unblock Registration, then the
   two-person, two-host demonstration that is this phase's stated end goal.
3. A decision on **licensing confirmation** with Salesforce before anything here is relied on
   commercially.
4. If the above lands: scope **MCP OAuth with the identity layer as authorization server** as
   the follow-on — it removes the last POC-grade shortcut and is the piece Salesforce's own
   material does not provide.

## Supporting material

`PRESENTATION.md` (slides, script, run-of-show, Q&A) ·
`TRACK_B_BUILD_PATH.md` · `TRACK_B_HOST_VERIFICATION.md` · `SETUP_NEW_MACHINE.md` ·
`hxl-demo/HXL_ORG_CONTEXT.md` (§10 for the View All finding) · `TRACK_B_ORG_CONTEXT.md`
