# Security Policy

This project manages servers with root privileges, so we take security reports seriously and appreciate responsible disclosure.

## Supported versions

No version has been released yet. Once releases begin:

| Version | Supported |
|---|---|
| Latest minor of the current major | ✅ Security fixes |
| Latest minor of the previous major | ✅ Critical fixes for 6 months after the new major |
| Older | ❌ |

## Reporting a vulnerability

**Please do not report vulnerabilities in public issues, discussions, or pull requests.**

Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/codenav-ltd/unpanel/security/advisories/new) on the repository's Security tab. If that is not available, contact the maintainers at the address that will be listed here before the first release.

Please include:

- affected version or commit;
- component (panel, agent, installer, web UI);
- steps to reproduce or a proof of concept;
- impact as you understand it (e.g. "authenticated viewer can execute commands on nodes");
- whether the issue is already public.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | Within 3 business days |
| Initial assessment and severity | Within 10 business days |
| Fix for critical/high severity | As fast as possible, normally within 30 days |
| Coordinated disclosure | Within 90 days of the report, or earlier once a fix is released |

We will credit reporters in the advisory unless they prefer to stay anonymous.

## Scope

In scope: the panel, the agent, the installer scripts, the web UI, the agent protocol, and the release/upgrade process.

Especially interesting:

- authentication or authorization bypass (including RBAC scope escapes and sudo-mode bypass);
- ways for a compromised panel to escalate beyond the node-local policy on agents;
- command or configuration injection through any feature (Nginx templates, cron, Docker, PM2, firewall);
- path traversal in the file manager or archive extraction;
- signature or handshake weaknesses in the agent protocol or the upgrade process;
- secrets leaking into logs, API responses, or the browser.

Out of scope: issues requiring root on the managed host, social engineering, denial of service by an authenticated owner, vulnerabilities in third-party software the panel manages (report those upstream), and findings from automated scanners without a demonstrated impact.

## Release signing

Release artifacts are signed with minisign (Ed25519). The public key will be published here and in the README with the first release. See [docs/kb/release-process.md](./docs/kb/release-process.md).

## Design

The threat model and hardening measures are documented in [docs/design/05-security.md](./docs/design/05-security.md).
