# Security updates and critical-fix policy

> Shipped in 0.1.0-alpha.26. Verified against the implementation and isolated automated/browser tests on 2026-10-03. The shipped advisory registry is empty; this release adds the mechanism without announcing a vulnerability.

## What users see

Release notes describe features and fixes. Security advisories separately identify a vulnerability, affected version ranges and a fixed version. A panel only displays published advisories that affect its installed version. Installing a fixed version removes that warning after a successful check.

- **Low / moderate:** a persistent notice with details and an update link for administrators.
- **High:** an emphasized warning and, when enabled, a notification through existing Alert channels.
- **Critical:** a persistent red notice, an automatically opened details dialog and an optional Alert notification. Closing the dialog reminds again after one hour. Changing the critical advisory's ID, title, fixed version or deadline causes a fresh reminder. Reviewing Updates suppresses the interrupting dialog while keeping the notice available.

The notice includes mitigation guidance, the fixed version, a publisher link/deadline when supplied, and a reason if installation is paused. Owners and administrators can review and install. Other users, including read-only demo visitors, can read the advisory and are directed to an administrator.

High/critical notifications reuse enabled Telegram and email Alert channels, their severity filters and the bounded delivery queue. High maps to `warning`; critical maps to `critical`. No separate provider configuration is needed. Each unresolved advisory is queued at most once per 24 hours, with the receipt persisted across restarts. If no destination accepts the message, a later check can try again. Configure destinations in **Alerts**, shared email delivery in **Settings → Email**, and disable these security notifications separately in the update policy.

## Owner-controlled critical updates

1. Open **Settings → Updates → Security update policy**.
2. Choose **Notify me · I install the update** (the default), or **Install automatically after the grace period**.
3. For unattended critical fixes, choose a minimum **6, 24 or 72 hours**. Review the policy and verify your identity before saving. A required second factor also applies to verification.

Unattended authorization is an explicit owner decision. The publisher cannot remotely enable it or lock users out of the panel. Its earliest eligibility time is the later of:

- the later of the first affected check and the policy activation/change time, plus the selected grace period;
- the publisher deadline, when present.

With several critical advisories, the earliest eligible deadline applies. Enabling the policy or changing its grace period starts a fresh grace period. The browser need not remain open. This policy authorizes a panel/local-agent update and restart; it does not automatically update remote agents.

Ordinary automatic updates under **Settings → Panel** remain independent and may install any eligible update sooner. With the default notify-only policy, checks follow the configured update-check interval; choosing manual checks disables that background schedule. An active unattended critical policy checks at least hourly, including when the ordinary interval is manual. Both modes check shortly after startup when enabled. API checks share a 60-second cache and coalesce simultaneous requests.

## Installation safeguards and recovery

Automatic installation pauses during local-node maintenance, when metadata cannot be checked, when the architecture package is missing, or when a release requires manual review. Unattended packages must come from this project's versioned GitHub release. A valid advisory without a compatible package still produces a warning. Known warnings survive temporary network failures and process restarts; cached data alone never authorizes an installation.

Each target version allows at most three automatic attempts in a 24-hour window, at least one hour apart. The counters persist across restarts. Concurrent installation requests are rejected. If an accepted update has not restarted the process within five minutes, the UI reports that condition and bounded retry rules still apply. Review **Logs** before an explicit manual retry. Manual installation confirms the version the user reviewed; if the offer changes, it returns a conflict. Breaking/manual-review releases cannot be installed unattended.

Existing package SHA-256 verification, architecture checks, health checks and directory rollback remain in effect. Database changes are not automatically reversed; see [account security](./account-security.md#recovery-and-compatibility) before a deliberate downgrade. Runbook and full Linux VM upgrade testing remain distinct from the isolated policy tests.

**Current trust model:** release metadata is fetched over HTTPS and package hashes are checked, but manifests and packages do not yet carry a verified publisher signature. A compromised publishing account or manifest host is outside what a checksum protects against. The unattended policy trusts the release publisher; minisign/signature enforcement remains planned. Do not describe existing releases as cryptographically signed.

## Publishing an advisory

Edit `releases/security-advisories.json` in the same reviewed change as the fix and release notes. The registry is cumulative so a panel several versions behind still learns about fixes from earlier releases. Keep real published records stable and do not remove an advisory merely because the latest version is patched. Coordinate disclosure using `SECURITY.md`.

Each entry has a unique, stable ID, a concise title, `low | moderate | high | critical` severity, one or more half-open affected ranges (`from` included, `below` excluded), a `fixedVersion`, and a UTC `publishedAt`. Optional `deadline`, HTTPS `url` and `mitigation` provide actionable guidance. Use UTC timestamps in `YYYY-MM-DDTHH:mm:ssZ` form. A range must end at or before the fixed version, and the fixed version must not be newer than the package being released.

For example, the following is **synthetic documentation only**; do not paste it into the live registry:

```json
{
  "id": "EXAMPLE-001",
  "title": "Synthetic example; replace with a real advisory",
  "severity": "critical",
  "affected": [{ "from": "1.0.0", "below": "1.0.3" }],
  "fixedVersion": "1.0.3",
  "publishedAt": "2026-10-03T00:00:00Z",
  "deadline": "2026-10-06T00:00:00Z",
  "mitigation": "Describe a verified mitigation and any required operator action."
}
```

The parser limits a registry to 64 advisories, eight ranges per advisory and bounded text fields. Merged sources remain bounded and prioritize critical warnings. The limit must be deliberately revised before a supported cumulative history outgrows it; silently dropping supported advisories is not a publishing procedure. HTTP metadata bodies are limited to 2 MiB. Duplicate IDs, malformed dates/ranges, unsafe links and future-fix declarations fail validation.

Run the shared contract and panel update tests, update the version pins and changelog, then follow [the release process](./release-process.md). `scripts/pack.mjs` validates the registry and embeds it in `channels.json`. Verify the published manifest and checksums after packaging and deployment. A `Security` or `Critical` changelog heading alone does **not** create a vulnerability advisory or authorize unattended installation. The empty registry is the correct state when there is no actual advisory to publish.
