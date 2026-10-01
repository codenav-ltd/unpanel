# 0011 · AGPL-3.0-or-later

- Status: Accepted
- Date: 2026-10-01
- Related: [LICENSE](../../LICENSE), [TRADEMARKS.md](../../TRADEMARKS.md), [CLA.md](../../CLA.md), [kb/conventions.md](../kb/conventions.md) §10–11

## Context

- Unpanel should stay open source, including every modified version of it that people use.
- The project is a network service. Under the GPL, someone can modify it and offer it as a hosted service without ever distributing it, and so without sharing the source.
- The initial commit carried an MIT `LICENSE`, but no code had been published under it and there were no outside contributors.

## Decision

1. **License: AGPL-3.0-or-later** for the whole repository (panel, agent, web, protocol package, docs), except as noted in item 4.
   - Anyone may use, modify, and redistribute the software, including commercially.
   - Anyone who distributes a modified version, **or lets users interact with it over a network**, must offer those users the complete corresponding source under the same license (AGPL §13).
2. **Names and logos** are covered by the [trademark policy](../../TRADEMARKS.md), not by the license. Forks are welcome under a different name.
3. **The source is reachable from the running product** (AGPL §13). The UI shows a "Source code" link on the login page and in Settings → About. Distributors of modified versions point it at their own source with `about.source_url`.
4. **Protocol test vectors are CC0-1.0** (`packages/protocol/test-vectors/`). [ADR-0008](./0008-node-agent-language-agnostic-protocol.md) invites independent agent implementations. Those must be able to use the conformance vectors without taking on the AGPL. The protocol specification in [design/02](../design/02-agent-protocol.md) describes an interface: implementing it independently does not create a derivative work.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| AGPL-3.0 (chosen) | Copyleft that also covers hosted modified versions | Some companies ban AGPL software internally |
| GPL-3.0 | Familiar copyleft | Hosted modified versions need not share source, which is the main gap for a web panel |
| MIT / Apache-2.0 | Maximum adoption | Modified versions may be closed |

## Consequences

- **License headers.** Every source file starts with `SPDX-License-Identifier: AGPL-3.0-or-later`, and every `package.json` declares `"license": "AGPL-3.0-or-later"`.
- **Contributions** are accepted under the [CLA](../../CLA.md); a bot checks every pull request.
- **Third-party code** that ships in release artifacts must be under permissive licenses, and code is never copied from other panels ([conventions](../kb/conventions.md) §10).
- **Release contents.** Release artifacts include `LICENSE` and `THIRD_PARTY_NOTICES` (generated from the dependency tree). The release page links to the exact source tag.
