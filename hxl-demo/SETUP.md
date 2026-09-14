# HXL POC — org setup, start to finish

> **Naming — read this first.** This project is **Salesforce Headless Identity**:
> login, registration and password reset with no Salesforce-hosted UI, built on an
> Experience Cloud site and OAuth. It is **not** the Salesforce **Headless Experience
> Layer (HXL)** — the Beta where you describe a UI once as Mosaic JSON and Slack,
> Agentforce, ChatGPT or Claude render it natively. Both get called "HXL" in
> conversation; they are unrelated Salesforce features. The folder name `hxl-demo`
> predates that discovery. The Headless Experience Layer work lives in
> `../hxl-experience-layer/`. See `../README.md` for how the two fit together.


Follow this in order. Steps 6–8 are the ones that fail silently if skipped, and step 4 is the
one nobody expects.

> **Read [HXL_ORG_CONTEXT.md](HXL_ORG_CONTEXT.md) first if you are working with the existing
> `hxl` org.** Newer orgs (External Client Apps, forced PKCE, mandatory auth on the headless
> `init` endpoints) diverge from this guide in ways that cost a day to rediscover. That file
> records what is proven working, what is still broken, and every dead end already explored.

Budget ~45 minutes the first time.

---

## 0. Which org to use

**Use a free Developer Edition org.** Sign up at <https://developer.salesforce.com/signup>.

| | Developer Edition | Scratch org |
|---|---|---|
| Cost | Free, permanent, never expires | Free, but expires in 7–30 days |
| Experience Cloud licenses | 10 of each Communities license type | Inherited from Dev Hub |
| Setup effort | Configure once | Reconfigure every time it expires |
| Good for | **A POC you demo repeatedly** ← you | Repeatable CI, throwaway dev |

Headless Identity needs an Experience Cloud site, and a large part of that site's config
(Login & Registration settings, connected app policies, profile membership) is **click work
that doesn't travel in metadata**. On a scratch org you redo it every week. For a POC, take
the Developer Edition org.

> A scratch-org path is included at the bottom if you want it later for CI. Not the fast route
> to a working POC.

### Signing up

- Use a **real email you can open** — every headless flow in this demo sends an OTP there.
- Email must be unique across all Salesforce orgs; if yours is taken, Gmail's `you+hxl@gmail.com`
  trick works.
- Username must be globally unique and look like an email but does **not** have to be one:
  `you.hxl@hxlpoc.demo` is fine and keeps it memorable.
- Company: anything. Role: Developer.
- Confirm via the email, set a password, and note the username + password.

---

## 1. Connect the Salesforce CLI

```powershell
npm install --global @salesforce/cli
sf --version
```

Then authenticate — this opens a browser, log in with the DE org credentials:

```powershell
sf org login web --alias hxl --instance-url https://login.salesforce.com
sf config set target-org hxl
sf org display
```

`sf org display` should show your username and `Connected Status: Connected`. From here on,
every `sf` command in this project targets that org without `--target-org`.

---

## 2. Deploy this project's metadata

```powershell
cd D:\personal\hxl-demo
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

This deploys `HXL_Order__c`, `HXL_OrderAPI`, and the `HXL_Customer_Access` permission set, and
runs `HXL_OrderAPITest`. Do it now — later steps reference the permission set by name.

---

## 3. Turn on the org-level OAuth flag

**Setup → quick find "OAuth" → OAuth and OpenID Connect Settings**

- ✅ **Allow Authorization Code and Credentials Flows**

This is org-wide and **separate from the identical-sounding checkbox on the connected app in
step 7**. You need both. Missing this one produces a redirect to a hosted login page instead
of a JSON response — `hxl.js` will tell you so explicitly, but it's a confusing 20 minutes if
you don't know the setting exists.

While you're in Setup, also fix email delivery, or no OTP will ever arrive:

**Setup → quick find "Deliverability" → Access to Send Email → All email**

---

## 4. Give your admin user a role

**Setup → Roles → Set Up Roles** → create one (any name, e.g. "CEO" if the tree is empty).
Then **Setup → Users → your user → Edit → Role** → assign it.

Why: self-registration creates a Customer Community user hanging off a business Account, and
Salesforce refuses to create portal users under an account whose **owner has no role**. The
error text doesn't mention roles. Do this before you try to register.

**Verify it actually saved** — this page has been observed reporting success without
persisting the role:

```powershell
sf data query --query "SELECT Name, UserRole.Name FROM User WHERE Username='<your username>'"
```

If `UserRole.Name` is blank, set it directly:

```powershell
sf data query --query "SELECT Id, Name FROM UserRole WHERE ParentRoleId = null"
sf data update record --sobject User --where "Username='<your username>'" --values "UserRoleId=<role id>"
```

---

## 5. Create the profile and the account for external users

**Profile** — Setup → Profiles → clone **Customer Community User** → name it `HXL Customer`.
(If your DE org shows "Customer Community Plus User", either works; Plus gives you sharing
rules and reports, which you don't need here.)

Then edit `HXL Customer`:
- Custom Object Permissions → **HXL Order**: Read + Create
- Enabled Apex Class Access → add **HXL_OrderAPI**

(The `HXL_Customer_Access` permission set grants the same things — use whichever you prefer,
but grant it *somewhere* or step 12 returns 403.)

Two things the original guide missed:

- **Note the exact profile name you type**, including case. Every dropdown later expects it
  verbatim, and the metadata records it lowercased.
- **Community users also need `API Enabled`**, or Apex REST answers
  `APEX_REST_SERVICES_DISABLED` even with a perfectly valid token. `HXL_Customer_Access` now
  grants it. Note that Customer Community licences do not normally include API access —
  Customer Community *Plus* is the licence that formally does. Confirm your licensing before
  relying on it.

**Account** — switch to the Sales app → Accounts → New → name it `HXL Demo Customers`. Confirm
it's owned by the user you just gave a role to. Self-registered users become Contacts under
this Account.

---

## 6. Create the Experience Cloud site

1. **Setup → Digital Experiences → Settings** → ✅ *Enable Digital Experiences*.
   Pick a domain name — it becomes `<yourdomain>.my.site.com` and **cannot be changed later**.
   On the same page tick ✅ *Allow using standard external profiles for self-registration, user
   creation, and login*. Without it, self-registration and `HXL_OrderAPITest` both fail with an
   error that names this setting but that you will not see until much later.
2. **Setup → All Sites → New**
   - Template: **Build Your Own (LWR)**
   - Name: `HXL Store`, URL suffix: `hxlstore`
3. Wait for it to build (a minute or two), then open **Workspaces → Builder → Publish**.
   An unpublished site returns 404 on every headless endpoint.
4. **Workspaces → Administration → Members** → add the `HXL Customer` profile.
5. **Workspaces → Administration → Settings** → note the full site URL.

That URL is your `SF_SITE_URL`, e.g. `https://yourdomain.my.site.com/hxlstore`.

**You will see two sites, and that is normal.** Salesforce creates a companion site alongside
the LWR one. `SELECT Id, Name, UrlPathPrefix, SiteType FROM Site` shows both; the
`ChatterNetworkPicasso` row with your chosen prefix is the real one. Token responses may report
`sfdc_community_url` pointing at the companion — harmless.

---

## 7. Create the connected app

**Setup → App Manager → New Connected App** (if your org offers External Client Apps as well,
either works — but the newest orgs only offer External Client Apps, and their policy screen is
laid out differently. See the notes at the end of this step.)

Basic info: name `HXL Layer`, your email.

**API (Enable OAuth Settings):**
- ✅ Enable OAuth Settings
- Callback URL: `http://localhost:3000/callback` — must match `SF_REDIRECT_URI` **exactly**, no trailing slash
- Selected scopes: `Manage user data via APIs (api)`, `Perform requests at any time (refresh_token, offline_access)`, `Access the identity URL service (openid)`
- ✅ **Enable Authorization Code and Credentials Flow** ← the app-level twin of step 3
- ✅ Require Secret for Web Server Flow (we're a confidential client — the BFF holds the secret)
- **Require Proof Key for Code Exchange (PKCE)** — either setting works; `hxl.js` does PKCE
  (S256) on every authorize + token exchange. Some orgs force this on and grey it out
  ("To change this required setting, contact Support") — that is fine, nothing to do.

Save, then **wait 2–10 minutes** for it to propagate. Attempting to use it immediately gives
`invalid_client_id`, which looks like a typo and isn't.

**Then Manage → Edit Policies:**
- Permitted Users: **Admin approved users are pre-authorized**
- IP Relaxation: **Relax IP restrictions**
- Refresh Token Policy: Refresh token is valid until revoked

**Then Manage → Profiles → Manage Profiles** → add `HXL Customer`.
Skipping this with "Admin approved users" selected means every login is rejected as unauthorized.

> **Do not use "All users may self-authorize" as a shortcut.** It does not cover Experience
> Cloud users. With it set, a community user's authorize call fails with
> `invalid_app_access: user is not admin approved to access this app`. Admin-approved plus an
> explicit profile grant is the only combination that works for external users.

Copy the **Consumer Key** and **Consumer Secret** (View button).

### If your org uses External Client Apps

The settings map one-to-one but live in different places, and the form is easy to save in a
half-finished state. It is far more reliable to read and write the policy via the CLI:

```powershell
sf project retrieve start --metadata "ExtlClntAppOauthConfigurablePolicies" --target-metadata-dir tmp
# edit tmp/unpackaged/extlClntAppOauthPolicies/<app>_oauthPlcy.ecaOauthPlcy
sf project deploy start --metadata-dir tmp/unpackaged
```

A working policy looks like:

```xml
<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>
<ipRelaxationPolicyType>Bypass</ipRelaxationPolicyType>
<isClientCredentialsFlowEnabled>true</isClientCredentialsFlowEnabled>
<clientCredentialsFlowUser>your.admin@example.com</clientCredentialsFlowUser>
```

Two traps: saving the UI form overwrites whatever the CLI last deployed (including fields you
did not touch), and the client-credentials **Run As user must be an internal user** — a
community user is rejected with `access_denied — end-user denied authorization`.

---

## 8. Enable the headless APIs on the site

**All Sites → HXL Store → Workspaces → Administration → Login & Registration**

- **Self-registration**: ✅ Allow external users to self-register
  - Profile: `HXL Customer`
  - Account: `HXL Demo Customers` (pick it from the lookup rather than typing it — an
    unresolved lookup silently drops the whole self-registration block on save)
- Find the headless section and enable the flows you want to demo:
  - ✅ Headless Registration
  - ✅ Headless Forgot Password
  - ✅ Headless Passwordless Login

**This page will not save while any field shows a validation error**, including errors in
sections you are not using. In particular, ticking *"Use the headless user discovery handler
for this flow"* anywhere makes the *Headless User Discovery* handler and Run As fields
required. Leave it unticked unless you actually want user discovery.

**Headless Registration may demand a registration handler.** If Registration Handler and Run As
are starred and erroring, click *Create a headless registration handler template* — it
generates an Apex class matching your org's interface version. Do not hand-write one: the
interface signature has changed across releases (it is currently
`createUser(Id, Auth.UserData, String, String, String)`), and the generated template is the
only authoritative source. Then set Run As to your admin and Default Profile to `HXL Customer`.

**On "Require authentication to access this API" and reCAPTCHA.** Older orgs let you leave both
off. **Newer orgs require one or the other on each headless flow and will refuse to enable the
flow otherwise** — the Metadata API rejects it too, so there is no way around it:

```
To allow self-registration via the Headless Registration API, select either Require
authentication for this API or Require reCAPTCHA to access this API.
```

If you must tick *Require authentication*, set `SF_INIT_AUTH_FLOWS` in `.env` to the affected
flows so the BFF fetches a client-credentials token and sends it as a bearer on those calls
only. Be aware this path is **not currently working against a forced-auth org** — see
[HXL_ORG_CONTEXT.md](HXL_ORG_CONTEXT.md) for the full list of credentials already tried and
rejected.

Headless Login itself needs no site toggle — it's governed by the two OAuth flags from steps 3
and 7, which is why Login still works in orgs where the other three flows are blocked.

**Verify what actually saved.** This page reports success without persisting more often than
any other in this guide:

```powershell
sf project retrieve start --metadata "Network:HXL Store" --target-metadata-dir tmp
# check networkAuthApiSettings in tmp/unpackaged/networks/HXL Store.network
```

Look for `selfRegistration`, `selfRegProfile`, `isHeadlessUserRegistrationAllowed`,
`isPwdlessLoginAllowed` and `isForgotPwdAllowed`.

---

## 9. Fill in `.env`

```
SF_SITE_URL=https://yourdomain.my.site.com/hxlstore
SF_CLIENT_ID=<Consumer Key>
SF_CLIENT_SECRET=<Consumer Secret>
SF_REDIRECT_URI=http://localhost:3000/callback
SF_INIT_AUTH_FLOWS=
```

`SF_INIT_AUTH_FLOWS` is a comma-separated list of the headless `init` endpoints that have
*Require authentication to access this API* ticked on the site — any of `registration`,
`passwordless`, `forgot_password`. Leave it empty if none do. Only the listed flows get a
bearer token, because **a bearer sent to an endpoint that is not expecting one is itself
rejected as an authentication failure**.

---

## 10. Verify before you demo

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify-setup.ps1
```

It checks what the CLI can actually see — org connection, deployed metadata, site existence and
published status, connected app presence, `.env` completeness — and prints a checklist for the
click-work it can't inspect.

Two known false alarms: it warns *"No connected apps visible"* because `ConnectedApplication`
is not reliably queryable (and is the wrong object entirely for External Client Apps), and it
cannot see any of the site's headless toggles. Check those with the `Network` metadata retrieve
in step 8.

---

## 11. Seed data

```powershell
sf apex run --file scripts/seed-demo-data.apex
```

Edit `DEMO_EMAIL` at the top of that file first if you're not using `ada@example.com`.

---

## 12. Run it

```powershell
npm start
```

<http://localhost:3000> — badge top-right goes green when `.env` is valid.

**First run through, in this order:**
1. **Register** tab with a real email → OTP arrives → verify. This creates your test user.
2. Run the seed script again, with `DEMO_EMAIL` set to that email, so the account has orders.
3. Reload — orders appear, and the other contact's $9,999 order does not.

---

## Order of failure, if something breaks

Work down this list; it's ordered by how often each one is the culprit.

| Symptom | Check |
|---|---|
| Redirect instead of JSON | Steps 3 **and** 7 — both OAuth flags |
| `invalid_client_id` | Connected app not propagated yet (wait 10 min), or key mistyped |
| `redirect_uri_mismatch` | Trailing slash, `http` vs `https`, or port mismatch vs step 7 |
| 404 on `/services/auth/headless/...` | Site not published (step 6.3), or that flow not enabled (step 8) |
| `unauthorized_client` / user not approved | Step 7 Manage Profiles, or step 6.4 site membership |
| Registration fails oddly | Step 4 (admin role) and step 8 self-registration profile + account |
| No OTP email | Step 3 Deliverability → All email; also check spam |
| Login works, orders 403 | Step 5 — profile/permission set not granted to `HXL Customer` |
| Orders empty, `contactId: null` in wire log | You logged in as an internal user, not a community user |
| `invalid_app_access: user is not admin approved to access this app` | Step 7 — the app's Permitted Users must be **Admin approved** with the external profile added. "All users may self-authorize" does **not** cover Experience Cloud users |
| `APEX_REST_SERVICES_DISABLED` | The community user lacks `API Enabled` — step 5. Check your licence actually permits it |
| Apex REST 302s to the site login page | Data calls must go to the token's `instance_url`, not `SF_SITE_URL`. Identity uses the site host; data does not |
| `Salesforce redirected instead of answering headlessly` on a *successful* login | A successful authorize can answer `302` with the code in `Location`. `hxl.js` handles this; if you have modified `call()`, keep the `redirectOk` path |
| `include an authentication header or reCAPTCHA parameter` | That flow has *Require authentication* on but `SF_INIT_AUTH_FLOWS` does not list it |
| `authentication failure` on an `init` endpoint | The bearer was sent but rejected. Either the flow is listed in `SF_INIT_AUTH_FLOWS` when it should not be, or you have hit the unresolved wall — see HXL_ORG_CONTEXT.md |
| `access_denied — end-user denied authorization` on client credentials | The Run As user is a community user, or is not approved for the app. It must be an internal user |
| A setting you just saved has no effect | It probably did not save. Verify with a `Network` metadata retrieve or SOQL, not the screen |
| Deploy fails: `cannot deploy to a required field` | A `<required>true</required>` field cannot appear in `fieldPermissions` — remove that block |
| `HXL_OrderAPITest` fails on portal user creation | Digital Experiences settings — see step 6.1. Use `setup.ps1 -SkipTests` until then |

---

## Appendix — scratch org path (for CI later, not for the POC)

You need a Dev Hub first: in your DE org, **Setup → Dev Hub → Enable Dev Hub**. Then:

```powershell
sf org login web --alias devhub --set-default-dev-hub
sf org create scratch --definition-file config/project-scratch-def.json --alias hxlscratch --duration-days 30 --set-default
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

`config/project-scratch-def.json` enables the Communities feature so Digital Experiences is
available. **Everything from step 3 onward is still manual click work**, and you repeat it each
time the org expires. That's the reason this isn't the recommended POC path.
