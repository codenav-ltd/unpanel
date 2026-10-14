<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { ref } from "vue";
import { product } from "@unpanel/shared";

const command = `curl -fsSL ${product.siteUrl}/install.sh | sudo bash`;
const copied = ref(false);
let copyTimer = 0;

async function copy(): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(command);
    } else if (!copyWithSelection(command)) {
      return;
    }
  } catch {
    if (!copyWithSelection(command)) return;
  }
  copied.value = true;
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1600);
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.focus();
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// Measured on 2026-10-14; see scripts/bench-footprint.sh and scripts/bench-update.sh.
const panels = ["Unpanel", "1Panel", "aaPanel", "BaoTa"];
const measured: { label: string; note?: string; values: string[] }[] = [
  {
    label: "Update to the next release",
    note: "Start to the new version answering",
    values: ["1.4 s", "4.5 s", "—", "—"],
  },
  { label: "Update download", values: ["1.5 MB", "61 MB", "—", "—"] },
  { label: "Panel offline during an update", values: ["0.7 s", "none seen", "—", "—"] },
  {
    label: "Install",
    note: "Depends on the network",
    values: ["34 s", "40 s", "25 min", "14 min"],
  },
  { label: "System packages added", values: ["0", "0", "275", "270"] },
  { label: "New files under /etc", values: ["7", "4", "397", "397"] },
  {
    label: "Disk used",
    note: "Unpanel needs Node.js 24, another 207 MB",
    values: ["8 MB", "197 MB", "1.8 GB", "1.3 GB"],
  },
  { label: "Processes running as root", values: ["1 of 2", "2 of 2", "4 of 5", "4 of 4"] },
  { label: "Idle memory (PSS)", values: ["140 MB", "138 MB", "94 MB", "74 MB"] },
];

const trace =
  "M0 92 H70 L86 92 L100 36 L118 128 L136 64 L152 92 H250 L268 92 L284 22 L306 138 L326 58 L344 92 H470 L488 92 L504 44 L522 124 L540 72 L556 92 H640";
</script>

<template>
  <div class="page">
    <header class="nav">
      <a class="mark" href="#top">
        <svg viewBox="0 0 28 16" aria-hidden="true">
          <path
            d="M1 10 H6 L8.5 3.5 L12 14 L15.2 6.5 L17.2 10 H27"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        Unpanel
      </a>
      <nav class="links" aria-label="Site">
        <a href="#install">Install</a>
        <a href="#numbers">Numbers</a>
        <a href="#now">This version</a>
        <a :href="product.sourceUrl">Source</a>
      </nav>
    </header>

    <main id="top">
      <section class="hero">
        <div class="hero-copy">
          <p class="kicker">Pre-alpha · {{ product.version }}</p>
          <h1>The server panel that doesn't act like one.</h1>
          <p class="lede">
            One web UI for the machines you already run. The panel process is not root. Each server
            keeps an agent that dials out.
          </p>
        </div>

        <figure class="pulse" aria-label="A host pulse, the shape the panel draws for each node">
          <div class="pulse-bar">
            <span class="dot"></span>
            <span>local</span>
            <span class="online">online</span>
          </div>
          <svg viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true">
            <path class="trace-base" :d="trace" pathLength="1" />
            <path class="trace" :d="trace" pathLength="1" />
          </svg>
          <p class="pulse-note">Live load, drawn as one line per host.</p>
        </figure>

        <div id="install" class="install">
          <div class="command">
            <pre><code>{{ command }}</code></pre>
            <button type="button" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
          </div>
          <p class="fine">
            Linux with systemd. Node.js 24 for the account that runs sudo. New installs serve
            self-signed HTTPS; compare the printed fingerprint before you trust it.
          </p>
        </div>
      </section>

      <section class="facts" aria-label="How it is built">
        <div>
          <h2>Unprivileged</h2>
          <p>The web process cannot become root. The local agent is a separate service.</p>
        </div>
        <div>
          <h2>Same on every host</h2>
          <p>The machine running the panel is the first node. Further hosts open the same page.</p>
        </div>
        <div>
          <h2>Agents dial out</h2>
          <p>A remote node opens the connection. The panel does not listen on that machine.</p>
        </div>
      </section>

      <section id="numbers" class="numbers">
        <p class="kicker">Measured on a fresh Ubuntu 22.04</p>
        <h2>Updates in seconds, not a stack on your server</h2>
        <dl class="stats">
          <div>
            <dt>Update to the next release</dt>
            <dd>1.4 s</dd>
          </div>
          <div>
            <dt>Update download</dt>
            <dd>1.5 MB</dd>
          </div>
          <div>
            <dt>System packages installed</dt>
            <dd>0</dd>
          </div>
          <div>
            <dt>Processes running as root</dt>
            <dd>1</dd>
          </div>
        </dl>

        <div class="compare-wrap">
          <table class="compare">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Measurement</span></th>
                <th v-for="panel in panels" :key="panel" scope="col">{{ panel }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in measured" :key="row.label">
                <th scope="row">
                  {{ row.label }}
                  <span v-if="row.note" class="row-note">{{ row.note }}</span>
                </th>
                <td v-for="(value, index) in row.values" :key="panels[index]">{{ value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="fine method">
          Default install from each project's own instructions, one disposable systemd container per
          panel on the same arm64 host, measured once on 14 October 2026: Unpanel 0.1.0-alpha.41,
          1Panel v2.3.2 without Docker, aaPanel 8.0.7 and BaoTa 13.1.0. Memory and CPU were read
          after five idle minutes. Updates ran on a 4-core arm64 cloud server, from Unpanel alpha.40
          and alpha.41 to alpha.42 (three runs, 1.4–1.5 s) and from 1Panel v2.3.1 to v2.3.2 (one
          run); the panel was probed every 0.2 s. aaPanel and BaoTa only install their latest
          release, so their update was not measured.
          <a :href="`${product.sourceUrl}/blob/main/scripts/bench-footprint.sh`">Run it yourself</a
          >.
        </p>
      </section>

      <section id="now" class="split">
        <div>
          <p class="kicker">In {{ product.version }}</p>
          <h2>What you can use today</h2>
          <ul>
            <li>Live CPU, memory, disk, and network, with history for every host</li>
            <li>Docker containers, images, networks, volumes, and Compose stacks</li>
            <li>Alerts by Telegram or email, and trusted certificates for the panel</li>
            <li>TOTP, passkeys, and team roles scoped to nodes</li>
          </ul>
        </div>
        <div>
          <p class="kicker">Not in this version</p>
          <h2>Left out on purpose</h2>
          <ul>
            <li>PM2, Nginx sites, and systemd services</li>
            <li>A web terminal and a file manager</li>
            <li>A bundled Node.js runtime</li>
          </ul>
        </div>
      </section>
    </main>

    <footer>
      <p>
        <a href="https://codenav.dev">CodeNav Ltd</a>
        · {{ product.license }} · <a :href="product.sourceUrl">GitHub</a>
      </p>
    </footer>
  </div>
</template>
