# ACME and Let's Encrypt

> Applies to: `apps/panel/src/features/acme/`, agent module `cert`. Verification markers: see [README](./README.md).
> References: [RFC 8555](https://www.rfc-editor.org/rfc/rfc8555), [RFC 9773 (ARI)](https://www.rfc-editor.org/rfc/rfc9773), [Let's Encrypt docs](https://letsencrypt.org/docs/)

## 1. Flow (RFC 8555) ✅

1. `newAccount` (account key, optional contact email, EAB for some CAs);
2. `newOrder` with identifiers (and optionally `profile`, `replaces`);
3. For each authorization, pick a challenge (`http-01`, `dns-01`, `tls-alpn-01`), provision it, and POST to the challenge URL;
4. Poll the authorization until `valid` / `invalid`;
5. `finalize` with a CSR; poll the order until `valid`;
6. Download the certificate chain (PEM) from `certificate`.

`acme-client` implements all of this; we call the low-level API to report per-step progress in the job log.

## 2. Directory URLs ✅

| CA | Directory | Notes |
|---|---|---|
| Let's Encrypt (production) | `https://acme-v02.api.letsencrypt.org/directory` | |
| Let's Encrypt (staging) | `https://acme-staging-v02.api.letsencrypt.org/directory` | Untrusted roots, much higher limits; use for all testing |
| ZeroSSL | `https://acme.zerossl.com/v2/DV90` | Requires EAB credentials |
| Google Trust Services | `https://dv.acme-v02.api.pki.goog/directory` | Requires EAB credentials |

## 3. Let's Encrypt lifetimes and profiles (verified 2026-10)

- Default (`classic`) certificates are 90 days today. Let's Encrypt is reducing the default to **64 days (February 2027)** and then **45 days (February 2028)** ✅ ([announcement](https://letsencrypt.org/2026/02/24/rate-limits-45-day-certs)).
- Profiles ([docs](https://letsencrypt.org/docs/profiles/)) ✅:

| Profile | Lifetime | Notes |
|---|---|---|
| `classic` | 90 days (shrinking as above) | Default |
| `tlsserver` | ≈ 45 days (at most 47) | Follows the newest Baseline Requirements; authorization reuse only 7 hours |
| `shortlived` | 160 hours (≈ 6 days) | Opt-in; same as `tlsserver` otherwise; **required for IP address certificates** |

- **IP address certificates** (IPv4 and IPv6) are generally available since January 2026, `shortlived` only, validated with `http-01` or `tls-alpn-01` (not `dns-01`) ✅ ([announcement](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)). This is relevant to ADR-0010's revisit condition. Passkeys still need a domain (WebAuthn RP IDs cannot be IPs).
- Never hard-code "renew at 30 days left": renew via ARI, or at 1/3 of the lifetime remaining ([modules/certificates.md](../modules/certificates.md) §4).

## 4. Rate limits (verified 2026-10) ✅

Source: [Rate Limits](https://letsencrypt.org/docs/rate-limits/).

| Limit | Value |
|---|---|
| New orders per account | 300 per 3 hours |
| New certificates per registered domain (or IPv4 address, or IPv6 /64) | 50 per 7 days, global across accounts |
| New certificates per exact set of identifiers | 5 per 7 days |
| Authorization failures per identifier per account | 5 per hour ⚠️ (value from secondary source) |
| New accounts per IP | ⚠️ re-check; create one account per directory and reuse it |

Renewals:

- **ARI renewals are exempt from all rate limits** when the order sets `replaces`, shares at least one identifier with the replaced certificate, the replaced certificate has not been replaced before, it belongs to the same account, and the order is inside the suggested window ✅.
- Non-ARI renewals with the exact same identifier set are exempt from the new-orders and registered-domain limits but still count toward the exact-set limit and authorization failures ✅.
- Rate-limited responses carry `Retry-After`; respect it.

## 5. ARI (ACME Renewal Information) ✅

- The directory contains `renewalInfo`. The certificate identifier is `base64url(AKI keyIdentifier) + "." + base64url(serial number bytes)` (no padding).
- `GET <renewalInfo>/<certID>` → `{"suggestedWindow":{"start":"…","end":"…"},"explanationURL":"…"}` with a `Retry-After` header for the next poll.
- Pick a random time inside the window; if the window is already in the past, renew immediately.
- New orders include `"replaces": "<certID>"`.
- The window can move earlier during CA incidents (mass revocation), so poll at least daily.

## 6. Validation pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| HTTP-01 fails although the IPv4 site works | Let's Encrypt prefers IPv6 when an AAAA record exists ✅; a stale or unserved AAAA breaks validation | Fix or remove the AAAA record; the panel warns when AAAA exists but the node has no matching IPv6 |
| `CAA record for example.com prevents issuance` | CAA does not list the CA | Add `0 issue "letsencrypt.org"` (and `issuewild` for wildcards) |
| DNS-01 times out | Checked a recursive resolver with a cached negative answer, or wrong zone | Query authoritative NS directly; follow `_acme-challenge` CNAMEs |
| HTTP-01 behind Cloudflare proxy is flaky | Proxy rules, redirects, or "Always Use HTTPS" interfering ⚠️ | Prefer DNS-01 for proxied records |
| `urn:ietf:params:acme:error:rateLimited` | §4 | Wait for `Retry-After`; use staging for tests |
| Wildcard via HTTP-01 | Not allowed ✅ | Wildcards require DNS-01 |

## 7. Other changes to be aware of

- Let's Encrypt **stopped sending expiration notification emails** in June 2025 ✅. The panel's own expiry alerts are essential.
- Let's Encrypt ended OCSP in 2025; do not configure OCSP stapling (see [nginx.md](./nginx.md) §4) ⚠️ re-check dates.
- `DNS-PERSIST-01` (a persistent DNS authorization record instead of per-issuance TXT changes) is an IETF draft that Let's Encrypt has expressed interest in ⚠️. If it ships, it would remove the need for DNS API credentials on the panel; track it.

## 8. Testing with Pebble ✅

[Pebble](https://github.com/letsencrypt/pebble) is Let's Encrypt's small ACME test server. Run it with `pebble-challtestsrv`, which provides a mock DNS server (for DNS-01) and HTTP-01 responder. Pebble randomizes behaviors (nonce rejection, delays) to shake out client bugs; set `PEBBLE_VA_NOSLEEP=1` and `PEBBLE_WFE_NONCEREJECT=0` for deterministic CI runs ⚠️.
