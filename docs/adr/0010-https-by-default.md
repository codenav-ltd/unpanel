# 0010 · HTTPS by Default (Starting with a Self-Signed Certificate)

- Status: Accepted
- Date: 2026-10-01
- Related: [design/04](../design/04-auth.md) §6, [design/09](../design/09-deployment.md)

**Implementation status (alpha.19, 2026-10-03):** fresh direct-access installs now generate a self-signed certificate at startup and print its fingerprint. The Certificates page can apply a domain certificate issued through Let's Encrypt HTTP-01 or imported as PEM. Existing installs keep their current access mode until activation, and plain HTTP health checks remain available for update compatibility. Passkeys, a setup-time domain wizard, and the `tls.mode` configuration below remain design goals. See [the current runbook](../kb/panel-https.md).

## Context

- A freshly installed panel is usually reachable only at `IP:port`, without a domain, so no publicly trusted certificate is available.
- Many panels therefore default to plain HTTP, sending login passwords and session cookies in cleartext.
- Cookies with the `Secure` attribute only work over HTTPS (or on `localhost`), and WebAuthn requires a secure context.

## Decision

- The installer generates a self-signed certificate, so the panel is HTTPS from the very first visit. Browsers show a certificate warning; the installer prints the certificate's SHA-256 fingerprint for the user to compare.
- The setup flow guides the user to bind a domain and issue a proper certificate through the certificate center (`tls.mode = "managed"`), after which passkeys become available.
- Plain HTTP (`tls.mode = "off"`) is **only allowed** when listening on a loopback address or a Unix socket, for setups behind a reverse proxy or accessed through an SSH tunnel.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Self-signed HTTPS by default (chosen) | Encrypted from the first visit; cookies can always use `Secure` and the `__Host-` prefix | Browser warning on first visit; slightly worse first impression |
| HTTP by default, prompt to configure HTTPS | Smoothest first visit | Many users never configure it, leaving passwords and sessions in cleartext indefinitely |
| Automatically request an IP certificate at install | No warning | Let's Encrypt IP certificates require the short-lived profile and are not available everywhere; depends on outbound internet and port 80, high failure rate |

## Consequences

- Positive: there is never a "password in cleartext" phase.
- Negative: users must trust the certificate manually on first visit; the UI must explain clearly why the warning appears and how to check the fingerprint.
- Revisit when: ACME IP-address certificates (short-lived) become widespread and reliable enough. The installer could then try an IP certificate and fall back to self-signed on failure.
