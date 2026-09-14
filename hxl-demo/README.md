# HXL Demo — Headless Experience Layer on Salesforce

> **Naming — read this first.** This project is **Salesforce Headless Identity**:
> login, registration and password reset with no Salesforce-hosted UI, built on an
> Experience Cloud site and OAuth. It is **not** the Salesforce **Headless Experience
> Layer (HXL)** — the Beta where you describe a UI once as Mosaic JSON and Slack,
> Agentforce, ChatGPT or Claude render it natively. Both get called "HXL" in
> conversation; they are unrelated Salesforce features. The folder name `hxl-demo`
> predates that discovery. The Headless Experience Layer work lives in
> `../hxl-experience-layer/`. See `../README.md` for how the two fit together.


A working demo of a **custom front end with Salesforce behind it and no Salesforce UI anywhere**:
users register, log in, reset passwords and read their own records without ever seeing a
Salesforce-hosted page or a `*.force.com` redirect.

It covers all four Headless Identity flows plus the data half that makes the point land.

```
  browser                    HXL layer (this repo)              Salesforce
 ┌─────────┐   session     ┌──────────────────────┐  OAuth    ┌──────────────────┐
 │ your UI │──cookie──────▶│ Node BFF (app/)      │──────────▶│ Experience Cloud │
 │ (no SDK)│◀──────────────│ holds client secret  │◀──Bearer──│ site + Apex REST │
 └─────────┘    JSON       │ holds access tokens  │           └──────────────────┘
                           └──────────────────────┘
```

**The one-line pitch:** Salesforce keeps identity, sharing and data. You keep the entire
experience. Nothing about the UI has to look like, or be built with, Salesforce.

---

## What's in here

| Path | What it is |
|---|---|
| `app/hxl.js` | Client for the four Headless Identity APIs. Read this one on stage — it's the whole protocol in ~250 lines. |
| `app/server.js` | The BFF. Holds the client secret and the tokens; the browser gets only an HttpOnly cookie. |
| `app/public/` | The custom front end. No Salesforce SDK, no client id, no token handling. |
| `force-app/.../HXL_OrderAPI.cls` | Apex REST endpoint scoped to the token's Contact. Proves the token is a *named user*, not an integration. |
| `force-app/.../HXL_Order__c` | Demo custom object. |
| `force-app/.../HXL_Customer_Access` | Permission set for the site's customer users. |
| `SETUP.md` | **Start here.** Org signup, CLI connection, and every click needed in the org. |
| `HXL_ORG_CONTEXT.md` | The live org's details, what works today, and every dead end already explored. Read when resuming. |
| `scripts/setup.ps1` | Deploys the Salesforce side and installs npm deps. |
| `scripts/verify-setup.ps1` | Pre-flight check. Run before every demo. |
| `scripts/seed-demo-data.apex` | Seeds orders, including one belonging to *another* contact. |
| `config/project-scratch-def.json` | Scratch org definition, for the CI path only. |

---

## The four flows, in one table

Every flow ends at the same place — an authorization code exchanged with the standard
`grant_type=authorization_code`. The only thing that varies is **how the code is obtained**.

| Flow | Init call | Authorize header | Notes |
|---|---|---|---|
| **Login** | — | `Auth-Request-Type: Named-User` + `Authorization: Basic base64(user:pass)` | One round trip. |
| **Registration** | `POST /services/auth/headless/init/registration` | `Auth-Request-Type: user-registration`, `Auth-Verification-Type: email` + `Basic base64(identifier:otp)` | Creates the user *and* signs them in. |
| **Passwordless** | `POST /services/auth/headless/init/passwordless/login` | `Auth-Request-Type: passwordless-login`, `Auth-Verification-Type: email` + `Basic base64(identifier:otp)` | No password anywhere in the exchange. |
| **Forgot password** | `POST /services/auth/headless/forgot_password` | *(none — no authorize step)* | Same endpoint twice: request OTP, then reset with `otp` + `newpassword`. |

Authorize is always `POST <site>/services/oauth2/authorize` with `response_type=code_credentials`.

> **Host matters, and it changes after the token.** Every *identity* call above goes to the
> **Experience Cloud site** domain (`mydomain.my.site.com/yoursite`), never to
> `login.salesforce.com`. Against the wrong host you get a 302 to a hosted login page — the
> exact thing HXL exists to avoid, and `hxl.js` says so rather than failing obscurely.
>
> The **data** calls are the opposite: the site 302-redirects `/services/apexrest/*` to its own
> login page, so those go to the `instance_url` that came back with the token. `hxl.js` handles
> this split for you.
>
> One more wrinkle: a *successful* headless authorize can answer `302` with the code in the
> `Location` header rather than as JSON. That is the happy path, not a bounce.

---

## Org setup

**→ Full step-by-step guide: [SETUP.md](SETUP.md).** Follow it in order; the steps are
interdependent and several fail with errors that don't name the real cause.

**→ [HXL_ORG_CONTEXT.md](HXL_ORG_CONTEXT.md) — read this if you are picking the project back
up.** It records the live org's details, which of the four flows actually work today, every
way this org diverges from SETUP.md, and the dead ends already explored so you don't repeat
them.

Short version, once you have a free Developer Edition org
(<https://developer.salesforce.com/signup>):

```powershell
npm install --global @salesforce/cli
sf org login web --alias hxl
sf config set target-org hxl
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Then in the org: enable the org-level OAuth flag, give your admin a role, clone a community
profile, create an Experience Cloud site, create the connected app, and enable the headless
APIs on the site. Fill in `.env`, then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-setup.ps1
sf apex run --file scripts/seed-demo-data.apex
npm start
```

Open <http://localhost:3000>. The badge top-right turns green when `.env` is filled in.

### Three prerequisites that catch everyone

1. **Two OAuth flags, not one.** *Allow Authorization Code and Credentials Flows* exists both
   org-wide (Setup → OAuth and OpenID Connect Settings) **and** on the connected app. Both must
   be on. With either missing you get a redirect to a hosted login page instead of JSON.
2. **Your admin user needs a role.** Self-registration creates portal users under a business
   Account, and Salesforce refuses when the account owner has no role. The error doesn't
   mention roles.
3. **The permission set must reach the *site's* profile**, not just you. A perfectly valid
   token otherwise gets a 403 from Apex.

---

## Demo script (~12 minutes)

> **Status check before you rehearse this.** Against the current org only the **Login** flow
> and the data half work end to end. Registration, Passwordless and Forgot Password are blocked
> on an unresolved `init`-endpoint authentication problem — see
> [HXL_ORG_CONTEXT.md](HXL_ORG_CONTEXT.md). The 1:00 and 8:00–11:00 beats below assume all four
> flows; cut or adapt them until that is fixed.

**Before you start:** have the org open in one tab, `http://localhost:3000` in another, and
your OTP inbox in a third. Keep the terminal visible — `HXL_DEBUG=1` prints every Salesforce
request and response, and the wire log panel in the UI mirrors it.

**0:00 — Frame it (1 min).**
"This is a store front end. Nothing on this screen is Salesforce. There is no iframe, no
embedded component, no redirect. Watch the address bar for the whole demo — it never leaves
localhost." Point at the wire log: "and this shows you exactly which Salesforce endpoint each
action hits, so nothing's hidden."

**1:00 — Registration (3 min).**
Register tab → real email → **Create account**. Point at the wire log:
`POST /services/auth/headless/init/registration`. Show the OTP email. Paste the code →
**Verify & sign in**. Point out the two calls that follow: `authorize` with
`Auth-Request-Type: user-registration`, then the token exchange.
**The beat:** switch to the org, search the new user in Setup. "That user was created,
verified and logged in without one pixel of Salesforce UI."

**4:00 — The token, and where it lives (2 min).**
The token card shows a *preview* only. "The browser never gets this. It has an HttpOnly cookie;
the access token and the client secret live in the layer. That's the difference between a
headless *layer* and shipping OAuth into a browser."

**6:00 — Data, scoped by identity (2 min).**
Orders load from Apex REST. Then the money moment: "The seed script created an order for
*nine thousand nine hundred and ninety-nine dollars* belonging to a different contact. It is
not in this list, and I never passed a user id — the Apex reads the Contact off the token."
Place an order, watch it appear.

**8:00 — Passwordless (2 min).**
Sign out. Passwordless tab → same email → **Send code** → paste. "Same destination, no password
in the exchange at all. Same three-call shape. Once you've built the layer, adding a flow is
a header change."

**10:00 — Forgot password (1 min).**
Forgot tab → send code → reset → sign in on the Login tab with the new password. "The one flow
with no authorize step — it doesn't produce a session, it just changes the password."

**11:00 — Close (1 min).**
"Everything you saw is Salesforce identity, Salesforce sharing, Salesforce data. What you
didn't see is Salesforce UI. Swap this front end for React, Next, iOS, a kiosk, a set-top box
— the layer doesn't change."

### Questions you will get

- *"Is this Experience Cloud licensing?"* — Yes. Headless Identity runs through an Experience
  Cloud site; the users are Customer Community (or Partner) users and are licensed as such.
  The site being invisible doesn't make it free.
- *"What about SSO / social login?"* — There's a headless flow for that too (headless SSO with
  an external auth provider). Same shape, different init call. Not wired up here.
- *"Why the BFF? Can't the SPA call Salesforce directly?"* — It can, as a *public* client with
  PKCE and reCAPTCHA. Then the tokens live in the browser and the init endpoints are
  internet-facing and unauthenticated. The BFF exists so neither is true.
- *"Rate limits?"* — The headless auth endpoints are subject to org API limits and their own
  throttling; OTP sends in particular are rate-limited per user. Size it in a real design.
- *"Does this work for internal users?"* — No. Headless Identity is for external identity —
  Customer and Partner users on a site.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Salesforce redirected instead of answering headlessly` | Connected app is missing **Authorization Code and Credentials Flow**, or you're hitting the wrong host. |
| `404` on an `/services/auth/headless/...` endpoint | Site isn't published, or that specific headless API isn't enabled in Login & Registration settings. |
| `invalid_client_id` / `invalid_client` | Consumer key/secret mismatch, or the connected app needs a few minutes after creation to propagate. |
| `redirect_uri_mismatch` | `SF_REDIRECT_URI` differs from the connected app callback by even a trailing slash. |
| Sign-in works, orders call returns 403 | The permission set isn't assigned to the *site's* profile (step 5). |
| Orders list is empty, `contactId` is null in the wire log | The token belongs to a user with no Contact — you logged in as an internal user, not a community user. |
| OTP email never arrives | Deliverability in a scratch/sandbox org is often set to *System email only*. Setup → **Deliverability → Access level: All email**. |
| `invalid_grant` on the token exchange | The authorization code is single-use and short-lived — you replayed one, or the clock skewed. |

---

## Notes and caveats

- **This is demo-grade custody.** Sessions and tokens live in an in-memory `Map` and the cookie
  is not `Secure` (localhost is http). For anything real: Redis or equivalent, `Secure` +
  `SameSite`, TLS, CSRF protection on the state-changing routes, and refresh-token rotation.
- **API version is pinned to 63.0** in `sfdx-project.json` and the Apex meta files. Bump if your
  org is newer.
- **`HXL_OrderAPITest` degrades gracefully** in orgs with no portal-enabled profile: the
  contact-scoped test returns early rather than failing. Deploy against an org with a site
  configured to get the meaningful coverage.
- The request handle returned by the `init` endpoints is read as `identifier` with a fallback to
  `request_id`, because Salesforce has used both across releases.

## References

- [What Is Headless Identity? — Salesforce Developers](https://developer.salesforce.com/docs/atlas.en-us.headless_identity.meta/headless_identity/headless_identity_what_is_it.htm)
- [Headless Registration Flow for Public Clients](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_headless_registration_public_clients.htm&language=en_US&type=5)
- [Headless Registration Flow for Private Clients](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_headless_registration_private_clients.htm&language=en_US&type=5)
- [Headless Passwordless Login Flow for Private Clients](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_headless_passwordless_login_private_clients.htm&language=en_US&type=5)
- [Headless Identity for Customers and Partners](https://help.salesforce.com/s/articleView?id=sf.headless_identity_customers_overview.htm&language=en_US)
- [Headless Identity Basics — Trailhead](https://trailhead.salesforce.com/content/learn/modules/headless-identity-basics/get-to-know-headless-identity-features)
