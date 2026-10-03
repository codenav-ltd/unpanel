# Maintenance Knowledge Base

This directory records **behavior details of external systems, formulas, limits, pitfalls, and operational runbooks**. Design docs say "how we will do it"; the KB says "how the outside world works".

## Rules

1. Every external fact names its source and verification status:
   - ✅ Verified (with link and verification date)
   - ⚠️ Unverified: written from experience; **must be re-checked when implementing the related feature**, then changed to ✅
2. Numeric facts (limits, version numbers, defaults) go stale fastest. Always state "as of when".
3. When you hit a new pitfall: fix it first, then add an entry to the relevant KB's "Pitfalls" section (symptom → cause → fix) and an index line in [troubleshooting.md](./troubleshooting.md).
4. Runbooks must be followable step by step, with the exact command for each step.

## Index

### External systems

| Document | Content |
|---|---|
| [linux-metrics.md](./linux-metrics.md) | `/proc` and `/sys` fields, metric formulas, container environment differences |
| [docker-engine-api.md](./docker-engine-api.md) | Engine API, stats math, log multiplexing, events, Compose labels, image update checks, cgroup paths |
| [pm2.md](./pm2.md) | PM2 directory layout, `jlist` fields, multiple users, version mismatch |
| [nginx.md](./nginx.md) | Distro config layouts, `-t`/`-T`, version differences, SELinux, OCSP |
| [acme-letsencrypt.md](./acme-letsencrypt.md) | ACME flow, Let's Encrypt lifetimes and rate limits, ARI, common failures |
| [webauthn-passkey.md](./webauthn-passkey.md) | RP ID, origins, counters, conditional UI, SimpleWebAuthn usage |
| [totp.md](./totp.md) | RFC 6238, test vectors, replay protection |
| [telegram-bot-api.md](./telegram-bot-api.md) | Send limits, HTML formatting, long-polling conflicts, network issues |
| [systemd-journald.md](./systemd-journald.md) | `systemctl`/`journalctl` output, `systemd-run --scope`, sandbox options, SSH unit name differences |
| [firewall.md](./firewall.md) | ufw, nftables, Docker bypassing ufw, avoiding lockouts |
| [node-runtime.md](./node-runtime.md) | Node versions, glibc, native modules, memory tuning, bundling |

### Project

| Document | Content |
|---|---|
| [glossary.md](./glossary.md) | Glossary |
| [ui-reference-3x-ui.md](./ui-reference-3x-ui.md) | 3x-ui as a UI reference: what to borrow and what not to |
| [conventions.md](./conventions.md) | Code and collaboration conventions |
| [security-checklist.md](./security-checklist.md) | Pre-release security checklist |
| [release-process.md](./release-process.md) | Versioning, builds, signing, publishing |
| [security-updates.md](./security-updates.md) | Advisory severity, affected versions, critical-update policy, reminders and publisher workflow |
| [panel-https.md](./panel-https.md) | Panel HTTPS, domain issuance, trust, renewal, and access migration |
| [account-security.md](./account-security.md) | Managed 2FA methods, policy, shared email delivery, recovery and downgrade compatibility |
| [users-and-permissions.md](./users-and-permissions.md) | Team mode, roles, node scopes, locked live-demo accounts and access revocation |
| [troubleshooting.md](./troubleshooting.md) | Troubleshooting index |
| [runbooks.md](./runbooks.md) | Operational runbooks |
| [terminal-management.md](./terminal-management.md) | Services, logs, updates, sudo guidance and local sign-in recovery |
