# CustomerBound AI — Executive Summary

*A governed, named-user experience for customers and operations staff in Salesforce*

**Verified 17 September 2026**

## Executive outcome

CustomerBound AI demonstrates one governed service journey across three named AI personas. A named customer can retrieve and act on only their own Salesforce records. A named operations user receives a different experience and can review only an explicitly assigned portfolio. High-value work requires a separate named supervisor, and ordinary staff cannot bypass that second approval. Salesforce identity, sharing, custom permissions, and business rules—not prompt wording—select the persona, data boundary, and available actions.

The same capability layer supports a customer action center and a staff operations console. No broad integration identity is used for business access, and the model never supplies a customer identifier to establish ownership.

## Verified business journey

1. A named customer creates or reviews a request through an AI host.
2. Salesforce derives the customer Contact from the access token.
3. Salesforce automatically routes the new request into the controlled staff portfolio.
4. Staff can request information; the same customer responds and resubmits.
5. High-value work stops at Pending Supervisor Approval until a separate supervisor approves it.
6. An invalid or unauthorized state transition is rejected by Salesforce business logic.
7. Each successful transition creates an action event containing actor, customer, previous state, new state, channel, note, and timestamp.
8. The customer sees the updated state but never receives staff-only notes or action-event data.

## Access-boundary proof

The demo contains three customer record sets:

- Customer A: accessible to the customer and assigned staff portfolio.
- Customer B: inaccessible to Customer A but accessible to assigned staff.
- Customer C: deliberately excluded from the staff portfolio and inaccessible to both Customer A and staff.

Exact-record requests are made without application owner filters. Salesforce sharing returns `404` when the running identity cannot access the record. A deliberately broad search is likewise constrained by Salesforce sharing.

## Live acceptance results

| Control | Verified result |
|---|---|
| Named staff portfolio | 18 records across exactly two assigned customers |
| Unassigned third customer | Exact staff lookup returned `404` |
| Invalid transition | Fulfil-before-approval returned `409` |
| Rejected-action audit | Audit-event count remained unchanged |
| Valid lifecycle | Submitted → Approved → Fulfilled |
| Successful-action audit | Two events created per completed lifecycle |
| Customer isolation | Customer session returned only its own 17 records |
| Internal confidentiality | Customer payload contained no staff notes or action events |
| Three-persona lifecycle | Customer → Staff → Supervisor → Staff completed successfully |
| Separation of duties | Ordinary staff supervisor-approval attempt returned `409` |
| Automated end to end | 17 live multi-persona checks passed |
| Automated regression | Five Apex tests passed; 213/221 executable lines covered in the service class |

## Architecture validated

```text
AI host
  → MCP capability and role-aware experience
  → identity BFF retaining the named-user token
  → Salesforce Apex service (with sharing)
  → customer sharing set / staff portfolio sharing rule
  → governed business transitions and action-event audit
```

The customer path retains user-mode reads and writes. The staff path is guarded by record sharing plus the `HXL_Staff_Access` custom permission and performs a sparse, allow-listed update. It cannot select an arbitrary customer or arbitrary status.

## Decision requested

Approve a production-readiness phase covering:

1. MCP OAuth so passwords never enter a model interaction or host configuration.
2. Stable secured hosting and durable encrypted sessions.
3. Automated multi-persona end-to-end regression testing.
4. Monitoring, retention, and reporting for action events.
5. Salesforce licensing confirmation for the selected external identity model.
6. Validation on one supported hosted AI channel in addition to Claude Desktop.

## Executive message

> CustomerBound AI proves that one reusable AI capability can serve customers and operations staff without turning either persona into a superuser. Identity changes the experience, Salesforce limits the data, business rules limit the action, and successful work leaves durable evidence.
