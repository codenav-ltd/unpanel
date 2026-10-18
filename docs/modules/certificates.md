# Module · Certificate Management

> Status: Draft · Panel component: `acme/` · Agent module: `cert` · External details: [kb/acme-letsencrypt.md](../kb/acme-letsencrypt.md)

**Available from alpha.19:** the panel's Certificates page supports self-signed generation, PEM import, and Let's Encrypt production/staging issuance for one domain through HTTP-01 on the local root agent. Certificate material and account keys are encrypted in SQLite. Applying a certificate enables native HTTPS/WSS on the existing panel port after local fingerprint and health verification. ACME renewal uses the certificate's actual lifetime with retry backoff and preserves the active certificate on failure. New direct-access installs default to self-signed HTTPS. See [the access runbook](../kb/panel-https.md).

The sections below describe the broader design. DNS-01, wildcards, other CAs, external monitoring, ARI, certificate deployment to remote services, and renewal hooks are not implemented yet. The current code is in `apps/panel/src/tls/`, `apps/agent/src/cert.ts` and `apps/agent/src/webroot.ts`. HTTP-01 is answered either by a temporary listener on port 80 or by a challenge file in the web root of a web server that already owns port 80 (§3.2.1); Unpanel never rewrites Nginx or Apache configuration for it.

Manual renewal preserves the certificate's automatic-renewal setting. Choosing Renew now does not silently re-enable a schedule the user disabled. Failed issuance or activation continues to leave the previous active certificate in service.

The ACME dependency is pinned to 5.4.0 with a one-line pnpm patch removing its unused, deprecated `forge` export. A matching scoped override removes `node-forge` from the dependency tree because all issuance and CSR operations use the client's native crypto API. This avoids introducing [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), for which no patched forge version was available when verified on 2026-10-03. Keep the patch and override together when upgrading the client, and rerun issuance tests, bundle validation, and the production audit.

## 1. Core idea: issue centrally, deploy anywhere

```mermaid
flowchart LR
  subgraph Panel
    CA["Certificate center\nACME client + DNS providers"]
    DB[("Certificates + private keys (encrypted)")]
  end
  LE["ACME CA"] <--> CA
  CA --> DB
  DB -- "cert.deploy" --> N1["Node A: Nginx"]
  DB -- "cert.deploy" --> N2["Node B: Nginx"]
  DB -- "cert.deploy" --> N3["Node C: xray / custom service"]
```

- A certificate (e.g. `*.example.com`) is issued once, deployed to any number of nodes, and redeployed automatically after renewal.
- Private keys are generated on the panel, stored encrypted, and sent over the authenticated agent connection. The trade-off: deploying one certificate to several nodes requires sharing one private key, and the agent connection is already protected by TLS and mutual authentication.

## 2. Certificate sources

| Source | Meaning |
|---|---|
| `acme` | Issued and renewed automatically by the panel |
| `uploaded` | PEM pasted or uploaded by the user (chain + key). Parsed with `crypto.X509Certificate`; checks the key matches the certificate and the chain order is correct; expiry reminders |
| `external_watch` | Expiry monitoring only, no private key. Target is `host:port` (optional SNI); the panel or a chosen node opens a TLS connection and reads the peer certificate |

## 3. ACME

### 3.1 Accounts

- Supported CAs: Let's Encrypt (production / staging), ZeroSSL (EAB required), Google Trust Services (EAB required), custom directory URL.
- One account per directory; account keys stored encrypted.
- Library: `acme-client`.

### 3.2 Challenge types

| Type | When | Implementation |
|---|---|---|
| DNS-01 | Wildcards, internal hosts, port 80 unavailable | The panel adds a TXT record via the DNS provider API → **queries the authoritative DNS directly** to confirm → asks the CA to validate → removes the record |
| HTTP-01 | Domain resolves to a node with port 80 reachable | The panel calls `cert.http01.put {token, keyAuth}` on the target node, which serves the file via an Nginx snippet or a temporary listener |
| Manual DNS-01 | DNS provider without an API | The UI shows the TXT record to add; the user clicks "Continue" once added (no automatic renewal; expiry reminders instead) |

**DNS providers** (plugin interface `DnsProvider { createTxt(fqdn, value); removeTxt(fqdn, value) }`):

- v1: Cloudflare (API token with `Zone.DNS:Edit`), Alibaba Cloud DNS, Tencent Cloud DNSPod;
- P2: Huawei Cloud, AWS Route 53, GoDaddy, Namecheap, acme-dns, RFC 2136.

**DNS-01 details**:

- If `_acme-challenge.<domain>` has a CNAME, follow it and create the record in the target zone (validation delegation).
- Propagation check: resolve the zone's authoritative NS, then query TXT directly with `dns.promises.Resolver` + `setServers(<authoritative NS IPs>)`, every 5 s for up to 180 s. Public recursive resolvers are not used, to avoid false results from caching.
- Records for all domains in an order are added in parallel and checked together.

**HTTP-01 details** (on the target node):

1. Nginx present and the domain already has a managed site: the site already includes the `acme.conf` snippet, so the agent just writes `/var/lib/unpanel-agent/acme/.well-known/acme-challenge/<token>` (design; needs the Nginx module);
2. Port 80 owned by a web server that serves files (Nginx, Apache, or anything else with a document root): **web root** validation, §3.2.1 (implemented);
3. Port 80 free: the agent temporarily starts a minimal HTTP server on port 80 that answers only the challenge path, and closes it immediately afterwards (implemented, called the **temporary listener**);
4. Port 80 taken by something that serves no files (Caddy with only `reverse_proxy`, a Docker container, …): return a clear error and guide the user to DNS-01.

Changing the port is not an option: the CA always connects to port 80 for HTTP-01 (and 443 for TLS-ALPN-01).

#### 3.2.1 Web root validation ✅

The certificate stores its validation method, `{ method: "standalone" }` or `{ method: "webroot", webroot: "/var/www/example" }`, and every renewal reuses it. Records without one are `standalone`. To switch methods, request a new certificate for the domain ([open question Q14](../open-questions.md)).

**Detection** (`cert.http01.detect {domain, webroot?}`) runs when the user leaves the domain field or clicks Check, and returns what owns port 80 plus probed web root candidates:

1. **Port 80**: a test bind tells whether it is free; `ss -Hltnp` names the owning program when available.
2. **Candidates**, in order, at most four probed, de-duplicated by path:
   - Nginx (`nginx` or `openresty` owns the port, or the owner is unknown and `nginx` exists): parse `nginx -T`, resolving `include` globs against the dumped files. Take `server` blocks whose `server_name` matches the domain (exact, `*.suffix`, `.domain`, `prefix.*`, `~regex`), port 80 first, then others (a port 80 site that redirects to HTTPS is validated through the HTTPS site), then the port 80 `default_server`. For each, the `root` that applies to `/.well-known/acme-challenge/` through the longest matching prefix `location`, inheriting from `server` and `http`. A location using `alias` gives no candidate.
   - Apache (`apache2` or `httpd`): parse `apache2ctl -S` (or `apachectl -S`, `httpd -S`) for the virtual hosts whose `ServerName` or `ServerAlias` matches, read each vhost block from its reported `file:line` for `DocumentRoot`, then the `Main DocumentRoot`.
   - Existing defaults: `/var/www/html`, `/usr/share/nginx/html`.
   - With `webroot` given, only that path is probed.
3. **Probe**: write `<webroot>/.well-known/acme-challenge/unpanel-probe-<random>` with random content, request it from `127.0.0.1:80` (then `[::1]:80`) with `Host: <domain>`, follow up to five redirects the way the CA does (same host only, http or https on ports 80/443, any certificate), and compare the body. The file, and any folders the probe created, are removed afterwards. A candidate counts only when the probe returns the content; parsing alone never decides. This catches redirects, `location ~ /\.` deny rules, proxied sites and wrong guesses.

The UI recommends the temporary listener when port 80 is free, the first verified web root otherwise, and asks for a path when nothing verified, listing each candidate with why it failed.

**Issuance** writes `<webroot>/.well-known/acme-challenge/<token>` (mode 0644, folders 0755, exclusive create so an existing file or symlink is never followed), and removes the file and the folders it created after validation or after ten minutes. DNS and public reachability are still checked by the ACME client fetching the challenge through public DNS before the CA is asked to validate, so a wrong setup does not consume the CA's failed-validation limit.

**Path rules** (agent side, before any write): absolute and normalized, at most 4096 characters, an existing directory, and neither the real path of the web root nor that of the challenge folder may be `/`, inside `/proc`, `/sys`, `/dev`, `/boot` or `/etc`, or inside the node's file deny list (`BUILTIN_DENY` plus `UNPANEL_FILES_DENY`, see [terminal-files.md](./terminal-files.md) §2.1). The agent only ever creates `.well-known/acme-challenge/` and files named by a validated token or probe name.

### 3.3 Issuance parameters

- Key type: `ec-p256` (default), `ec-p384`, `rsa-2048`, `rsa-4096`;
- A new private key is generated on renewal by default (reusing the old key is possible for pinning scenarios, rarely needed);
- Optional ACME profile (e.g. Let's Encrypt's `shortlived`), depending on CA support.

### 3.4 Issuance runs as a job

Issuance is a job (`dedupeKey = cert.issue:<certId>`) with a live log: create order → per-domain validation progress → finalize → download certificate → store → trigger deployments.

## 4. Renewal

- Once a day, at a random time (to avoid hitting the CA at the same moment as everyone else), all `auto_renew` certificates are checked.
- A certificate is renewed when either holds:
  - the CA supports ARI (ACME Renewal Information) and the current time is inside the suggested renewal window;
  - without ARI, less than 1/3 of the total lifetime remains (a 90-day certificate renews at about 30 days left; shorter lifetimes adapt automatically).
- Failures retry with 1 h → 6 h → 24 h backoff; each failure sends a notification with the CA's error message. With ≤ 7 days left, severity escalates to critical.
- Let's Encrypt stopped sending expiration emails in 2025, so the panel's own expiry monitoring (the `cert_expiry` rule in [alerting.md](./alerting.md)) is essential.

## 5. Deployment

```ts
interface CertDeployment {
  nodeId: string;
  targetDir: string;          // default /etc/unpanel-agent/certs/<certName>
  files?: {                   // custom file names for different software
    fullchain?: string;       // default fullchain.pem
    cert?: string;            // cert.pem
    chain?: string;           // chain.pem
    key?: string;             // privkey.pem
  };
  owner?: string;             // default root; some services read certificates as a non-root user
  reload: ReloadAction[];
}
type ReloadAction =
  | { kind: "nginx" }                                  // test, then reload
  | { kind: "service"; unit: string; action: "reload" | "restart" }
  | { kind: "docker"; container: string; action: "restart" | "kill-hup" }
  | { kind: "hook" };                                  // run the node-local /etc/unpanel-agent/hooks/cert-<certName>.sh
```

- The agent's `cert.deploy`: atomic writes (key 0600, certificates 0644, directory 0750) → run reload actions in order → return results and the serial number.
- **There is no "run a custom command" reload action.** When something custom is truly needed, place a hook script on the node. That path is in the default policy's `deny_paths`, so the panel cannot write it; only the node's administrator can install hooks. This keeps the "no generic remote exec" principle.
- Deployment jobs for offline nodes enter `waiting_node` and run automatically when the node returns.
- The panel's own certificate: the special target `panel-self`, written by the local agent to `/var/lib/unpanel/tls/` with owner `unpanel`. The panel notices the change and hot-reloads via `server.setSecureContext()` without restarting.

## 6. Methods (agent side)

| Method | Risk | Notes |
|---|---|---|
| `cert.http01.detect` | write | Report what owns port 80 and probe web root candidates for a domain (§3.2.1); writes and removes a probe file only |
| `cert.http01.put` / `cert.http01.remove` | write | Place / remove a challenge in a web root (`webroot` given) or on the temporary listener |
| `cert.deploy` | danger | Deploy certificate files and run reload actions |
| `cert.remove` | danger | Remove deployed files |
| `cert.inspect` | read | Serial and expiry of certificates deployed on the node (for reconciliation) |
| `cert.tlsProbe` | read | Connect to `host:port` from this node and read the peer certificate (for `external_watch`) |

## 7. UI

- **Certificate list**: domains, source, issuer, expiry (with a days-left color bar), auto-renew state, deployment count and status.
- **Expiry timeline**: all certificates ordered by expiry.
- **Issuance wizard**: domains → challenge type (recommended based on wildcards and available nodes) → CA → key type → deployment targets (multiple nodes, reload actions).
- **Details**: chain, SANs, fingerprints, issuance/renewal history (job logs), deployment state, plus "Renew now", "Redeploy", and "Download" (downloading the private key requires sudo).
