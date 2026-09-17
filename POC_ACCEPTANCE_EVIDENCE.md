# CustomerBound AI POC acceptance evidence

Verified against the configured Salesforce development org on 17 September 2026. This document contains no credentials, tokens, org IDs, user IDs, Contact IDs, or temporary tunnel addresses.

## Scope

| Persona or boundary | Expected access |
|---|---|
| Named customer | Their own records only |
| Named operations staff | Records explicitly assigned to the two-customer portfolio |
| Unassigned third customer | Not visible to either the first customer or assigned staff |

Local mappings and credentials remain in the ignored `DEMO_PERSONAS.local.md` and `DEMO_BOUNDARY.local.md` files.

## Controls exercised

### Customer boundary

- Customer records are private by default.
- A Salesforce sharing set maps the authenticated external user's Contact to `Owner_Contact__c`.
- Exact lookup and deliberately broad search contain no application owner filter.
- Requests for another customer's record return `404` through Salesforce sharing.

### Staff portfolio boundary

- Staff identity requires the `HXL_Staff_Access` custom permission.
- Visibility comes from the `CustomerBound_Staff_Portfolio` group and criteria sharing rule.
- Only records with `Staff_Visible__c = true` enter the portfolio.
- A third customer has a record with `Staff_Visible__c = false`; exact staff lookup returns `404`.

### Business-state enforcement

Allowed staff transitions are deliberately narrow:

```text
Submitted → Approved → Fulfilled
```

Any other transition returns `409 Conflict`. The caller cannot supply an arbitrary status value.

### Action evidence

Each successful staff transition creates an `HXL_Action_Event__c` child record containing the parent record, named actor, customer Contact, action, previous and new state, source channel, internal note, and timestamp. Controlled-by-parent sharing keeps evidence within the parent record's Salesforce boundary. Customer APIs never query or serialize this object.

## Recorded result

| Assertion | Result |
|---|---|
| Staff portfolio size | 18 |
| Assigned customers visible to staff | 2 |
| Third-customer exact lookup | `404` |
| Invalid fulfil-before-approval | `409` |
| Events created by rejected transition | 0 |
| Valid lifecycle | Submitted → Approved → Fulfilled |
| Events created by a complete lifecycle | 2 |
| Customer-visible records | 17, all scoped to the authenticated customer |
| Customer receives internal staff note | No |
| Customer receives action event | No |
| Apex regression suite | 5/5 passed |

## Repeatable verification

1. Start the BFF with `npm --prefix hxl-demo start`.
2. Sign in as the customer from a dedicated host conversation.
3. Confirm another customer's exact record returns not found.
4. Sign out and open a separate staff conversation.
5. Confirm the console contains only the assigned two-customer portfolio.
6. Request the ignored local boundary record number and confirm `404`.
7. Attempt fulfilment on a Submitted record and confirm `409`.
8. Confirm the action-event count did not change.
9. Approve the record, then fulfil it.
10. Confirm two action events and their actor, transition, channel, and timestamp.
11. Return to the customer conversation and refresh.
12. Confirm the new status is visible while staff note and action-event fields are absent.

## Reset guidance

- Use another Submitted portfolio record for each rehearsal.
- Do not change the third customer's `Staff_Visible__c` value.
- Keep local persona and boundary files off screen and outside Git.
- Capture the customer view, staff view, `404`, `409`, and Salesforce event rows before presenting.
