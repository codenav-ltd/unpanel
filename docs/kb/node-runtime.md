# Node.js Runtime

> Applies to: build, packaging, both apps. Verification markers: see [README](./README.md).
> References: [Node release schedule](https://github.com/nodejs/release#release-schedule), [BUILDING.md](https://github.com/nodejs/node/blob/main/BUILDING.md)

## 1. Versions

| Line | Status (as of 2026-10) | End of life |
|---|---|---|
| Node 24 | Active LTS — **the version we ship** | April 2028 ✅ |
| Node 26 | Becomes LTS in October 2026 ✅ | April 2029 ⚠️ |

Policy: ship the current Active LTS; move to the next LTS within 3 months of it entering LTS, after a full CI and VM test pass. The panel and agent always ship the same Node version.

## 2. glibc and platforms

- Official Node 24 Linux binaries require **glibc ≥ 2.28** ⚠️ (re-check `BUILDING.md` for each Node major). That covers Debian 10+, Ubuntu 20.04+, RHEL 8+.
- We build native modules on a **glibc 2.31 (Debian 11)** baseline, so our packages need glibc ≥ 2.31 overall. The installer checks `ldd --version`.
- musl (Alpine) is not supported in v1.
- Architectures: `x64`, `arm64`.

## 3. Native modules

| Module | Used by | Notes |
|---|---|---|
| `better-sqlite3` | Panel | Compiled per arch in CI; to be dropped if `node:sqlite` passes the ADR-0006 criteria |
| `@node-rs/argon2` | Panel | N-API prebuilt packages per platform (`@node-rs/argon2-linux-x64-gnu`, …) ✅; ABI-stable across Node versions |
| `node-pty` | Agent | Upstream `node-pty` 1.1.0 ✅; `@lydell/node-pty` publishes per-platform prebuilt packages ✅. We compile in CI on our glibc baseline either way, to control compatibility |

- N-API modules are ABI-stable across Node majors; NAN/V8-API modules (like older node-pty) must be rebuilt per Node major.
- pnpm 10 does not run dependency build scripts unless approved: list them in `pnpm.onlyBuiltDependencies` (or via `pnpm approve-builds`) ✅.

## 4. Memory tuning

- A minimal Node 24 process idles around 40 MB RSS ⚠️ (measure on our actual bundle; this is the basis of the agent budget).
- Agent flags: `--max-old-space-size=64` (hard ceiling on the JS heap) and `--max-semi-space-size=1`/`2` to keep young-generation memory small ⚠️ (benchmark the GC cost).
- Lazy-load modules: `docker`, `nginx`, `pm2`, … are only imported once their capability is detected and used.
- Reuse buffers for `/proc` reads; avoid long-lived child processes.
- Watch for `Buffer` retention in stream relays (slices keep the parent alive).

## 5. Bundling

- [tsdown](https://tsdown.dev/) (or esbuild) bundles each app into a single ESM file with native modules externalized ✅.
- Keep `node_modules/<native>` beside the bundle with only the files needed at runtime (`.node` binary + JS loader).
- Source maps are shipped separately (not in the tarball) and uploaded with releases for debugging; `--enable-source-maps` is off by default (memory cost).

## 6. Internationalization data

Official Node binaries include full ICU ✅, so `Intl.DateTimeFormat` works for any time zone and locale. Required for node time-zone handling (traffic periods, cron preview). Do not use `small-icu` builds.

## 7. Proxy support

Node 24 can honor `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for the built-in `fetch` when `NODE_USE_ENV_PROXY=1` is set ⚠️ (re-check availability and behavior per version). We do not rely on it: the agent's `proxy` setting and the Telegram proxy are implemented explicitly with an `undici` dispatcher / `ws` agent.

## 8. Useful flags

| Flag | Use |
|---|---|
| `--max-old-space-size=<MB>` | Heap cap |
| `--heapsnapshot-signal=SIGUSR2` | On-demand heap snapshot for leak hunting |
| `--report-on-fatalerror` | Diagnostic report on crash |
| `--disable-warning=ExperimentalWarning` | Only if we adopt `node:sqlite` before its warning disappears (not planned; see ADR-0006) |
