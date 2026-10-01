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
            Linux with systemd. Node.js 24 for the account that runs sudo. The page it opens is
            HTTP, on a port you trust.
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

      <section id="now" class="split">
        <div>
          <p class="kicker">In {{ product.version }}</p>
          <h2>What you can use today</h2>
          <ul>
            <li>Live CPU, memory, and disk, with history you can open per host</li>
            <li>Add a node, then disable, enable, re-enroll, or remove it</li>
            <li>Password and TOTP, an audit log, and a panel backup</li>
          </ul>
        </div>
        <div>
          <p class="kicker">Not in this version</p>
          <h2>Left out on purpose</h2>
          <ul>
            <li>Docker, PM2, Nginx, and certificates</li>
            <li>A signed package, and HTTPS on the panel itself</li>
            <li>Anything the host cannot measure, shown as a number</li>
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
