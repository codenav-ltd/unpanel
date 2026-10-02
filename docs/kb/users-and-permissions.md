# Users, permissions and live demos

> Available from 0.1.0-alpha.25. This page describes shipped behavior; the broader role-binding and API-token model in design/04 remains a roadmap.

Open **Settings → Users**, verify your identity, and enable **Team mode**. New installations and existing single-owner installations start in single-user mode. One authorization engine checks every authenticated API request in both modes. User management requires an owner and identity verification within the last five minutes, including a second factor when the owner's policy requires one.

## Choose a role

- **Owner** manages the entire panel, users, sign-in restrictions and panel backups. The acting owner cannot delete, disable or demote their own account. At least one active owner must remain.
- **Administrator** manages nodes, Alerts, certificates, shared email delivery and ordinary panel settings. Users, global sign-in restrictions, Turnstile and database backup/restore are owner-only. Administrators are trusted infrastructure operators, not isolated tenants.
- **Operator** sees assigned nodes and can rename them, change tags or maintenance, restart/stop services, configure swap and update their remote agents. They cannot enroll, disable or delete nodes, change panel settings, inspect global audit logs, or export backups.
- **Viewer** reads assigned node status, host details and monitoring history. Infrastructure writes are denied. A normal Viewer can manage their own password and two-factor policy.

Owners and administrators cover the whole panel. Operators and viewers can cover **all nodes, including future nodes**, or an explicit set of node IDs. An empty selection grants no node access. Lists are filtered; direct requests for an unassigned node are also rejected. Custom roles, tag-based scopes, multiple role bindings and API tokens remain planned.

## Create a live-demo account

Create a user, choose **Viewer**, and enable **Read-only demo mode**. Give it all nodes or select the demonstration nodes. Demo mode also prevents changing its password, enrolling/removing authentication methods, regenerating recovery codes or writing account policy. The UI labels the session as a read-only demo and removes unavailable controls. These restrictions are enforced by the backend; hiding buttons is not the permission boundary. Signing in/out, reading monitoring data and changing browser-only layout remain available.

Node information includes hostnames, addresses and metrics. Only grant access to nodes you intend visitors to see. Shared mail-provider secrets, database exports, global logs and other users are not exposed to demo accounts.

## Manage access

Edit access to change a display name, role, node scope, demo mode, enabled state or another user's password. Usernames are stable after creation. Password reset retains the user's verified second factors; it does not bypass their policy. Other users' access changes revoke their sessions, pending logins and unfinished factor requests immediately. A password-change request already hashing its new password also rechecks the session and demo lock before writing. Delete removes the account and its factor references; shared email methods remain available to other consumers.

Switching back to **Single-user mode** shows the active accounts that will be affected and requires typing `single`. It disables every other account, including other owners, and revokes their sessions and pending sign-ins in one transaction. Their permissions and enrolled methods are retained. Returning to team mode never re-enables them automatically. Up to 100 accounts are supported.

## Implementation and recovery

`GET/POST /api/v1/users` and `PATCH/DELETE /api/v1/users/:id` manage accounts. `GET/POST /api/v1/user-mode` reads or changes mode. Mutations require owner step-up and enforce same-origin requests. `/api/v1/me` returns the current access scope; `/api/v1/me/email-methods` returns only enabled method IDs and names for personal email OTP setup. Global provider administration remains under `/email-methods`.

The existing owner receives an owner grant on upgrade. Unknown grants fail closed. Non-owner accounts use a distinct internal active status so pre-alpha.25 binaries, which know no permissions, reject both their logins and sessions instead of accidentally granting owner access. A deliberate downgrade requires a matching database/master-key backup. Binary rollback does not erase security policy. Backups are owner-only and their upload permission is checked before the large request body is buffered.

Permissions use local SQLite lookups with indexed user IDs and bounded explicit scopes, without a background authorization service or per-user polling jobs. New API modules must remain behind the central permission middleware and add authorization tests before exposing non-owner access.
