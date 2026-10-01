# 0004 · Build Authentication from Primitives Instead of a Framework

- Status: Accepted
- Date: 2026-10-01
- Related: [design/04](../design/04-auth.md)

## Context

We need passwords, TOTP, passkeys (WebAuthn), recovery codes, session management, sudo mode (step-up for dangerous operations), API tokens, and RBAC.

Authentication frameworks such as better-auth have a drawback here: the framework registers and exposes a whole set of API routes automatically, many of which we do not need. Their behavior is defined by the framework, can change on upgrade, and each route is attack surface. For "the front door to root on every server", we want every authentication endpoint to be defined and reviewed by us.

Also, a panel typically has one to a handful of administrators. It does not need social login, organizations, invitations, email verification, or other generic SaaS authentication features.

## Decision

No authentication framework. Assemble it from focused, single-purpose libraries:

- WebAuthn: `@simplewebauthn/server` + `@simplewebauthn/browser`
- TOTP: `@oslojs/otp`
- Encoding: `@oslojs/encoding`
- Password hashing: `@node-rs/argon2` (Argon2id)
- Sessions: our own implementation, following the session guide maintained by Lucia's author (the Lucia library itself was deprecated and turned into learning material)

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Build from primitives (chosen) | We fully control the endpoints; no unused features; transparent, auditable behavior; a few hundred lines of code | We are responsible for correctness (sessions, constant-time comparisons, replay protection, …) and need thorough tests |
| better-auth | Full-featured, widely used | Exposes many routes automatically; plugin system adds complexity; behavior changes between versions |
| Lucia | Used to be the go-to lightweight option | Deprecated in 2025 |
| Auth.js / Passport | Mature ecosystems | OAuth/social-login oriented; passkeys, TOTP, and sudo mode are not first-class |
| External IdP (Authelia, Authentik, Keycloak) | Strong authentication features | Too heavy for a lightweight panel; extra deployment dependency; still possible later as an optional OIDC login |

## Consequences

- Positive: every authentication route is listed in [design/04](../design/04-auth.md) §9 and there are no others, which makes focused security review possible.
- Negative: correctness is on us. Required: RFC 6238 test vectors, end-to-end WebAuthn tests with a virtual authenticator, and the authorization matrix test (see [design/10](../design/10-testing.md)).
- Revisit when: OIDC/SSO is needed. Add an OIDC client as one more login method (P2) rather than replacing the authentication system.
