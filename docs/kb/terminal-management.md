# Terminal management and sign-in recovery

Available from **0.1.0-alpha.29** on the panel server. `unpanel-manage` uses the Node runtime installed with the panel; a separate system Node installation is unnecessary. Run `unpanel-manage help` for the complete command list.

## Services, logs and updates

```bash
unpanel-manage version
unpanel-manage status
sudo unpanel-manage restart
sudo unpanel-manage stop
sudo unpanel-manage start
sudo unpanel-manage restart agent
sudo unpanel-manage logs --lines 100
sudo unpanel-manage logs agent --follow
unpanel-manage update --check
sudo unpanel-manage update
```

Service changes and logs default to the panel; `status` shows both panel and local agent unless a target is supplied. Restarting the panel leaves the agent running. Logs default to the latest 100 entries; `--lines` accepts 1–10000. Following logs ends with Ctrl+C. Status retains systemd's exit status, including a nonzero result for an inactive service.

Updates use the existing architecture-specific downloader, SHA-256 verification, health check and rollback. A release requiring review is refused until the operator reads its release notes and approves its exact version:

```bash
sudo unpanel-manage update --approve 0.2.0
```

Here `0.2.0` is an example: use the version reported by `update --check`. Approval fails if the selected release has changed. These commands update the panel package; remote agents remain managed from the Updates page.

## Restore access

```bash
sudo unpanel-manage security
sudo unpanel-manage unlock
sudo unpanel-manage unban 203.0.113.10
sudo unpanel-manage turnstile disable
sudo unpanel-manage users
sudo unpanel-manage reset-password alice
sudo unpanel-manage reset-2fa alice
```

`security` reports Turnstile, restriction switches and active panel/IP locks without exposing credentials. `unlock` resets only the whole-panel lock and its failed-attempt counter. `unban` resets only the supplied address. Neither disables configured protections.

If the browser cannot show the Turnstile widget, `turnstile disable` turns off that one switch while preserving its keys and other restrictions. Refresh the login page; a restart is unnecessary. After recovering access and updating the panel, test and re-enable Turnstile in Settings → Security.

Password reset asks for the new password twice without displaying it. The usual password requirements and Argon2id policy apply. The password is never printed or written to the audit log. The command ends the account's sessions, pending logins and security challenges. Its enrolled factors, role, node scope, enabled state and demo restrictions remain unchanged. A disabled account remains disabled.

`reset-2fa` explains its effect and asks the operator to type the account name. It removes TOTP, passkeys, email OTP methods and recovery codes, disables the account's 2FA requirement, and ends sessions and pending challenges. It clears that account's email references without deleting shared providers or other consumers. Sign in with the password and enroll replacement methods in Settings → Security. Enrollment is **not automatically forced**; restore the desired policy yourself. `--yes` supports an intentional noninteractive reset.

For automation, `reset-password USER --password-stdin` accepts exactly one password line from redirected standard input. Supply it from a protected source and authorize sudo beforehand (`sudo -v`); do not put passwords in command arguments or shell history.

## Permissions and data safety

Help, version, service status and update checks do not require root. Recovery, service changes and log reads check effective root privileges before accessing protected configuration, databases or password input. Missing privileges produce a specific, copyable `sudo unpanel-manage …` instruction and exit status 1.

The installed wrapper identifies its `panel.env`; recovery reads `UNPANEL_DATA_DIR` literally from that file without executing it. A deliberate `UNPANEL_DATA_DIR` environment override takes precedence. The default database is `/var/lib/unpanel/panel.db`.

Recovery requires an existing, initialized database owned by `unpanel`. It refuses a missing database or symbolic link and does not run application migrations. After authorization, the process drops root to the service account before opening SQLite, keeping database/WAL/SHM ownership correct. Mutations and their audit records commit together; a failed audit append rolls back recovery. Service commands retain their normal systemd journal records. Unexpected errors do not dump stack traces or stored secrets.
