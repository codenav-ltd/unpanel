// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Privilege/ownership integration check. Only run on a disposable Linux CI host.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (process.platform !== "linux" || process.geteuid?.() !== 0 || process.env.CI !== "true")
  throw new Error("This check requires root on a disposable Linux CI runner (CI=true).");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "unpanel-manage-qa-"));
const data = join(fixture, "custom-data"),
  envFile = join(fixture, "panel.env");
let created = false;
try {
  if (spawnSync("id", ["-u", "unpanel"]).status !== 0) {
    execFileSync("useradd", [
      "--system",
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      "unpanel",
    ]);
    created = true;
  }
  const uid = Number(execFileSync("id", ["-u", "unpanel"], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("id", ["-g", "unpanel"], { encoding: "utf8" }).trim());
  assert(uid > 0 && gid > 0);
  chmodSync(fixture, 0o755);
  mkdirSync(data, { mode: 0o750 });
  chownSync(data, uid, gid);
  writeFileSync(envFile, `UNPANEL_DATA_DIR=${data}\n`, { mode: 0o640 });
  chownSync(envFile, 0, gid);
  const entry = join(fixture, "manage.cjs");
  const require = createRequire(join(root, "apps/panel/package.json"));
  const scope = dirname(dirname(require.resolve("@node-rs/argon2/package.json")));
  const modules = join(fixture, "node_modules/@node-rs");
  cpSync(scope, modules, { recursive: true, dereference: true });
  // pnpm's store directories may be private to the runner. The installed
  // package is readable by service/unprivileged users; reproduce that layout.
  function makeReadable(path) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) makeReadable(child);
      else chmodSync(child, 0o644);
    }
  }
  makeReadable(join(fixture, "node_modules"));
  await build({
    entryPoints: [join(root, "apps/panel/src/manage.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: entry,
    external: ["@node-rs/argon2"],
    logLevel: "silent",
  });
  const seed = join(fixture, "seed.cjs");
  await build({
    stdin: {
      contents: `
    import {openDatabase} from './apps/panel/src/db/open.ts';
    import {createLoginSecurity} from './apps/panel/src/auth/security.ts';
    const db=openDatabase(process.argv[2]);
    db.prepare("INSERT INTO users(id,username,totp_secret_enc,created_at,updated_at) VALUES ('u','alice','managed-by-mfa-v2',1,1)").run();
    createLoginSecurity({db,masterKey:Buffer.alloc(32)}).update({turnstile:{enabled:true,siteKey:'fixture',secret:'fixture-secret'}},'u');
    db.close();`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: seed,
    logLevel: "silent",
  });
  const dbPath = join(data, "panel.db");
  const seeded = spawnSync(process.execPath, [seed, dbPath], { uid, gid, encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stderr);
  const environment = { ...process.env, UNPANEL_ENV_FILE: envFile };
  delete environment.UNPANEL_DATA_DIR;
  function run(args, rootAccess = true, input, env = environment) {
    return spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
      env,
      ...(rootAccess ? {} : { uid: 65534, gid: 65534 }),
      input,
      timeout: 15_000,
    });
  }
  for (const args of [
    ["unlock"],
    ["turnstile", "disable"],
    ["reset-password", "alice", "--password-stdin"],
  ]) {
    const response = run(args, false);
    assert.equal(response.status, 1);
    assert.match(response.stderr, /sudo unpanel-manage/);
    assert.doesNotMatch(response.stderr, /SQLITE|EACCES| at /);
  }
  assert.equal(run(["--help"], false).status, 0);
  assert.equal(run(["version"], false).status, 0);
  const missing = join(fixture, "missing");
  mkdirSync(missing);
  writeFileSync(join(fixture, "missing.env"), `UNPANEL_DATA_DIR=${missing}\n`);
  const absent = run(["unlock"], true, undefined, {
    ...environment,
    UNPANEL_ENV_FILE: join(fixture, "missing.env"),
  });
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /no database was created/);
  assert.equal(existsSync(join(missing, "panel.db")), false);
  for (const args of [["unlock"], ["turnstile", "disable"], ["users"], ["security"]]) {
    const response = run(args);
    assert.equal(response.status, 0, response.stderr);
    assert.doesNotMatch(response.stdout + response.stderr, /fixture-secret/);
  }
  const privateInput = "fixture-private-new-password\n";
  const changed = run(["reset-password", "alice", "--password-stdin"], true, privateInput);
  assert.equal(changed.status, 0, changed.stderr);
  assert.doesNotMatch(changed.stdout + changed.stderr, /fixture-private-new-password/);
  const reset = run(["reset-2fa", "alice", "--yes"]);
  assert.equal(reset.status, 0, reset.stderr);
  for (const name of readdirSync(data)) assert.equal(statSync(join(data, name)).uid, uid, name);
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(
      JSON.parse(
        db.prepare("SELECT value_json FROM settings WHERE key='security.login'").get().value_json,
      ).turnstile.enabled,
      false,
    );
    const user = db.prepare("SELECT password_hash,totp_secret_enc FROM users WHERE id='u'").get();
    assert.match(user.password_hash, /^\$argon2id\$/);
    assert.equal(user.totp_secret_enc, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, 4);
  } finally {
    db.close();
  }
  process.stdout.write(
    "PASS: real root checks, custom configuration, missing database, credential recovery, secret-free output and SQLite ownership.\n",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
  if (created) execFileSync("userdel", ["unpanel"]);
}
