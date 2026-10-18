# Module · Web Terminal and File Manager

> Status: Draft · Agent modules: `term`, `fs`

## 1. Web terminal

### 1.1 Permission chain

Opening a terminal requires all of: RBAC `term:danger` + an active sudo session + the node allowing terminals + the requested user being on the node's list.

Currently `term:danger` means an owner or admin who can see the node (operators, viewers and demo accounts cannot), and the sudo session is the identity confirmation of the last five minutes; without it the gateway answers `E_SUDO_REQUIRED` and the browser asks the user to confirm. The check applies when the terminal opens. Signing out, or the session expiring, closes the browser connection and every terminal on it (`apps/panel/src/http/terminal.ts`).

The node-local policy lives in the agent's `agent.env` and takes effect when the agent restarts:

| Setting | Default | Effect |
|---|---|---|
| `UNPANEL_TERMINAL` | on | `off` (or `0`, `false`, `no`) turns terminals off on this node |
| `UNPANEL_TERMINAL_USERS` | `root` | Comma-separated accounts a terminal may run as; invalid names are ignored |

The agent reports the `term` capability, with `meta.users` listing the allowed accounts, only when terminals are on, node-pty loaded, and the machine runs systemd (`/run/systemd/system` exists). Otherwise the panel answers `E_CAPABILITY_MISSING` without contacting the agent. On macOS outside production the agent offers a development shell: the developer's login shell as their own account, without a scope. Implementation: `apps/agent/src/term.ts`; protocol: `termOpen` in `packages/protocol/src/methods/term.ts`.

### 1.2 How shells are started

```
node-pty.spawn("systemd-run", [
  "--scope", "--quiet", "--collect",
  "--slice=unpanel-term.slice", "--unit=unpanel-term-<sessionId>",
  "--", "runuser", "-l", "<user>"
], { name: "xterm-256color", cols, rows, env: { LANG, TERM: "xterm-256color" } })
```

- `systemd-run --scope` puts the shell in its own cgroup; see [design/09](../design/09-deployment.md) §3.3 for why.
- The shell starts in `/` with `TERM=xterm-256color`, the agent's `LANG` (or `C.UTF-8`) and a standard `PATH`; `runuser -l` then sets up the login environment.
- When the shell exits, the agent sends CTRL `{"exit": <code>, "signal"?: <n>}` and closes the stream.
- `runuser -l <user>` starts a login shell that loads the user's profile (so nvm and similar setups work); root goes through the same path.
- No `ssh localhost`: no dependency on sshd configuration and no extra keys.

### 1.3 Sessions

| Item | Default |
|---|---|
| Concurrent terminals per node | 8 |
| Idle timeout (no input and no output) | 30 minutes |
| Reattach | After the browser disconnects, the pty is kept for 60 s and can be reattached (P1) |
| Close | Closing the tab sends SIGHUP to every process in the session's scope (signalling only the pty's child would stop at `runuser`, which does not pass it on). 10 s later the scope gets SIGKILL, even if the shell has already exited, so jobs that ignore SIGHUP do not outlive the terminal. A shell the user exits leaves its background jobs running, as with SSH |

### 1.4 Audit and recording

- Audit record: open time, close time, duration, panel user, node, system user, source IP. They are written as `term.open` and `term.close`; a close caused by an error (including the node disconnecting) is recorded with result `error` and its code.
- Recording (P2, off by default, per-node opt-in): **output** is recorded in asciicast v2 format to `/var/lib/unpanel-agent/recordings/`. Input is not recorded by default (so passwords typed into the terminal are not captured). Playback in the UI; kept 30 days.

### 1.5 Container terminals

`docker.container.exec`: `exec create {AttachStdin, AttachStdout, AttachStderr, Tty: true, Cmd: [shell], User}` → `exec start {hijack: true, stdin: true}`; `exec.resize` on window size changes. Shell choice: a non-interactive exec first checks for `/bin/bash` in the container, falling back to `/bin/sh`.

### 1.6 Frontend

- xterm.js with the fit addon (auto sizing) and the web-links addon (clickable links);
- Multiple tabs, one session per tab;
- Mobile key toolbar (Esc, Tab, Ctrl, Alt, arrows, `|`, `~`);
- Copy/paste: copy on select (configurable); multi-line paste asks for confirmation to avoid accidental execution.

Current implementation (`apps/web/src/components/TerminalPage.vue`, `TerminalPane.vue`, `gateway-client.ts`): the page at `/nodes/:id/terminal` opens one session when it loads and more with New terminal, up to the node's 8; tabs switch with the arrow keys and closing a running one asks first. Credit for terminal output is returned once xterm has parsed it, so backpressure reaches the browser's screen. Multi-line paste is confirmed only when the shell has not enabled bracketed paste. The key toolbar shows below 768 px or on coarse pointers; Ctrl and Alt are sticky for the next key. Leaving the page closes its terminals; the browser asks before unloading while one is running. Not yet implemented: copy on select, reattach after a disconnect, and the bundled JetBrains Mono font (the system monospace stack is used).

## 2. File manager

### 2.1 Permission chain

Using the file manager requires: an owner or admin who can see the node + the node allowing files + the path passing the node's path policy. Operators, viewers and demo accounts have no file access: the agent runs as root, so reading `/root/.ssh` or writing `/etc/cron.d` is root access.

Listing a directory and reading metadata (`fs.list`, `fs.stat`) need nothing more. Reading file contents (`fs.read`, `fs.download`) and every change need an active sudo session (identity confirmed in the last five minutes; `E_SUDO_REQUIRED` otherwise), because a stolen session cookie alone should not be able to read keys or plant a file. Reads of contents and every change are audited with the node and path (`fs.read`, `fs.download`, `fs.write`, `fs.upload`, `fs.mkdir`, `fs.rename`, `fs.delete`, `fs.chmod`, `fs.chown`); listings are not.

The node-local policy lives in the agent's `agent.env` and takes effect when the agent restarts:

| Setting | Default | Effect |
|---|---|---|
| `UNPANEL_FILES` | on | `off` (or `0`, `false`, `no`) turns the file manager off on this node |
| `UNPANEL_FILES_DENY` | empty | Comma-separated absolute paths added to the built-in deny list |
| `UNPANEL_FILES_ALLOW` | empty | When set, only these paths and what is below them are reachable |

The built-in deny list protects the trust anchors of Unpanel itself and the password hashes: `/etc/unpanel-agent`, `/var/lib/unpanel-agent`, `/etc/unpanel`, `/var/lib/unpanel`, `/etc/shadow`, `/etc/gshadow`. The agent reports the `fs` capability when files are on (`meta.allow` lists the allowed roots when `UNPANEL_FILES_ALLOW` is set). These rules are guard rails against mistakes and a stolen panel session, not a sandbox: an admin who opens a terminal is root.

### 2.2 Methods

All paths are absolute, at most 4,096 bytes, without NUL bytes. Times are epoch milliseconds. Implementation: `apps/agent/src/files.ts`, `apps/agent/src/file-streams.ts`; protocol: `packages/protocol/src/methods/fs.ts`.

| Method | Risk | Notes |
|---|---|---|
| `fs.list` | read | Name, type (`file`, `dir`, `link`, `other`), size, mode, owner, group, mtime; a link also carries its target and the type it points to. At most 5,000 entries, with `truncated` beyond that (entries come in directory order, so the UI says the listing is incomplete) |
| `fs.stat` | read | One entry, the same shape |
| `fs.read` | read | Regular files ≤ 2 MiB. A NUL byte in the first 8 KiB or invalid UTF-8 returns `binary: true` without content. Returns `content`, `mtime`, `size` |
| `fs.write` | write | UTF-8 content ≤ 2 MiB, atomic (temp file in the same directory → fsync → rename). An existing file requires `expectedMtime` and `expectedSize`; a mismatch returns `E_CONFLICT` (it changed while you were editing). Preserves mode and owner. `create: true` makes a new file and fails with `E_CONFLICT` if the name exists |
| `fs.mkdir` | write | One directory; the parent must exist |
| `fs.rename` | write | Also moves. Never replaces an existing name (`E_CONFLICT`); a move to another filesystem returns `E_UNSUPPORTED` |
| `fs.delete` | danger | `recursive` is required for a non-empty directory. Refuses `/` and top-level system directories (`/bin`, `/boot`, `/dev`, `/etc`, `/home`, `/lib*`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/usr`, `/var`); rename refuses to move them too |
| `fs.chmod` / `fs.chown` | danger | Optional recursion, which never follows symbolic links. Owner and group are names |
| `fs.upload` | write (stream) | Writes to a temp file `<target>.unpanel-upload-<id>`, checks the byte count and the sha256 the panel sends at the end, then renames. Replacing an existing file needs `overwrite` and keeps its mode and owner. Cancelling removes the temp file |
| `fs.download` | read (stream) | A file is streamed as is, after CTRL `{"kind":"file","size","mtime"}`; a directory is packed into tar.gz on the fly by the system `tar`, after CTRL `{"kind":"dir"}` |
| `fs.copy` | write | P1 |
| `fs.archive` / `fs.extract` | write | P1: tar.gz and zip. Extraction prevents path traversal (rejects absolute paths and entries containing `..`) |
| `fs.search` | read | P2: search by file name with depth and result limits |

Errors: a missing path is `E_NOT_FOUND`; a path outside the policy, or a refused system directory, is `E_POLICY_DENIED`; a file that is too large, not a regular file, or a non-empty directory without `recursive` is `E_PRECONDITION`.

### 2.3 Path safety

See [design/05](../design/05-security.md) §4.3: `resolve`, then `realpath`, then check the deny and allow lists. Reading, writing, listing and downloading follow symbolic links and check where they lead. Renaming and deleting act on the link itself, so they check the real path of the parent directory plus the name. A target that does not exist yet is checked through its parent directory. A recursive delete, chmod or chown also refuses a directory that contains a denied path (deleting `/var/lib` would remove the agent's identity).

### 2.4 Ownership of new files

The agent runs as root, so without care every new file would belong to root and the user's application (running as `deploy` or similar) could not read or write it. Rule: new files and directories **inherit the owner and group of the parent directory**; modes are `0644` / `0755`, changed afterwards with Permissions. A replaced file (save, upload with overwrite) keeps its own mode and owner.

### 2.5 HTTP

Routes under `/api/v1/nodes/:id/fs/` (implementation `apps/panel/src/http/files.ts`):

| Route | Method |
|---|---|
| `GET list?path=`, `GET stat?path=`, `GET read?path=` | `fs.list`, `fs.stat`, `fs.read` |
| `POST write`, `mkdir`, `rename`, `delete`, `chmod`, `chown` (JSON) | Same names |
| `POST upload?path=&overwrite=1` | Body `application/octet-stream` with `Content-Length`, piped into `fs.upload` without touching the panel's disk. Limit 2 GiB per file. With `check=1` and no body it only confirms access and answers `{exists, type?}` |
| `GET download?path=` | Streamed with `Content-Disposition: attachment`; a directory arrives as `<name>.tar.gz`. With `check=1` it only confirms access and answers `{type}` |

### 2.6 Frontend

- `/nodes/:id/files`. Two panes: a lazy-loaded directory tree on the left (hidden below 768 px), a listing on the right; breadcrumbs that turn into a path input on click;
- Quick locations: `/`, `/etc/nginx`, `/var/log`, `/srv`, `/opt`, `/home`, `/var/lib/docker/volumes`, shown when they exist;
- Upload with the button or by dropping files onto the listing (multiple files; folders P1), one at a time with progress and cancel; an existing name asks whether to replace it;
- Opening a text file shows it in `CodeEditor` (CodeMirror 6, its own chunk). On a save conflict, a diff of the node's version against yours is shown and the user chooses to overwrite or reload;
- Each row has an actions menu (also on right-click): open, download, rename, copy path, permissions, delete. New folder and New file are on the toolbar.

Current implementation: `apps/web/src/components/FilesPage.vue`, `FileTree.vue`, `FileEditor.vue`, `apps/web/src/files-client.ts`. The current folder is in the URL (`?path=`), so Back works and a folder can be linked. A name opens its folder or file; right-click or the row menu gives the other actions. Before an upload or download the browser asks the panel with `check=1` (no body), so identity confirmation and "replace?" happen before any bytes move. The editor (CodeMirror 6, its own chunk) picks a syntax mode from the file name and location, keeps the file's line endings, saves with Ctrl/⌘+S and asks before closing with unsaved changes. Find and replace is Unpanel's own bar above the text (`EditorSearch.vue`, drawn inside CodeMirror's search panel): Ctrl/⌘+F finds, Ctrl+H (⌘⌥F on macOS) also shows Replace; match case, whole word and regular expression toggles (Alt+C/W/R); a live "n of m" count, capped at 9,999; Enter / Shift+Enter step through matches, Ctrl/⌘+Enter replaces all. The status bar shows the position (click or Ctrl+G for Go to line, `line` or `line:column`), a Wrap toggle (Alt+Z, remembered in the browser), the line ending and the syntax mode. On a conflict it shows the server's version inline against the user's (`@codemirror/merge`), with Keep mine / Use server's per change, then Save over the server's version or Discard mine and reload. Not yet implemented: folder uploads, copy, archives, search.
