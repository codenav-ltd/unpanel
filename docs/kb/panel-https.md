# Panel HTTPS and Domain Access

> Status: available from 0.1.0-alpha.19. See [Certificate Management](../modules/certificates.md) for the remaining design.

The Certificates page manages the panel's own HTTPS listener. It can generate a self-signed certificate, import a PEM certificate chain and private key, or obtain a Let's Encrypt certificate for one domain. Keys and ACME account keys are encrypted in the panel database using its existing master key. The API returns certificate metadata, never private keys.

## Enable HTTPS with an IP address

1. Open **Certificates → Self-signed**.
2. Enter the IP address or hostname used to open the panel, without a scheme or port.
3. Select **Generate certificate**, then **Use for panel HTTPS**.
4. Review the HTTPS address and SHA-256 fingerprint, then select **Enable HTTPS**.
5. Open the displayed HTTPS address and sign in again. Compare the browser's certificate fingerprint with the fingerprint shown by the panel before trusting it.

A self-signed certificate encrypts the connection but is not trusted by browsers automatically. The certificate contains the specified address in its Subject Alternative Name. A certificate made for one IP does not also cover a domain.

HTTPS keeps the existing panel port: an installation on port 28517 becomes `https://203.0.113.10:28517`. HTTP reads redirect to the saved HTTPS address; writes made over HTTP are rejected. The HTTP health endpoint remains available for the installer's local update and rollback checks.

## Obtain a trusted domain certificate

1. Point the domain's DNS A record to the panel server. If it has an AAAA record, that IPv6 address must also reach the validation service; remove an incorrect record before issuance.
2. Allow inbound TCP port 80 in the host firewall and provider security group, and keep the panel's port reachable. HTTP-01 always uses port 80, even when HTTPS uses 28517 or 443. **Verified 2026-10-03:** [Let's Encrypt challenge documentation](https://letsencrypt.org/docs/challenge-types/).
3. Ensure the local root agent is online and port 80 is free. The agent opens a temporary challenge-only listener. It does not stop existing services or modify Nginx. If another service owns port 80, obtain a certificate elsewhere and import it.
4. Open **Certificates → Let's Encrypt**, enter `panel.example.com` and a contact email, and accept the subscriber agreement. Use the staging CA first when testing connectivity; staging certificates are not publicly trusted.
5. Request the production certificate. Once the job succeeds, select **Use for panel HTTPS**, review `https://panel.example.com:<panel-port>`, and enable it.

Use **Import PEM** for certificates issued elsewhere: paste the leaf certificate followed by its intermediates, plus the matching unencrypted private key. Import checks the key, hostname, validity, chain order, and TLS server usage. Browser trust still depends on the issuing CA and chain. Keep the private key out of logs, chat messages, and commits.

The current implementation supports one domain per order through HTTP-01. DNS-01, wildcard issuance, IP ACME certificates, additional CAs, and deployment to other services remain planned.

## Use the default HTTPS port

Native TLS uses the panel's configured listen port. A fresh installation can use port 443 with `--port 443 --public-url https://panel.example.com`; the installer gives the unprivileged panel only the capability needed to bind that low port. DNS and a production certificate are still needed for browser trust. Changing the address in Settings alone does not change the port or enable TLS.

Fresh direct-access installs default to self-signed HTTPS. Updates preserve an existing HTTP installation until the administrator applies a certificate. A reverse proxy can continue terminating HTTPS while the panel listens on loopback HTTP: specify the proxy's HTTPS public URL and a different backend port. Native certificate activation requires the URL to match the panel's own port.

## Renewal and recovery

ACME certificates default to automatic renewal. The panel checks on startup and hourly, and begins renewal when one third of the actual certificate lifetime remains. Keep DNS, the local agent, and inbound port 80 available for future renewals. Each renewal generates a fresh key; an active certificate is applied and locally verified before storage changes are accepted.

Failed renewals keep the current certificate and record the reason in Logs and Certificates. Retries wait one hour, then six hours, then one day, or longer if the CA supplies a later retry time. An administrator can disable automatic renewal or request a renewal manually after that retry time. Imported and self-signed certificates require a replacement certificate.

After changing an existing panel from HTTP to HTTPS, changing its public hostname, or replacing a self-signed certificate, existing remote agents may need new enrollment commands. Generate a new command for the affected node and run it on that server. Commands for self-signed panels include the public trust certificate; enrollment and WSS still verify TLS. The local agent continues using its local socket.

The panel verifies its HTTPS listener and certificate locally when applying changes. This confirms the server is serving the selected certificate; it does not confirm public DNS, firewall reachability, or browser trust from a remote device. Keep SSH access available while changing the public address. An active certificate cannot be deleted; apply its replacement first.
