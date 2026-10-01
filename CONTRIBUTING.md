# Contributing

Thanks for your interest in the project. It is in the **design phase**: the most valuable contributions right now are reviews of the documents in [`docs/`](./docs/README.md), corrections to the knowledge base, and answers to the [open questions](./docs/open-questions.md).

By participating you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Review the design.** Open an issue (or a pull request against `docs/`) when something is unclear, wrong, or missing.
- **Improve the knowledge base.** External systems change. If a fact in [`docs/kb/`](./docs/kb/README.md) is outdated or marked ⚠️ unverified and you can confirm it, send a pull request with the source link and the date you checked.
- **Report bugs and request features** with the issue templates (once there is code).
- **Write code** once the M0 skeleton lands; issues labeled `good first issue` will be the starting point.

## Docs first

The documentation is the source of truth. Any change to behavior, protocol, data model, API, or UI conventions updates the relevant document **in the same pull request**:

| Change | Update |
|---|---|
| New or changed feature behavior | `docs/modules/<feature>.md` |
| Protocol methods, frames, events | `docs/design/02-agent-protocol.md` + `packages/protocol/test-vectors/` |
| Database schema | `docs/design/06-data-model.md` + a migration |
| HTTP routes, WebSocket topics | `docs/design/07-http-api.md` |
| A decision that is hard to reverse | A new ADR in `docs/adr/` |
| A new pitfall in an external system | `docs/kb/<system>.md` + an entry in `docs/kb/troubleshooting.md` |

## Development setup (planned)

Requirements: Node.js 24 LTS, pnpm 10, Linux or macOS (Windows via WSL2). An agent needs a Linux host with systemd; a local VM (Incus, Multipass, Vagrant) is recommended.

```bash
pnpm install
pnpm dev          # panel + local agent + web dev server
pnpm test         # unit, contract, and integration tests
pnpm lint && pnpm typecheck
```

These commands will exist once the M0 skeleton is merged.

## Conventions

The full list is in [docs/kb/conventions.md](./docs/kb/conventions.md). The essentials:

- TypeScript strict, ESM, named exports, zod at every boundary.
- English for code, comments, docs, commits, and UI source strings.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat(docker): …`, `fix(agent): …`, `docs(kb): …`.
- No generic command execution in the agent; `execFile` with argument arrays only.
- Never log secrets.

## Pull requests

1. Fork and create a branch: `feat/<short-name>` or `fix/<short-name>`.
2. Keep the change focused; split unrelated changes into separate PRs.
3. Fill in the pull request template checklist.
4. CI must pass (lint, typecheck, tests, bundle size).
5. A maintainer reviews; changes touching authentication, the agent protocol, or the agent's privileged operations need a second reviewer.
6. PRs are squash-merged; the PR title becomes the commit message, so make it a Conventional Commit.

## Security issues

Do not open public issues for vulnerabilities. Follow [SECURITY.md](./SECURITY.md).

## License of contributions

The project is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE).

### The CLA

Before your first pull request can be merged, you sign the [Contributor License Agreement](./CLA.md). A bot asks you to do so on that pull request.

- You keep the copyright in your contribution.
- You grant CodeNav Ltd a broad license to your contribution, including the right to license it under other terms as well.
- CodeNav Ltd commits to keep every contribution available under the AGPL or another OSI-approved license.

The CLA is still a draft, so outside code contributions will be merged once version 1.0 of the CLA is published. Documentation reviews and issues are welcome right now.

### Third-party code

- **Do not copy code from other projects** unless it is under a permissive license (see [conventions](./docs/kb/conventions.md) §10).
- **Mark it clearly.** Keep the original copyright notice and say in the pull request where the code came from.
- **No code from other panels.** Code from other server panels, such as 3x-ui, cannot be accepted. We borrow ideas, not code.
