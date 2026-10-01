# Pre-Release Security Checklist

> Run before every minor and major release; patch releases run the sections touched by the change. Record the result in the release PR. Threat model: [design/05](../design/05-security.md).

## Authentication and sessions

- [ ] No default credentials; first-run setup requires the setup token, which is deleted afterwards
- [ ] Session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`
- [ ] Session tokens stored only as SHA-256 hashes; rotated on login and privilege change
- [ ] Idle and absolute session timeouts enforced server-side
- [ ] Sudo mode required for every `risk: danger` route (authorization matrix test green)
- [ ] TOTP replay protection (`totp_last_step`) and RFC 6238 vectors pass
- [ ] WebAuthn verifies origin, RP ID, challenge, and user verification policy; counters updated
- [ ] Login, second factor, enrollment, and token endpoints are rate limited; lockout messages do not reveal whether a user exists
- [ ] API tokens: hashed, scoped, expirable, `danger` disabled unless explicitly allowed

## Authorization

- [ ] Every route is registered through `nodeRoute()` or declares a permission explicitly; no unauthenticated routes beyond the documented list in design/04 §9
- [ ] Lists and WebSocket topics are filtered by the caller's node scope
- [ ] Authorization matrix test covers all routes × built-in roles × scopes × user modes
- [ ] `auth.userMode` is never read inside `can()`; single-user mode only hides features

## Web

- [ ] CSP: no `unsafe-eval`; `style-src` decision documented (see kb/ui-reference-3x-ui.md §6)
- [ ] `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'none'`, HSTS when on a domain
- [ ] CSRF: Origin check on all non-GET requests and the WebSocket handshake
- [ ] No `v-html` with external data
- [ ] Uploads streamed, size-limited, never executed or served from the panel origin

## Agent and protocol

- [ ] Handshake: mutual Ed25519 authentication; pinned panel key; close codes as specified
- [ ] Dangerous requests carry valid signatures; timestamp window and nonce cache enforced
- [ ] No generic command execution method exists; every `execFile` uses argument arrays; no `shell: true` (lint rule green)
- [ ] All filesystem methods resolve `realpath` before policy checks
- [ ] Local policy defaults reviewed (`term`, `fs`, `docker.allow_privileged_create`, `probe.deny_cidrs`, `methods.deny`)
- [ ] Frame parser fuzz tests pass; frame and stream size limits enforced

## Data at rest

- [ ] Secrets in the database are encrypted (`_enc` columns) with AAD; no plaintext secrets in `settings`
- [ ] `master.key`, `identity.key` modes 0600 with correct owners
- [ ] Backups of keys only when the user opts in with a passphrase
- [ ] Logs: redact paths cover all secret-bearing fields (grep test over log fixtures)

## Supply chain and release

- [ ] `pnpm audit` (or equivalent) has no unaddressed high/critical issues in runtime dependencies
- [ ] New dependencies reviewed per [conventions.md](./conventions.md) §10; license check over production dependencies passes
- [ ] Release artifacts reproducible from the tag in CI; `SHA256SUMS` signed with the release key
- [ ] Upgrade path verifies the signature before installing
- [ ] systemd sandbox score checked with `systemd-analyze security unpanel.service` (no regression)

## Documentation

- [ ] `SECURITY.md` contact and supported versions up to date
- [ ] Security-relevant changes noted in `CHANGELOG.md`
