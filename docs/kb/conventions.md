# Code and Collaboration Conventions

> Applies to the whole repository. Tooling enforces most of this; this page explains the rules the tools cannot.

## 1. Language

- Code, comments, docs, commit messages, issues, pull requests, and **UI source strings are in English**. Translations live in `apps/web/src/i18n/<locale>.ts`.
- Use plain, specific wording. Product terms follow [glossary.md](./glossary.md).

## 2. TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
- ESM only (`"type": "module"`); Node built-ins imported with the `node:` prefix.
- **Named exports only.** Exceptions where tooling requires a default export: Vue SFCs, `*.config.ts` files.
- No `any`. Use `unknown` and narrow, or a zod schema at the boundary.
- Validate every external input with zod at the boundary (HTTP, WebSocket frames, agent payloads, config files, command output parsers). Inside the boundary, trust the types.
- Prefer plain functions and data over classes; classes are fine for long-lived stateful components (connections, the hub).

## 3. Files and naming

| Kind | Convention | Example |
|---|---|---|
| TS files | kebab-case | `node-route.ts` |
| Vue components | PascalCase | `VitalTile.vue` |
| Composables | `useX` in `use-x.ts` | `use-topic.ts` exports `useTopic` |
| Tests | Beside the code, `*.test.ts` | `canonical-json.test.ts` |
| Protocol methods | `<module>.<resource>.<action>` | `docker.container.restart` |
| Permissions | `<resource>:<read|write|danger>` | `docker:write` |
| DB columns | snake_case, suffixes `_at`, `_json`, `_enc` | `created_at` |
| JSON fields (API, protocol) | camelCase | `nextCursor` |
| i18n keys | `<page>.<section>.<item>`, camelCase segments | `docker.container.restartConfirm` |

The product name is **Unpanel** ([open question Q5](../open-questions.md)). Never hard-code it anyway; a single source keeps forks and packagers able to rebrand, as the [trademark policy](../../TRADEMARKS.md) requires of modified versions.
- **Code.** Binary names, paths (`/etc/unpanel`, `/var/lib/unpanel`, `/run/unpanel`), systemd unit names, the cookie prefix, the WebAuthn RP name, and UI strings all come from `packages/shared/src/product.ts`.
- **Install scripts.** Shell scripts and unit-file templates are rendered from the same values at build time.

Feature code is organized as vertical slices ([design/01](../design/01-architecture.md) §5): a feature's protocol definitions, agent module, panel routes, and web pages share a name.

## 4. Errors

- Throw typed errors with a stable `code` (`E_…`); never throw strings.
- Agent modules convert external failures into protocol errors with `details` that help the user (stderr, exit code, file and line).
- Never swallow errors silently. If an error is intentionally ignored, the code must make that obvious (e.g. `.catch(ignoreNotFound)`).
- User-facing messages: say what happened and what to do next. No stack traces in the UI.

## 5. Logging

- pino, structured. Message strings are constant; variable data goes into fields: `log.info({ nodeId, method }, "rpc completed")`.
- Levels: `error` (needs attention), `warn` (degraded but handled), `info` (lifecycle events), `debug` (diagnostics), `trace` (frames).
- **Never log secrets**: tokens, passwords, TOTP secrets, private keys, cookie values, `Authorization` headers, environment variables of managed processes. pino `redact` paths are configured centrally; adding a new secret-bearing field means adding a redact path.
- Every log line in a request context carries `requestId`.

## 6. Commits and branches

- [Conventional Commits](https://www.conventionalcommits.org/): `feat(docker): add container recreate`, `fix(agent): handle UINT64_MAX in systemctl show`, `docs(kb): …`, `refactor`, `test`, `chore`, `ci`, `perf`.
- Scope is the feature slice or app (`panel`, `agent`, `web`, `protocol`).
- Breaking changes: `!` after the type and a `BREAKING CHANGE:` footer.
- Branches: `feat/<short-name>`, `fix/<short-name>`. Squash-merge into `main`.

## 7. Pull requests

Checklist (mirrored in `.github/PULL_REQUEST_TEMPLATE.md`):

- [ ] CLA signed; new source files carry the SPDX header (§11); third-party code is permissively licensed (§10)
- [ ] Tests cover the change (unit, and integration for new routes/methods)
- [ ] New protocol methods declare `capability`, `risk`, `permission`, `timeoutMs`, `since`
- [ ] New routes appear in the authorization matrix test
- [ ] UI changes cover loading, empty, error, and success states and work in all three themes
- [ ] New UI strings are in `en.ts`
- [ ] Docs updated (design doc, KB, or ADR as appropriate)
- [ ] No secrets in logs, fixtures, or screenshots

## 8. Database migrations

- Generated with `drizzle-kit generate`, committed, applied at startup in order.
- **Never edit a migration that has been released.** Fix forward with a new migration.
- Migrations must be safe on databases with real data: add columns as nullable or with defaults; backfill in a separate step if needed.
- Destructive changes (dropping columns/tables) only in a major version, after a release that stopped using them.

## 9. Protocol changes

- Additive changes (new method, new optional field, new event) bump the protocol minor version and set `since`.
- Removing or changing semantics bumps the major version; the panel supports the previous major ([design/02](../design/02-agent-protocol.md) §9).
- Every change updates `packages/protocol/test-vectors/` and design/02 in the same PR.

## 10. Dependencies

- Prefer the platform (Node built-ins, Web APIs) and small focused libraries.
- Before adding a dependency, check: maintenance activity, install size, transitive dependencies, native code, license compatibility.
- Licensing of third-party code ([ADR-0011](../adr/0011-agpl-license.md)):
  - **Permissive only.** Third-party code that ends up in release artifacts must use a permissive license: MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, or BlueOak.
  - **No copyleft.** GPL, LGPL, AGPL, MPL, and SSPL are not allowed in release artifacts. Exceptions need an ADR.
  - **Enforced in CI.** A license check runs over the production dependency tree. Dev-only tools are exempt.
- No code is copied from other panels (3x-ui included). Snippets from permissive sources keep their copyright notice and are listed in `THIRD_PARTY_NOTICES`.
- No dependency may run install scripts unless listed in `pnpm.onlyBuiltDependencies`.
- Lockfile committed; Renovate (or Dependabot) PRs grouped weekly; security updates immediately.
- Runtime dependencies of the agent are reviewed with extra care: they run as root on every node.

## 11. License headers

- **Source files.** Every source file (`.ts`, `.vue`, `.js`, shell scripts) starts with an SPDX header, and lint fails on files without one:

  ```ts
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (C) 2026 CodeNav Ltd and contributors
  ```

- **Packages.** Every `package.json` declares `"license": "AGPL-3.0-or-later"`.
- **Protocol test vectors.** Files in `packages/protocol/test-vectors/` are `CC0-1.0`, so independent agent implementations can use them freely.
- **No contributor lists in files.** Do not add individual author names to file headers; authorship is recorded in git history.
