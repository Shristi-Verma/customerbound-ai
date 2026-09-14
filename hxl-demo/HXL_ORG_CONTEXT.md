# HXL POC — org context and findings

> **Naming — read this first.** This project is **Salesforce Headless Identity**:
> login, registration and password reset with no Salesforce-hosted UI, built on an
> Experience Cloud site and OAuth. It is **not** the Salesforce **Headless Experience
> Layer (HXL)** — the Beta where you describe a UI once as Mosaic JSON and Slack,
> Agentforce, ChatGPT or Claude render it natively. Both get called "HXL" in
> conversation; they are unrelated Salesforce features. The folder name `hxl-demo`
> predates that discovery. The Headless Experience Layer work lives in
> `../hxl-experience-layer/`. See `../README.md` for how the two fit together.


Written 2026-09-06. Everything here was verified against the live org, not inferred.
Read this before touching setup again.

`SETUP.md` is the happy-path guide. **This file records where this org diverges from it**,
what is proven working, and what is still broken.

---

## The org

| | |
|---|---|
| Alias | `hxl` (`sf config set target-org hxl`) |
| Username | `shristipatel63.c30cb1506927@agentforce.com` |
| Org Id | `00Dg800000FKoMgEAL` |
| Type | Developer Edition, Agentforce-flavoured. **API v67.0**, project pinned to 63.0 |
| Instance URL | `https://orgfarm-4d60b0d1f4-dev-ed.develop.my.salesforce.com` |
| Site URL (`SF_SITE_URL`) | `https://orgfarm-4d60b0d1f4-dev-ed.develop.my.site.com/hxlstore` |

**Two sites exist and that is normal.** `HXL_Store1` (`ChatterNetworkPicasso`, prefix
`hxlstore`) is the real LWR site. `HXL_Store` (prefix `vforcesite`) is the auto-created
companion. Token responses report `sfdc_community_url` as `/vforcesite` — harmless, both
prefixes behave identically for the headless endpoints.

### Key records

| Thing | Value |
|---|---|
| Profile for external users | `HXL customer` (**lowercase c**), id `00eg8000006CaRlAAK`, `CspLitePortal` |
| Account | `HXL Demo Customers`, `001g800000kPZTnAAO` |
| Role on admin | `HXL User` (`00Eg8000005clflEAA`) — required, see divergence 7 |
| Permission set | `HXL_Customer_Access` |
| External Client App | `HXL_layer`, id `0xIg8000000BUPNEA4` |
| Registration handler | `AutocreatedHeadlessSelfReg1788678547452`, Run As Shristi verma |
| Test community user | `ada.hxl@hxlpoc.demo` / `${HXL_DEMO_PASSWORD}` — **created by hand, did not self-register** |

---

## What works

Verified end to end through the running app, not just by curl:

```
POST /api/login   200   headless login, PKCE, refresh token issued
GET  /api/me      200   ada.hxl@hxlpoc.demo, contactId 003g800000fQI05AAG
                        3 own orders; Grace Hopper's $9,999 order correctly absent
POST /api/orders  201   ORD-00004 created
```

That is the whole "Salesforce keeps identity, sharing and data; you keep the experience"
argument, demoable today.

## What does not work

**Headless Registration, Passwordless Login and Forgot Password.** Their `init` endpoints
reject every credential we can mint. See "The init endpoint wall" below.

---

## Where this org diverges from SETUP.md

### 1. PKCE is forced on and cannot be disabled

The External Client App shows *Require Proof Key for Code Exchange* greyed out —
"To change this required setting, contact Support."

`app/hxl.js` now implements PKCE (S256): `pkcePair()` generates a 64-byte base64url verifier,
`authorize()` sends `code_challenge` + `code_challenge_method=S256`, and
`exchangeCodeForTokens()` sends `code_verifier`. Both params are conditional, so the code still
runs against an org where PKCE is off.

### 2. It is an External Client App, not a classic connected app

Different UI, different metadata. Useful because you can drive it from the CLI instead of
fighting the form:

```powershell
sf project retrieve start --metadata "ExtlClntAppOauthConfigurablePolicies" --target-metadata-dir <dir>
# edit <dir>/unpackaged/extlClntAppOauthPolicies/HXL_layer_oauthPlcy.ecaOauthPlcy
sf project deploy start --metadata-dir <dir>/unpackaged
```

Current working policy:

```xml
<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>
<ipRelaxationPolicyType>Bypass</ipRelaxationPolicyType>
<clientCredentialsFlowUser>shristipatel63.c30cb1506927@agentforce.com</clientCredentialsFlowUser>
<isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>
```

**`AllSelfAuthorized` does not work for Experience Cloud users.** With it set, logging in as a
community user returns `invalid_app_access: user is not admin approved to access this app`.
You must use `AdminApprovedPreAuthorized` *and* add the `HXL customer` profile to the app's
approved profiles. This was the single blocker on the login flow.

> Editing policies in the UI overwrites whatever the CLI last deployed, including fields you
> did not touch. If you deploy a policy change, do not then save the UI form from a stale tab.

### 3. Authorize answers with a 302, not JSON

A *successful* headless authorize returns `HTTP 302` with the code in the `Location` header:

```
Location: http://localhost:3000/callback?code=...&sfdc_community_url=...
```

The original `hxl.js` treated every 3xx as "Salesforce redirected instead of answering
headlessly" and threw. `call()` now takes `{ redirectOk }`; `authorize()` opts in and reads the
code from `Location`, falling back to the `code` field and to `redirect_uri` for other
releases. Other 3xx still error as before — that check is still worth having.

### 4. Apex REST must go to `instance_url`, not the site host

The site 302-redirects `/services/apexrest/*` to its own login page. `getMyOrders`,
`createOrder` and `userinfo` now take the `instance_url` that came back with the token;
`server.js` passes `s.tokens.instance_url` through. Identity still happens on the site host —
only the data calls move.

### 5. Community users need `ApiEnabled`

Without it, Apex REST returns `APEX_REST_SERVICES_DISABLED`. Added to `HXL_Customer_Access` as
a `userPermissions` entry.

> **Licensing caveat, unresolved.** `ada.hxl` is a Customer Community (`CSP_LITE_PORTAL`) user.
> That licence does not normally include API access, yet the grant deployed and works. Confirm
> this is legitimate before relying on it. Customer Community **Plus** is the licence that
> formally includes API access.

### 6. Required fields cannot appear in `fieldPermissions`

Deploy failed with `You cannot deploy to a required field: HXL_Order__c.Status__c`. `Status__c`
is `<required>true</required>`, so the platform grants it implicitly. Removed that block from
the permission set — no access is lost.

### 7. The role assignment silently did not save

SETUP.md step 4 is right that the admin needs a role, but the UI reported success without
persisting it. Verify, do not trust the screen:

```powershell
sf data query --query "SELECT Name, UserRole.Name FROM User WHERE Username='shristipatel63.c30cb1506927@agentforce.com'"
sf data update record --sobject User --where "Username='...'" --values "UserRoleId=00Eg8000005clflEAA"
```

### 8. `HXL_OrderAPITest` needs Digital Experiences before it will pass

`makePortalUser` guards only against *no* portal profile existing. The org has one, so the
guard passes and `insert u` then fails:

```
To create or update users for this profile, go to Setup > Digital Experiences > Settings and
select Allow using standard external profiles for self-registration, user creation, and login.
```

That checkbox is **not** in SETUP.md step 6 but is required. Deploy with
`scripts/setup.ps1 -SkipTests` until the org is configured.

### 9. `scripts/verify-setup.ps1` had a false-negative bug (fixed)

`Invoke-Soql` did `return @($res.records)`. PowerShell unrolls a single-element array back to a
bare object, and `PSCustomObject` has no `.Count` in PS 5.1 — so **every check that matched
exactly one record reported failure**. It claimed the permission set, role and account were all
missing when all three existed. Fixed with `return ,@(...)`.

It still warns "No connected apps visible" — `ConnectedApplication` is not reliably queryable,
and this org uses an External Client App anyway. That warning is a false alarm.

---

### 10. "View All" on the customer profile was silently defeating the sharing claim (found and fixed 2026-09-12)

The demo's central claim — *Grace Hopper's $9,999 order is invisible to Ada's token because
Salesforce sharing says so* — was **not true** until today. It only looked true because
`getMyOrders` filters `WHERE Owner_Contact__c = :contactId`. The moment a tool asked for the
record **by Id with no filter** (`GET /hxl/orders/<id>`, the new `get_order` MCP tool), Ada
got the order back: `found: true, $9,999.00`.

Cause: the **HXL customer** profile had `View All Records` on `HXL_Order__c`
(`ObjectPermissions.PermissionsViewAllRecords = true`). View All bypasses OWD and sharing
entirely. It was almost certainly switched on at some point to make Ada's *admin-seeded*
orders visible (three of her orders are owned by the admin user, so with OWD Private and no
sharing she couldn't see them — and View All "fixed" that, along with everything else).

Fix, both now in source and deployed:

| Piece | File | What it does |
|---|---|---|
| Partial profile | `force-app/main/default/profiles/HXL customer.profile-meta.xml` | `viewAllRecords = false` on `HXL_Order__c` (merges into the org profile on deploy) |
| Sharing set | `force-app/main/default/sharingSets/HXL_Customer_Orders.sharingSet-meta.xml` | Customer Community users read `HXL_Order__c` where `Owner_Contact__c` = their own Contact — the platform mechanism for exactly this |

Verified after the fix, as Ada, through the MCP tool with no owner filter in the chain:

| Lookup | Result |
|---|---|
| `ORD-00003` (Grace, $9,999) by number | `found: false` |
| `a00g8000027TtVYAA0` (same record) by Id | `found: false` |
| `ORD-00001` (Ada's, **owned by admin**, via sharing set) | `found: true` |
| `ORD-00015` (Ada's, owned by her) | `found: true` |
| `get_my_orders` | still 15 orders — nothing lost |

**Lesson for the demo:** "sharing is enforced" is only a claim you can make if something in
the demo asks for a record *without* filtering by owner and is refused. The curl beat (Section
B3) and `get_order` now do that. Before today they would have shown the opposite. Check
`PermissionsViewAllRecords` and `PermissionsModifyAllRecords` on every profile and permission
set a community user carries — SOQL:

```sql
SELECT Parent.Name, Parent.Profile.Name, PermissionsViewAllRecords, PermissionsModifyAllRecords
FROM ObjectPermissions
WHERE SobjectType = 'HXL_Order__c'
  AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment
                   WHERE Assignee.Username = 'ada.hxl@hxlpoc.demo')
```

Both columns must be `false` on every row.

## The init endpoint wall (unresolved)

`Login & Registration` refuses to enable Headless Registration, Passwordless Login or Forgot
Password unless each has **Require authentication** *or* **Require reCAPTCHA** ticked. This is
enforced, not advisory — the Metadata API rejects it too:

```
To allow self-registration via the Headless Registration API, select either Require
authentication for this API or Require reCAPTCHA to access this API.
```

With *Require authentication* on, the `init` endpoints reject every credential tried:

| Attempt | Result |
|---|---|
| No header | `include an authentication header or reCAPTCHA parameter` |
| `Authorization: Basic base64(client_id:client_secret)` | same — Basic is not recognised at all |
| Bearer, client-credentials as **admin** (approved for app) | `authentication failure` |
| Bearer, client-credentials as **`ada.hxl`** (community user, app-approved, `ApiEnabled`) | token will not issue: `access_denied — end-user denied authorization` |
| Bearer from instance domain instead of site domain | `authentication failure` |
| Same via `/vforcesite` instead of `/hxlstore` | identical |

So: a community user cannot be a client-credentials run-as, and an admin's token is refused by
the endpoints. Also ruled out: `allowInternalUserLogin=true` (tested, no effect, reverted).

The official interface docs 403 for automated fetch and help.salesforce.com is a JS app, so
this was worked out from error strings alone.

**Next things to try, in order:**

1. **reCAPTCHA instead of authentication.** The org demands one or the other, and the auth
   branch is exhausted. Needs a free Google reCAPTCHA v2/v3 key in the site's *reCAPTCHA
   Options for Headless Identity*, plus code to send the token as a `recaptcha` parameter.
2. **Ask Salesforce Support** exactly what token these endpoints accept when *Require
   authentication* is on for a private client. This org shape (External Client Apps +
   mandatory PKCE + mandatory init auth) is newer than the demo repo.

### The first-party path — explored 2026-09-06, blocked on a certificate

*OAuth 2.0 for First-Party Applications* is the newer protocol that replaces the `init`
endpoints, and it is almost certainly the intended path in this release. It is now **enabled**
in this org (both flags were needed):

| Flag | Where | Now |
|---|---|---|
| `isFirstPartyAppsAllowed` | `Network` metadata (site → Login & Registration) | `true` |
| `isFirstPartyAppEnabled` | `ExtlClntAppOauthSettings` metadata (the app) | `true` |

Enabling only the site flag gives `first party applications not enabled for application` — the
app has its own switch, reachable via:

```powershell
sf project retrieve start --metadata "ExtlClntAppOauthSettings" --target-metadata-dir tmp
# set <isFirstPartyAppEnabled>true</isFirstPartyAppEnabled>
sf project deploy start --metadata-dir tmp/unpackaged
```

The endpoint is `POST <site>/services/oauth2/v1/authorization_challenge` (the unversioned path
also answers; `/services/oauth2/challenge` is a 404). Per the docs its body takes `username`,
`password`, `client_id`, `code_challenge` — and **`client_assertion`**, described as "the client
attestation JWT that you generated, signed by the certificate".

Every request without a valid one returns:

```json
{"error_description":"invalid assertion","error_code":"invalid_grant","error":"invalid_request"}
```

A dummy `client_assertion` value returns the identical error, confirming it is required and
verified. `auth_request_type`, `client_secret` and the `Auth-Request-Type` header make no
difference — the assertion check happens first.

**So this path is viable but needs a certificate**: generate a signing cert, register it on the
External Client App for client attestation, then have the BFF mint and sign a JWT per request.
That is real work, but it is well-defined, unlike the `init`-endpoint dead end above.

### Choosing between the three routes

| Route | Blocked on | Effort |
|---|---|---|
| `init` endpoints + *Require authentication* | Unknown — no credential we can mint is accepted | Unknown; ask Support |
| First-party `authorization_challenge` | A client attestation certificate + JWT signing | Defined: cert setup + ~40 lines |
| `init` endpoints + reCAPTCHA | A Google reCAPTCHA key, and a real solve in the browser | Small code change, but the demo has to show a captcha |

The first-party route is the recommended one: it is the direction Salesforce is moving, it
needs no captcha in the demo, and the failure mode is now fully understood.

---

## Code changes made to the repo

| File | Change |
|---|---|
| `app/hxl.js` | PKCE (S256) on all three code-producing flows |
| `app/hxl.js` | `call()` gained `{ redirectOk }`; `authorize()` reads the code from a 302 `Location` |
| `app/hxl.js` | `apiHost()` — data calls use `instance_url`, not `SF_SITE_URL` |
| `app/hxl.js` | `getAppAccessToken()` + `initHeaders(flow)` — per-flow client-credentials bearer |
| `app/server.js` | passes `s.tokens.instance_url` into `userinfo` / `getMyOrders` / `createOrder` |
| `.env` / `.env.example` | `SF_INIT_AUTH_FLOWS` (replaced `SF_INIT_REQUIRES_AUTH`) |
| `force-app/.../HXL_Customer_Access` | dropped `Status__c` fieldPermissions; added `ApiEnabled` |
| `scripts/verify-setup.ps1` | fixed single-record array unrolling |

`SF_INIT_AUTH_FLOWS` is a comma-separated list of `registration`, `passwordless`,
`forgot_password` — only those flows get a bearer. **A bearer sent to an endpoint that is not
expecting one is itself rejected as an authentication failure**, which is why this is per-flow
and not a single boolean.

---

## Useful commands

```powershell
sf org open --path lightning/setup/SetupNetworks/home     # All Sites
sf org open --path lightning/setup/ApexClasses/home       # Apex classes

# Read the site's live headless config - the UI form lies, this does not
sf project retrieve start --metadata "Network:HXL Store" --target-metadata-dir <dir>
# then look at networkAuthApiSettings in <dir>/unpackaged/networks/HXL Store.network

sf data query --query "SELECT Id, Name, Status, UrlPathPrefix FROM Network"
sf data query --query "SELECT Id, Name, Total_Amount__c, Owner_Contact__r.Name FROM HXL_Order__c"

powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipTests
powershell -ExecutionPolicy Bypass -File scripts/verify-setup.ps1
```

**The UI form silently fails to save.** Several times a page looked saved and had not been —
the role, `selfRegistration`, and the registration auth flag. Always confirm against metadata
or SOQL rather than the screen.

If the BFF will not start with `EADDRINUSE`, a stale `node` still holds the port:

```powershell
netstat -ano | findstr ":3000"
taskkill /PID <pid> /F
```
