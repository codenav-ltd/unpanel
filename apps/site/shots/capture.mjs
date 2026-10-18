// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Captures the website's product screenshots from the demo fleet started by run.sh.
//
//   apps/site/shots/run.sh && pnpm --filter @unpanel/site shots
//
// First run: completes setup through the API, enrols the agent-only servers and adds a
// Container down rule. Give the panel ten minutes afterwards so the charts have history,
// then run it again. Images go to src/assets/shots/ as WebP; see docs/design/11-website.md §3.2.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const panelUrl = "https://127.0.0.1:28600";
const container = "unpanel-shots-panel";
const agents = ["fra-db-2", "sgp-edge-1"];
const username = "maya";
const password = "demo-shots-2026-long-pass";
const out = fileURLToPath(new URL("../src/assets/shots/", import.meta.url));

// The demo panel serves its own self-signed certificate on loopback.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function exec(name, script) {
  return execFileSync("docker", ["exec", name, "bash", "-c", script], { encoding: "utf8" });
}

async function api(path, { cookie, body, method } = {}) {
  const response = await fetch(`${panelUrl}${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      origin: panelUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return { json: text ? JSON.parse(text) : null, headers: response.headers };
}

function sessionCookie(headers) {
  const raw = headers.getSetCookie().find((value) => value.includes("unpanel_sid="));
  if (!raw) throw new Error("The panel did not set a session cookie.");
  return raw.split(";")[0];
}

async function signIn() {
  const token = exec(
    container,
    "journalctl -u unpanel --no-pager -o cat | sed -n 's/.*?token=\\(st_[A-Za-z0-9_-]*\\).*/\\1/p' | tail -1",
  ).trim();
  try {
    const { json } = await api("/api/v1/setup/begin", { body: { token, username, password } });
    const { headers } = await api("/api/v1/setup/confirm", {
      body: { ticket: json.ticket, totp: false },
    });
    console.log("setup complete");
    return sessionCookie(headers);
  } catch (error) {
    if (!String(error).includes("404")) throw error;
  }
  const { headers } = await api("/api/v1/auth/login", { body: { username, password } });
  return sessionCookie(headers);
}

async function prepare(cookie) {
  const { json } = await api("/api/v1/nodes", { cookie });
  for (const agent of agents) {
    const node = json.data.find((candidate) => candidate.name === agent);
    if (node?.hasKey) continue;
    const created = node
      ? await api(`/api/v1/nodes/${node.id}/enrollment-token`, { cookie, body: {} })
      : await api("/api/v1/nodes", { cookie, body: { name: agent } });
    // The containers run as root and have no sudo.
    exec(`unpanel-shots-${agent}`, created.json.data.fresh.replaceAll("sudo ", ""));
    console.log(`enrolled ${agent}`);
  }
  const alerts = await api("/api/v1/alerts", { cookie });
  if (!JSON.stringify(alerts.json).includes('"metric":"container"')) {
    await api("/api/v1/alerts/rules", {
      cookie,
      body: {
        name: "Container down",
        enabled: true,
        metric: "container",
        threshold: 1,
        durationSeconds: 60,
        severity: "critical",
        warning: { threshold: 1, durationSeconds: 0 },
        nodeIds: [],
        channelIds: [],
        recovery: true,
        repeatMinutes: 0,
      },
    });
    console.log("added the Container down rule");
  }
}

/** The tour shows a screen about 800 CSS pixels wide, so 1800 pixels stays sharp at 2×. */
const WIDTH = 1800;

/** Scales a PNG down and re-encodes it as WebP in the browser, which needs no image library. */
async function webp(page, png) {
  const data = `data:image/png;base64,${png.toString("base64")}`;
  const encoded = await page.evaluate(
    async ([source, width]) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((image.naturalHeight * width) / image.naturalWidth);
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.88).split(",")[1];
    },
    [data, WIDTH],
  );
  return Buffer.from(encoded, "base64");
}

async function confirmIdentity(page) {
  const field = page.locator('dialog[open] input[type="password"]');
  if (await field.isVisible({ timeout: 4000 }).catch(() => false)) {
    await field.fill(password);
    await field.press("Enter");
    await page.waitForTimeout(1500);
  }
}

const shots = [
  { id: "dashboard", path: "/nodes/local", settle: 4000 },
  { id: "docker", path: "/nodes/local/docker", settle: 3000 },
  {
    id: "terminal",
    path: "/nodes/local/terminal",
    settle: 2000,
    async act(page) {
      await confirmIdentity(page);
      await page.locator(".xterm").first().click();
      await page.keyboard.type("cd /srv/shop && docker compose ps\n", { delay: 20 });
      await page.waitForTimeout(2500);
    },
  },
  {
    id: "files",
    path: "/nodes/local/files?path=/srv/shop",
    settle: 2000,
    async act(page) {
      await confirmIdentity(page);
      await page.getByText("compose.yaml", { exact: true }).first().dblclick();
      await page.waitForTimeout(2500);
    },
  },
  { id: "alerts", path: "/alerts", settle: 3000 },
];

const cookie = await signIn();
await prepare(cookie);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  ignoreHTTPSErrors: true,
});
const [name, value] = cookie.split("=");
await context.addCookies([{ name, value, url: panelUrl }]);
const page = await context.newPage();
await mkdir(out, { recursive: true });

const only = new Set(process.argv.slice(2));
for (const shot of shots) {
  if (only.size > 0 && !only.has(shot.id)) continue;
  await page.goto(`${panelUrl}${shot.path}`);
  await page.waitForTimeout(shot.settle);
  if (shot.act) await shot.act(page);
  const png = await page.screenshot();
  await writeFile(`${out}${shot.id}.webp`, await webp(page, png));
  console.log(`captured ${shot.id}`);
}

await browser.close();
