# 10 · Testing Strategy and Quality Gates

> Status: Draft

## 1. Test pyramid

| Layer | Tooling | Scope | When |
|---|---|---|---|
| Unit | Vitest | Pure functions: metric math, downsampling, alert state machine, canonicalJSON, permission checks, Nginx template rendering, cron expressions | Every commit |
| Protocol contract | Vitest + test vectors | Frame encode/decode, signature message construction, method schemas; every `packages/protocol/test-vectors/*.json` must pass | Every commit |
| Agent modules | Vitest + fakes | Each module's handlers; external dependencies (`execFile`, filesystem, dockerode) injected as fakes through interfaces | Every commit |
| Panel integration | Vitest | In-process panel (in-memory SQLite) + in-process fake agent (real protocol, fake modules); covers HTTP → Hub → Agent end to end | Every commit |
| Authorization matrix | Vitest (generated) | Route registry × built-in roles × scopes × user mode (`single`, `team`); asserts allow/deny matches expectations. Also asserts that switching team → single leaves no active session or token of any other user | Every commit |
| Frontend components | Vitest + `@vue/test-utils` | Key components: `LogViewer`, `VitalTile`, `SudoDialog`, form validation | Every commit |
| Real services | Vitest + Docker containers | Docker module against a real dockerd (DinD); Nginx templates checked with `nginx -t` in an `nginx:stable` container | Every commit (when CI has Docker) |
| End-to-end | Playwright + VMs | Run the installer in a full-systemd VM (Incus/Multipass/Vagrant): first-run setup, login, enrolling a second node, Docker actions, Nginx apply and rollback, certificates (Pebble), alerts (fake Telegram server) | Nightly + before release |
| Load | `tools/node-sim` | Simulate N agents (real handshake, metrics and events at real rates); measure panel RSS, CPU, event-loop delay | Weekly + before release |
| Resource budgets | Scripts + VM | Agent idle RSS/CPU, initial bundle size, etc. (see [design/00](./00-overview.md) §5) | Before release; over budget blocks the release |

## 2. Testability conventions

- **All external dependencies go through interfaces.** Agent modules do not `import { execFile }` directly; they depend on `Exec`, `Fs`, `Clock`, `DockerClient`, etc. Production injects real implementations, tests inject fakes.
- **Controllable time.** The alert engine, session expiry, TOTP, and similar code depend on a `Clock` interface; tests use a fake clock that can be advanced.
- **`/proc` parsers are pure functions** (text in, structure out). Fixtures live in `apps/agent/test/fixtures/proc/<distro>/`, collected from real machines, including OpenVZ, LXC, and other unusual environments.
- **Recorded command output.** Real output of `nginx -t`, `systemctl show`, `ufw status`, `nft -j list ruleset`, `pm2 jlist`, and `docker compose ls --format json` is stored as fixtures, labeled with the source version.

## 3. Targeted tests

| Area | Approach |
|---|---|
| Protocol robustness | Fuzz the frame parser with fast-check: random bytes, oversized fields, invalid UTF-8, bad channel numbers; assert no crash and no leaks |
| Backpressure | Fake agent emits logs at 100 MB/s while the browser does not consume; assert panel RSS grows < 20 MB |
| Disconnects | Cut the connection mid-way through metric delivery; assert data is backfilled after reconnect without duplicates |
| ACME | Let's Encrypt's [Pebble](https://github.com/letsencrypt/pebble) test CA with `pebble-challtestsrv`, covering HTTP-01 and DNS-01 |
| WebAuthn | Playwright with a virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`) for registration, login, and sudo |
| TOTP | RFC 6238 appendix test vectors + window boundaries + replay |
| Firewall rollback | In a VM, apply "deny all inbound" without confirming; assert SSH works again after 60 s |
| Upgrade rollback | In a VM, install a "bad version" that crashes on start; assert automatic rollback |

## 4. CI pipeline

```mermaid
flowchart LR
  A[install + cache] --> B[lint + format:check]
  A --> C[typecheck]
  A --> D[unit / contract / integration / authz matrix]
  A --> E[build]
  E --> F[bundle size check]
  E --> G[real-service tests: DinD / nginx]
  B & C & D & F & G --> H[merge gate]
  H -.nightly.-> I[VM end-to-end]
  H -.release tag.-> J[multi-arch build → sign → publish]
```

Merge gate: all checks pass; coverage does not drop below the baseline (core packages `protocol`, `auth`, `alerts` ≥ 85%, others not enforced); any change to the protocol package must update the test vectors and [design/02](./02-agent-protocol.md) together.

## 5. Manual release checklist

- [ ] Fresh install on Debian 12, Ubuntu 24.04, and Rocky 9
- [ ] Upgrade from the previous stable release (panel + 2 agents)
- [ ] Core flows in dark/light themes, English/Chinese, desktop/mobile
- [ ] Panel + local agent run stably for 24 hours on a 512 MB VPS
- [ ] Every item in [kb/security-checklist.md](../kb/security-checklist.md) confirmed
