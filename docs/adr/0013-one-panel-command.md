# 0013 · One panel command: `unpanel`

- Status: Accepted
- Date: 2026-10-18
- Related: [design/09](../design/09-deployment.md) §10, [design/04](../design/04-auth.md) §11, [kb/terminal-management.md](../kb/terminal-management.md)

## Context

- The design reserved `unpanel` for a full administration CLI with an `admin` group (`unpanel admin reset-2fa`, `unpanel admin lockdown`, ...). That CLI was never built.
- Alpha.29 needed a way to clear a sign-in lock over SSH. It shipped as a separate wrapper, `/usr/local/sbin/unpanel-manage`, so it would not take the reserved name. It then grew service control, logs, updates and account recovery, and became the only panel command on the server.
- Operators type this command over SSH when something is wrong. A longer name and two spellings for the same action (`unpanel admin reset-2fa` in the design, `unpanel-manage reset-2fa` on the server) make that harder.
- `unpanel-manage` is already in installed servers, the README, the knowledge base, release notes and messages shown by older panels.

## Decision

The panel's server command is `unpanel`, installed at `/usr/local/sbin/unpanel`. Its commands are flat (`unpanel restart`, `unpanel reset-2fa alice`), without an `admin` group. Commands planned in design/09 §10 are added to the same command when they are built.

`/usr/local/sbin/unpanel-manage` stays installed as an identical wrapper, so existing scripts, notes and older messages keep working. New text uses `unpanel` only.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| `unpanel`, flat, `unpanel-manage` kept as an alias (chosen) | Short; one name in the design, help and messages; nothing breaks on existing servers | Two files to install and keep identical |
| Keep `unpanel-manage` | No change | Longer to type; the design keeps describing a command that does not exist |
| `unpanel` with the `admin` group from the design | Matches the original draft | Every recovery command gets longer; the group separates nothing, since all of these commands need root |
| Rename without an alias | One file | Breaks the instructions on every installed server and in older messages |

## Consequences

- Installs and updates write both wrappers. An update from an older release sees the missing `unpanel` wrapper and runs the full installer once.
- Help text, errors and UI messages print `unpanel`.
- The agent keeps its own command, `unpanel-agent`, on every node.
- When to revisit: removing the `unpanel-manage` alias, once no supported release prints that name and a release note has announced it.
