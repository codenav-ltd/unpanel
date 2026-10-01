# 0009 · Switchable User Modes: Single-User by Default, Team Mode with Node-Scoped RBAC

- Status: Accepted (confirmed 2026-10-01, [open-questions](../open-questions.md) Q2)
- Date: 2026-10-01
- Related: [design/04](../design/04-auth.md) §12

## Context

- **Individuals** usually need one administrator account. For them, users, roles, and scopes are clutter.
- **Small teams** need splits like "this colleague manages only these machines" or "the intern can look but not touch".
- **Retrofitting is expensive.** Building single-user first and adding multi-user later means reworking nearly every endpoint, every resource list, and every live topic.
## Decision

1. **One data model and one authorization engine, always multi-user underneath.**
   - Users get permissions through role bindings, and every binding has a scope: all nodes, specific nodes, or specific tags.
   - There are four built-in roles: `owner`, `admin`, `operator`, `viewer`. Custom roles are P1.
   - Every protocol method declares its permission, and `nodeRoute()` checks it centrally, so individual features contain no permission code.
2. **A user mode setting, `auth.userMode`, chooses how much of that the product exposes.**
   - **`single` (the default after setup).** Exactly one active user, the owner. The Users and Roles pages are hidden, and the user-management API refuses to create users. API tokens remain available, because they are how automations get narrower access.
   - **`team`.** Users, roles, and scoped bindings are fully available.
3. **The mode is never an authorization shortcut.**
   - In single mode, every request still goes through the same RBAC check. The owner simply holds `owner` with scope `all`.
   - This keeps the authorization matrix test meaningful in both modes, and switching modes cannot open a hole.
4. **Switching is an owner-only, sudo-protected, audited action.**
   - **single → team** changes nothing except what becomes available.
   - **team → single** disables every other user and revokes their sessions and tokens, after a confirmation listing them. Their role bindings are kept, so switching back and re-enabling users restores their access. The details are in [design/04](../design/04-auth.md) §12.5.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Switchable modes over one RBAC engine (chosen) | Individuals get the simplest UI; teams get scoped RBAC; one code path for authorization | A mode setting and the switch flow need tests; the UI must hide team features cleanly |
| Always multi-user (previous default) | No mode logic | Individuals see users/roles they will never use |
| Single administrator only | Simplest, smallest attack surface | Unusable for teams; adding it later means heavy rework |
| Two separate implementations (single vs. multi) | Each one is simple | Two authorization paths, double the security surface; switching would need data migration |

## Consequences

- **Positive.** The common single-admin case looks and feels like a personal panel, while teams can enable RBAC at any time without migration.
- **Negative.**
  - Every resource list must be filtered by visible nodes, and WebSocket topics by permission, in both modes.
  - The UI has a `userMode` condition in navigation and settings.
- **Constraints.**
  - The authorization matrix test ([design/10](../design/10-testing.md)) runs in both modes.
  - A test asserts that switching team → single leaves no active session or token belonging to another user.
- **Milestones.** Single mode ships from M0; team mode, with its UI for users, roles, and bindings, ships in M4.
