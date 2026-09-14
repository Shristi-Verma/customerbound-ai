# Security

## Secrets

Never commit `.env` files, Salesforce CLI state, Claude configuration, access or refresh tokens, client secrets, passwords, session stores, or temporary tunnel URLs. Use the committed `.env.example` files as templates and store real values in a local secret manager for anything beyond a throwaway POC.

If a secret is committed, remove it from Git history and rotate it immediately. Deleting it in a later commit is not sufficient.

## POC boundary

The current local flow can supply a dedicated test-user password to the MCP process. This is limited to controlled POC use. Production must use MCP OAuth or an equivalent interactive authorization flow so credentials do not enter model context, configuration shared with a host, or chat transcripts.

## Hosted transport

Keep `HXL_ALLOW_ENV_IDENTITY=0` on hosted transports. A public endpoint must never assign every unsigned session to a configured local identity. Use stable TLS hosting, durable encrypted sessions, explicit expiry and logout, request validation, rate limiting, audit logs, and operational monitoring before production use.

## Salesforce authorization

Preserve user-mode access, record sharing, field permissions, Apex business rules, and user-context writes. Do not replace Salesforce enforcement with model instructions or caller-supplied owner filters.

## Reporting

Report suspected credential exposure or access-control issues privately to the repository owner. Do not include live credentials or customer data in an issue.
