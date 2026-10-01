# Module · Web Terminal and File Manager

> Status: Draft · Agent modules: `term`, `fs`

## 1. Web terminal

### 1.1 Permission chain

Opening a terminal requires all of: RBAC `term:danger` + an active sudo session + node-local policy `term.enabled = true` + the requested user listed in `term.users`.

### 1.2 How shells are started

```
node-pty.spawn("systemd-run", [
  "--scope", "--quiet", "--collect",
  "--slice=unpanel-term.slice", "--unit=unpanel-term-<sessionId>",
  "--", "runuser", "-l", "<user>"
], { name: "xterm-256color", cols, rows, env: { LANG, TERM: "xterm-256color" } })
```

- `systemd-run --scope` puts the shell in its own cgroup; see [design/09](../design/09-deployment.md) §3.3 for why.
- `runuser -l <user>` starts a login shell that loads the user's profile (so nvm and similar setups work); root goes through the same path.
- No `ssh localhost`: no dependency on sshd configuration and no extra keys.

### 1.3 Sessions

| Item | Default |
|---|---|
| Concurrent terminals per node | 8 (policy-configurable) |
| Idle timeout (no input and no output) | 30 minutes |
| Reattach | After the browser disconnects, the pty is kept for 60 s and can be reattached (P1) |
| Close | Closing the tab sends SIGHUP to the pty; if still running after 10 s, the whole scope gets SIGKILL |

### 1.4 Audit and recording

- Audit record: open time, close time, duration, panel user, node, system user, source IP.
- Recording (P2, off by default, per-node opt-in): **output** is recorded in asciicast v2 format to `/var/lib/unpanel-agent/recordings/`. Input is not recorded by default (so passwords typed into the terminal are not captured). Playback in the UI; kept 30 days.

### 1.5 Container terminals

`docker.container.exec`: `exec create {AttachStdin, AttachStdout, AttachStderr, Tty: true, Cmd: [shell], User}` → `exec start {hijack: true, stdin: true}`; `exec.resize` on window size changes. Shell choice: a non-interactive exec first checks for `/bin/bash` in the container, falling back to `/bin/sh`.

### 1.6 Frontend

- xterm.js with the fit addon (auto sizing) and the web-links addon (clickable links);
- Multiple tabs, one session per tab;
- Mobile key toolbar (Esc, Tab, Ctrl, Alt, arrows, `|`, `~`);
- Copy/paste: copy on select (configurable); multi-line paste asks for confirmation to avoid accidental execution.

## 2. File manager

### 2.1 Methods

| Method | Risk | Notes |
|---|---|---|
| `fs.list` | read | Name, type, size, mode, owner, mtime, symlink target; at most 5,000 entries per directory, with a truncation flag beyond that |
| `fs.stat` | read | |
| `fs.read` | read | ≤ 2 MiB; binary detection (NUL byte in the first 8 KiB); returns content, encoding, `mtime`, `size` |
| `fs.write` | write | Atomic write. Requires `expectedMtime` and `expectedSize`; a mismatch returns `E_CONFLICT` (the file changed while you were editing). Preserves mode and owner |
| `fs.mkdir` | write | |
| `fs.rename` | write | Also used for moves |
| `fs.copy` | write | P1 |
| `fs.delete` | danger | Optional recursion. Refuses `/` and top-level system directories (`/bin`, `/boot`, `/dev`, `/etc`, `/lib*`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/usr`, `/var`) |
| `fs.chmod` / `fs.chown` | danger | Optional recursion |
| `fs.upload` | write (stream) | Writes to a temp file `<target>.unpanel-upload-<id>`, verifies sha256 on completion, then renames |
| `fs.download` | read (stream) | Files streamed directly; directories packed into tar.gz on the fly |
| `fs.archive` / `fs.extract` | write | P1: tar.gz and zip. Extraction prevents path traversal (rejects absolute paths and entries containing `..`) |
| `fs.search` | read | P2: search by file name with depth and result limits |

### 2.2 Path safety

See [design/05](../design/05-security.md) §4.3: `resolve`, then `realpath`, then check `deny_paths` and `allow_paths`. For targets that do not exist yet, check the parent directory.

### 2.3 Ownership of new files

The agent runs as root, so without care every new file would belong to root and the user's application (running as `deploy` or similar) could not read or write it. Rule: new files and directories **inherit the owner and group of the parent directory**; modes default to `0644` / `0755` (changeable in the upload dialog).

### 2.4 Frontend

- Two panes: a lazy-loaded directory tree on the left, a listing on the right; breadcrumbs and a path input on top;
- Drag-and-drop upload (multiple files, folders) with progress and cancel;
- Double-click opens text files in `CodeEditor`. On a save conflict, a diff is shown and the user chooses to overwrite or discard;
- Context menu: rename, copy path, download, permissions, delete, compress/extract;
- Quick locations: `/etc/nginx`, `/var/log`, `/srv`, `/opt`, `/home`, the Docker volumes directory, the managed stacks directory.
