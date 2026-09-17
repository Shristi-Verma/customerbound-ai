# CustomerBound AI runbook

This runbook sets up the complete POC from a clean Windows machine without copying credentials or local CLI state.

## 1. Install prerequisites

Install Node.js 20 or later, Git, and Salesforce CLI. Install Cloudflare Tunnel only for hosted MCP testing, and Claude Desktop only for the verified desktop experience.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
npm install --global @salesforce/cli
winget install --id Cloudflare.cloudflared -e
```

Open a new PowerShell window and verify:

```powershell
node --version
npm --version
git --version
sf --version
cloudflared --version
```

## 2. Clone and install

```powershell
git clone <repository-url>
cd customerbound-ai
npm --prefix hxl-demo install
npm --prefix hxl-experience-layer\mcp install
```

Do not copy `node_modules`, `.sf`, `.sfdx`, or `.env` from another machine.

## 3. Authenticate Salesforce CLI

```powershell
sf org login web --alias hxl --set-default
sf org display --target-org hxl
```

Use an authorized development or sandbox org. Do not put administrator usernames, passwords, access tokens, or client secrets in documentation.

## 4. Configure the identity BFF

```powershell
Copy-Item hxl-demo\.env.example hxl-demo\.env
```

Set these values in `hxl-demo\.env`:

| Variable | Required value |
|---|---|
| `SF_SITE_URL` | Experience Cloud site base URL |
| `SF_CLIENT_ID` | External Client App consumer key |
| `SF_CLIENT_SECRET` | External Client App secret; keep server-side |
| `SF_REDIRECT_URI` | Exact registered callback, normally `http://localhost:3000/callback` |
| `SF_SCOPES` | Normally `api refresh_token openid` |
| `SF_INIT_AUTH_FLOWS` | Leave empty unless the corresponding site endpoints require authenticated init calls |
| `PORT` | `3000` |
| `HXL_DEBUG` | `1` for local diagnosis; `0` for normal use |

The app callback URL must exactly match `SF_REDIRECT_URI`.

## 5. Configure the experience and MCP layer

```powershell
Copy-Item hxl-experience-layer\.env.example hxl-experience-layer\.env
```

Set:

| Variable | Required value |
|---|---|
| `HXL_BFF_URL` | `http://localhost:3000` |
| `HXL_DEMO_USER` | A dedicated external test user |
| `HXL_DEMO_PASSWORD` | That test user's local POC password |
| `HXL_MCP_PORT` | `8787` |
| `HXL_ALLOW_ENV_IDENTITY` | Keep `0` for hosted HTTP |

Local credentials support only the current POC. The production design replaces them with MCP OAuth.

## 6. Deploy and verify Salesforce metadata

```powershell
sf project deploy start --source-dir hxl-demo\force-app --target-org hxl --wait 30
sf project deploy start --source-dir hxl-experience-layer\force-app --target-org hxl --wait 30
powershell -ExecutionPolicy Bypass -File hxl-demo\scripts\verify-setup.ps1 -TargetOrg hxl
sf apex run test --class-names HXL_OrderAPITest --target-org hxl --wait 10 --result-format human
sf org list metadata --metadata-type UiWidgetBundle --target-org hxl
```

Review `hxl-demo\SETUP.md` before using the setup or seed scripts because they change Salesforce state.

## 7. Start the POC

Terminal 1 - identity BFF:

```powershell
npm --prefix hxl-demo start
```

Expected URL: `http://localhost:3000`.

Terminal 2 - hosted MCP transport:

```powershell
npm --prefix hxl-experience-layer run mcp:http
```

Expected base URL: `http://localhost:8787`.

For a local visual preview instead:

```powershell
npm --prefix hxl-experience-layer run demo
```

Expected preview URL: `http://localhost:4321`.

## 8. Verify locally

With the BFF running:

```powershell
npm --prefix hxl-experience-layer run smoke
```

With the hosted MCP server also running:

```powershell
npm --prefix hxl-experience-layer run smoke:http
```

Confirm that the session resolves the intended external user, retrieves only records visible to that user, and applies Salesforce business rules to permitted actions. Repeat with a second user before treating the isolation proof as production evidence.

### Verify the two-persona story

Keep demo credentials only in the ignored root file `DEMO_PERSONAS.local.md`. Never add this file to Git. Use separate host conversations for the customer and staff personas, and sign out before switching.

The staff design uses all of these Salesforce controls together:

- a Customer Community Plus named user;
- the `HXL_Staff_Access` permission set and custom permission;
- the `CustomerBound_Staff_Portfolio` public group;
- the `HXL_Staff_Portfolio_Access` criteria sharing rule; and
- `Staff_Visible__c = true` only on records intentionally included in the demo portfolio.

The external client app must be admin-approved for `HXL_Staff_Access`. For an External Client App, verify this through Setup or a `SetupEntityAccess` record; legacy `applicationVisibilities` permission-set XML does not apply.

For high-volume Customer Community users, keep the named customer in `Owner_Contact__c` and use an internal technical owner. Those external users have no role, so their technically owned records do not generate criteria-rule shares. The customer sharing set continues to grant access using the Contact relationship.

Expected verification:

- the customer sees only their own records and cannot retrieve the second customer's record by identifier;
- the staff session reports `persona = staff` and sees only the explicitly shared two-customer portfolio;
- staff can move `Submitted` to `Approved`, then `Approved` to `Fulfilled`;
- staff notes are available to staff but absent from the customer payload; and
- `Channel__c` records the originating host.

### Verify the third-customer boundary and action evidence

The ignored file `DEMO_BOUNDARY.local.md` contains the current third-customer record number. Keep it off screen because it is org-specific demo state.

1. Sign in as staff and retrieve that exact record; confirm `404`.
2. Choose a staff-visible record in `Submitted` status.
3. Attempt `fulfill` first; confirm `409` and no new `HXL_Action_Event__c` row.
4. Run `approve`, then `fulfill`; confirm two event rows.
5. Refresh the staff console and confirm the latest audit summary contains actor and transition.
6. Refresh the customer session and confirm the status changed while audit and internal-note values remain absent.

Read-only audit verification query:

```sql
SELECT Name, HXL_Order__r.Name, Action__c, From_Status__c, To_Status__c,
       Actor_User__r.Name, Customer_Contact__r.Name, Channel__c, Occurred_At__c
FROM HXL_Action_Event__c
ORDER BY Occurred_At__c DESC
```

The setup administrator needs `HXL_Portfolio_Setup` to inspect optional action-event fields. This permission set does not grant staff workflow actions.

## 9. Connect Claude Desktop

```powershell
npm --prefix hxl-experience-layer run config
```

Copy the generated server entry into Claude Desktop's MCP configuration, fully quit Claude Desktop, and reopen it. Keep the BFF running on port 3000. The generated configuration contains a local POC credential, so do not commit it or share screenshots containing it.

## 10. Test a hosted MCP surface

Keep ports 3000 and 8787 running, then start a temporary tunnel:

```powershell
cloudflared tunnel --url http://localhost:8787
```

Use the generated HTTPS origin with the appropriate path:

- Generic: `https://<generated-host>/mcp`
- ChatGPT: `https://<generated-host>/mcp/chatgpt`
- Slack: `https://<generated-host>/mcp/slack`

Keep `HXL_ALLOW_ENV_IDENTITY=0`. Each hosted session must sign in independently. Temporary tunnel URLs rotate after restart and are not production infrastructure.

## 11. Stop and restart

Press `Ctrl+C` in each server terminal. After a system restart, rerun the two commands in section 7. Start a new tunnel only when hosted testing is required, then update the host configuration with its new URL.

## 12. Troubleshooting

- `GET /api/me` returns `401`: the browser or MCP session is not signed in yet.
- Port 3000 or 8787 is busy: stop the previous Node process or change the corresponding environment variable.
- Claude shows no tools: regenerate its configuration, verify absolute paths, fully quit the app, and reopen it.
- Hosted client cannot connect: confirm both local services are running and update the client after the tunnel URL changes.
- Salesforce metadata appears correct in Setup but behavior differs: verify with Salesforce CLI queries and tests rather than relying only on the UI.
- Never solve a hosted sign-in issue by setting `HXL_ALLOW_ENV_IDENTITY=1` on a shared or persistent endpoint.

## 13. Production-readiness backlog

1. Implement MCP OAuth and remove password-based MCP configuration.
2. Add durable, encrypted session storage with expiry and revocation.
3. Deploy behind a stable secured domain with monitoring and rate limits.
4. Automate separate-session regression testing for the named customer and named staff personas.
5. Validate registration, passwordless access, and recovery with the required client attestation.
6. Confirm Experience Cloud and API licensing with Salesforce.
7. Add automated security, integration, and end-to-end tests.
