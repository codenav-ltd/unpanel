// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Linux integration check: real directory swaps and HTTP reads, in temporary fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("This deployment check requires Linux.");
const script = fileURLToPath(new URL("./apply-site.sh", import.meta.url));
for (const scenario of ["success", "corrupt archive", "stale public response", "changed website"]) {
  const root = await mkdtemp(join(tmpdir(), "unpanel-site-qa-"));
  const site = join(root, "website");
  const work = `${site}.deploy.fixture`;
  const packageDir = join(root, "package");
  const server = createServer(async (req, res) => {
    try {
      const content =
        scenario === "stale public response"
          ? "stale cached response"
          : await readFile(join(site, (req.url ?? "/").slice(1)));
      res.end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  try {
    await mkdir(site);
    await mkdir(work);
    await mkdir(packageDir);
    await writeFile(join(site, "index.html"), "old website");
    await writeFile(join(site, "install-agent.sh"), 'VERSION="0.1.0-alpha.14"\n');
    const files = {
      "index.html": "new website",
      "install.sh": 'VERSION="0.1.0-alpha.19"\n',
      "install-agent.sh": 'VERSION="0.1.0-alpha.19"\n',
      "channels.json": '{"beta":{"version":"0.1.0-alpha.19"}}\n',
      VERSION: "0.1.0-alpha.19\n",
    };
    let checksums = "";
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(packageDir, name), content);
      checksums += `${createHash("sha256").update(content).digest("hex")}  ${name}\n`;
    }
    await writeFile(join(packageDir, "SITE_SHA256SUMS"), checksums);
    if (scenario === "corrupt archive") await writeFile(join(packageDir, "index.html"), "corrupt");
    assert.equal(
      (await run("tar", ["-czf", join(work, "site.tar.gz"), "-C", packageDir, "."])).code,
      0,
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const expected = scenario === "changed website" ? "0.1.0-alpha.13" : "0.1.0-alpha.14";
    const result = await run("bash", [script, site, work, `http://127.0.0.1:${port}`, expected]);
    if (scenario === "success") {
      assert.equal(result.code, 0, result.output);
      assert.equal(await readFile(join(site, "index.html"), "utf8"), "new website");
      const backups = (await readdir(root)).filter((name) => name.startsWith("website.previous."));
      assert.equal(backups.length, 1);
      assert.equal(await readFile(join(root, backups[0], "index.html"), "utf8"), "old website");
    } else {
      assert.notEqual(result.code, 0, result.output);
      assert.equal(await readFile(join(site, "index.html"), "utf8"), "old website");
      assert.equal(
        await readFile(join(site, "install-agent.sh"), "utf8"),
        'VERSION="0.1.0-alpha.14"\n',
      );
    }
    assert.equal((await readdir(root)).includes("website.deploy.fixture"), false);
    process.stdout.write(`PASS: ${scenario}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.on("data", (part) => {
      output += part;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
