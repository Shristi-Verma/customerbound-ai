# CustomerBound AI

CustomerBound AI is a Salesforce proof of concept for delivering interactive, named-user experiences inside AI assistants. It combines Salesforce Headless Identity, a Salesforce-defined Headless Experience Layer widget, and an MCP server that supports local stdio and hosted Streamable HTTP transports.

The security boundary remains in Salesforce: the identity layer retains the named-user token, Apex derives the user context from that token, and sharing, permissions, and business rules determine what each session may retrieve or change.

## Repository layout

| Path | Purpose |
|---|---|
| `hxl-demo/` | Headless Identity BFF, browser demo, Apex REST service, Salesforce metadata, and setup checks |
| `hxl-experience-layer/` | Salesforce UI widget, MCP server, local preview, hosted transport, and smoke client |
| `document-output/` | Current executive approval document |
| `presentation-output/` | POC presentation artifacts |
| `RUNBOOK.md` | Complete installation, configuration, startup, verification, and host connection steps |
| `SECURITY.md` | Credential handling and safe publishing guidance |

## Verified POC capabilities

- Named external-user authentication through a server-side BFF
- Salesforce-defined interactive experience rendered in Claude Desktop
- Role-aware MCP capabilities for session management, identity inspection, protected retrieval, customer actions, and staff approval/fulfilment
- A named Customer Operations persona with access to an explicitly shared two-customer portfolio
- A third-customer negative boundary proving that staff access is also limited
- Immutable action-event evidence for every successful staff transition
- Salesforce-enforced record isolation for direct cross-user requests and deliberately broad searches
- User-context write-back subject to sharing, permissions, and business rules
- Channel and owner audit values recorded in Salesforce
- Local stdio and hosted Streamable HTTP MCP transports
- Hosted-session safeguards that prevent accidental inheritance of a local demo identity
- Clear signed-out or sample behavior when no identity is available

## Quick start

Prerequisites: Node.js 20 or later, Salesforce CLI, access to a configured Salesforce org, and optionally Claude Desktop or Cloudflare Tunnel.

```powershell
git clone <repository-url>
cd customerbound-ai
Copy-Item hxl-demo\.env.example hxl-demo\.env
Copy-Item hxl-experience-layer\.env.example hxl-experience-layer\.env
npm --prefix hxl-demo install
npm --prefix hxl-experience-layer\mcp install
```

Fill the two new `.env` files with your own development configuration. Never commit them.

Start the identity BFF in terminal 1:

```powershell
npm --prefix hxl-demo start
```

Start hosted MCP in terminal 2:

```powershell
npm --prefix hxl-experience-layer run mcp:http
```

Or run the local MCP smoke test:

```powershell
npm --prefix hxl-experience-layer run smoke
```

Open `http://localhost:3000` for the browser experience. For Salesforce deployment, validation, Claude Desktop, hosted MCP, ChatGPT, Slack, and troubleshooting steps, follow [RUNBOOK.md](RUNBOOK.md).

## Security model

```text
AI host
  -> MCP capability layer
  -> identity BFF holding the named-user token
  -> Salesforce Apex and data services
  -> sharing, permissions, and business rules
```

The MCP server does not hold a Salesforce integration credential. Tokens remain server-side and are not returned to the model, chat transcript, or rendered widget. See [SECURITY.md](SECURITY.md) before publishing, forking, or deploying this project.

## POC status

Claude Desktop rendering and both named customer and named staff flows are verified. The customer is isolated to their own Salesforce records; the staff persona can review an explicitly shared two-customer portfolio and approve or fulfil eligible work. Hosted endpoints have been smoke-tested through a temporary HTTPS tunnel. Production readiness work includes MCP OAuth, stable secured hosting, durable sessions, additional identity journeys, monitoring, and licensing confirmation.

## Documentation

- `document-output/CustomerBound_AI_Executive_Summary_and_Approval_Request.docx`
- `HXL_POC_DEMO_STORY.md`
- `POC_ACCEPTANCE_EVIDENCE.md`
- `TRACK_B_HOST_VERIFICATION.md`
- `hxl-demo/HXL_ORG_CONTEXT.md`
- `hxl-experience-layer/README.md`

## License

No open-source license has been granted. Treat this repository as private proof-of-concept material unless the owner adds a license.
