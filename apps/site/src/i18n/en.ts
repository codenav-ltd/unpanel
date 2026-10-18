// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/**
 * Source locale. Text in backticks renders as code. Product names, commands, paths and the
 * names of panel pages stay in English in every locale (docs/design/11-website.md §5).
 */
export const en = {
  meta: {
    title: "Unpanel · Every server you run, on one page",
    description:
      "A free, open-source panel for your Linux servers. One small agent per server dials out to your panel: monitoring, alerts, terminal, files and Docker for all of them. Nothing else installed.",
    ogAlt: "The Unpanel overview, showing six servers with their CPU rails",
  },
  nav: {
    label: "Site",
    product: "Product",
    compare: "Compare",
    security: "Security",
    pricing: "Pricing",
    faq: "FAQ",
    source: "Source",
    menu: "Menu",
    close: "Close menu",
    language: "中文",
    languageLabel: "阅读中文版",
  },
  hero: {
    status: "Pre-alpha · free and open source",
    title: "Every server you run, on one page. Nothing else installed on them.",
    lede: "One small agent on each server dials out to your panel. See load and alerts for all of them, and open a terminal, files or Docker on any one. Free for every server.",
    requirements: "Linux with systemd · x86_64 and arm64 · Node.js 24",
    whatItDoes: "What the installer does",
    sourceLink: "Read the source on GitHub",
  },
  copy: {
    copy: "Copy",
    copied: "Copied",
    label: "Copy the install command",
  },
  fleet: {
    label: "A simulated Unpanel overview. Choose a server to see its resources.",
    title: "Overview",
    online: "{online} of {total} online",
    attention: "{count} need attention",
    rail: "CPU, last 10 min",
    cpu: "CPU",
    memory: "Memory",
    swap: "Swap",
    storage: "Storage",
    disk: "Disk",
    offline: "Offline for 4 min. Telegram alert sent.",
    noSwap: "No swap",
    simulated: "Simulated servers. Your panel draws this from your own.",
    servers: {
      tokyo: "Ubuntu 24.04 · 4 vCPU",
      fra: "Debian 12 · 8 vCPU",
      nas: "Home, behind NAT · arm64",
      sgp: "Ubuntu 22.04 · 2 vCPU",
      ci: "Debian 12 · 16 vCPU",
      lon: "Offline",
    },
  },
  tour: {
    title: "One page for each job",
    lede: "Screens from a real panel managing a small shop: a web server, an API, Postgres and Redis in Docker.",
    steps: [
      {
        id: "dashboard",
        name: "Dashboard",
        title: "Know what a server is doing",
        body: "CPU, memory, swap and storage with average and peak, throughput, connections, Docker and alerts on one screen. Move, resize or remove any card.",
        alt: "The node dashboard with CPU, memory, swap and storage tiles, network throughput and a Docker card",
      },
      {
        id: "docker",
        name: "Docker",
        title: "Run the containers you already have",
        body: "Containers, images, networks, volumes and Compose stacks. Logs, a shell and live stats for each container, and an alert when one crashes.",
        alt: "The Docker page listing the shop stack's containers",
      },
      {
        id: "terminal",
        name: "Terminal",
        title: "A shell on any server, in the browser",
        body: "Sessions as tabs, links that open on click and a key bar on phones. Each session is recorded in Audit with the account, address and duration.",
        alt: "A web terminal showing docker compose ps on the server",
      },
      {
        id: "files",
        name: "Files",
        title: "Edit files where they live",
        body: "Browse, upload up to 2 GiB, drag to move, compress and extract. If a file changed on the server while you edited it, you see both versions before saving.",
        alt: "The file manager showing the shop folder with its compose file open",
      },
      {
        id: "alerts",
        name: "Alerts",
        title: "Hear about it before your users do",
        body: "Disks filling up, containers crashing, certificates expiring, servers going offline. A warning first, then critical, by Telegram or email.",
        alt: "The Alerts page with an active container incident",
      },
    ],
  },
  footprint: {
    title: "Nothing else installed",
    lede: "What a default install leaves on a fresh Ubuntu 22.04, measured with the same script for every panel.",
    metrics: {
      diskMb: {
        tab: "Disk used",
        unit: "MB",
        note: "One square per 10 MB. The dim squares are Node.js 24, the runtime Unpanel runs on.",
      },
      packages: {
        tab: "System packages",
        unit: "packages",
        note: "One square per system package the installer added.",
      },
      etcFiles: {
        tab: "Files under /etc",
        unit: "files",
        note: "One square per file added under `/etc`.",
      },
    },
    runtime: "+ {mb} MB Node.js",
    none: "None",
    facts: [
      { value: "27 s", label: "to install; aaPanel and BaoTa take 13 to 15 min" },
      { value: "1 of 2", label: "processes run as root" },
      { value: "0", label: "ports opened on managed servers" },
    ],
    compare: "Compare everything side by side",
  },
  compare: {
    title: "Next to the panels you know",
    lede: "Footprint measured with one script on one host, vendor facts from their own pages and code. Rows where Unpanel loses stay in.",
    measurement: "Measurement",
    groups: {
      cost: "Cost and licence",
      servers: "Adding servers",
      footprint: "What the install leaves",
      privileges: "Privileges",
      updates: "Updates",
      idle: "At idle",
    },
    rows: {
      multiServer: { label: "Managing several servers" },
      licence: { label: "Licence" },
      nodeRuns: { label: "What each managed server runs" },
      nodePorts: { label: "Ports a managed server must accept" },
      nat: { label: "Joins from behind NAT", note: "Without port forwarding" },
      install: { label: "Install", note: "Depends on the network" },
      packages: { label: "System packages added" },
      etc: { label: "New files under /etc" },
      disk: { label: "Disk used", note: "Unpanel also needs Node.js 24, another 203 MB" },
      root: { label: "Processes running as root" },
      update: {
        label: "Update to the next release",
        note: "Measured 14 October on 0.1.0-alpha.41",
      },
      updateDownload: { label: "Update download" },
      updateOffline: { label: "Panel offline during an update" },
      memory: { label: "Memory (PSS)" },
    },
    values: {
      free: "Free",
      paidPerNode: "Pro licence per node",
      ownNoPublish: "Own licence, changes may not be published",
      proprietary: "Proprietary, no changes allowed",
      agent: "An agent",
      fullPanel: "The whole panel",
      none: "None",
      sshAgentPort: "SSH and port 9999",
      panelOrSsh: "Its panel port, or SSH",
      yes: "Yes",
      no: "No",
      noneSeen: "None seen",
    },
    method:
      "Default install from each project's own instructions, one disposable systemd container per panel on the same arm64 host, measured on 18 October 2026: {versions}. Memory was read after five idle minutes. Updates ran on a 4-core arm64 cloud server, probing the panel every 0.2 s; aaPanel and BaoTa only install their latest release, so theirs was not measured. A dash means not measured or not applicable.",
    runIt: "Run the benchmark yourself",
    sources: {
      onePanelEditions: "1Panel editions",
      onePanelNodes: "1Panel node management",
      baotaPricing: "BaoTa editions",
      aapanelLicence: "aaPanel licence",
    },
  },
  connect: {
    title: "Servers dial out to the panel",
    lede: "Add node gives you one command. The agent it installs opens a connection to your panel and keeps it open, so a server needs no open port, and one behind NAT or a home router works too.",
    panel: "Your panel",
    panelNote: "tokyo-web-1 · also a node",
    nat: "Behind NAT",
    facts: [
      {
        title: "No inbound port",
        body: "Nothing listens on a managed server. The agent connects out over WebSocket with TLS and checks the panel's key.",
      },
      {
        title: "Follows the panel",
        body: "Move the panel to a new address and every online agent checks it, saves it and keeps the old one as a fallback.",
      },
      {
        title: "Same page for every server",
        body: "The panel's own machine is the first node. Every server you add gets the same dashboard, terminal, files and Docker.",
      },
    ],
  },
  security: {
    title: "Root stays behind a door",
    lede: "The web process runs as its own unprivileged user. Privileged work goes to the agent as named, checked requests, and there is no endpoint that runs an arbitrary command.",
    replayLabel: "What happens when you open a terminal",
    replay: [
      {
        title: "Open Terminal on fra-db-2",
        body: "Owners and admins only. Other roles never see it.",
      },
      {
        title: "Confirm it's you",
        body: "A passkey or an authenticator code. It lasts five minutes, then the next risky action asks again.",
      },
      {
        title: "Recorded in Audit",
        body: "Who, from where, on which server, and for how long.",
      },
    ],
    dialog: {
      title: "Confirm it's you",
      body: "Opening a terminal needs a recent sign-in.",
      passkey: "Use passkey",
      code: "Enter a code instead",
    },
    audit: {
      title: "Audit",
      action: "terminal.open",
      duration: "12 min",
    },
    next: "Next step",
    restart: "Play again",
    facts: [
      "Passkeys and two-factor sign-in from the first run, with recovery codes",
      "Team roles scoped to the servers each person may touch",
      "Turn the terminal off on any server with `UNPANEL_TERMINAL=off`",
      "Files always refuses `/etc/shadow` and Unpanel's own keys",
    ],
  },
  updates: {
    title: "Updates in under two seconds, undone if they fail",
    lede: "An update downloads 1.5 MB, checks its SHA-256 and switches over. If the new version does not answer its health check, the previous one is started again and your database is kept.",
    race: "Time from starting an update to the new version answering",
    seconds: "{value} s",
    download: "{value} MB download",
    releasesTitle: "{count} releases since {date}",
    releasesLede: "Every release lists what changed. Hover or focus a mark to read it.",
    changelog: "Read the changelog",
  },
  pricing: {
    title: "Free. Every server, every feature.",
    lede: "1Panel sells multi-node management as a Pro licence for each node. Unpanel has one edition, and it stays whole.",
    price: "$0",
    per: "for every server and everyone on your team",
    promises: [
      {
        title: "No Pro or Enterprise tier",
        body: "There will never be a paid edition with features this one lacks.",
      },
      {
        title: "No server limit",
        body: "Add every server you run and everyone on your team. None of it is an upgrade.",
      },
      {
        title: "Nothing taken back",
        body: "No feature moves behind payment. Every release is AGPL, so what you have stays yours.",
      },
    ],
    decision: "Read the decision",
  },
  roadmap: {
    title: "What it does today, and what comes next",
    nowTitle: "In {version}",
    nextTitle: "Next",
    now: [
      "Live and historical CPU, memory, disk and network for every server",
      "Docker containers, images, networks, volumes and Compose stacks",
      "A web terminal and a file manager",
      "Alerts by Telegram and email, including disk forecasts and crashed containers",
      "Let's Encrypt certificates, also behind an existing web server",
      "Passkeys, two-factor sign-in, team roles and an audit log",
      "One-click updates for the panel and every agent",
    ],
    next: [
      "systemd services and their logs",
      "Nginx sites with test and rollback",
      "PM2 processes",
      "Scheduled jobs",
      "Firewall changes that undo themselves unless confirmed",
      "Backups to S3 or WebDAV",
      "Node.js bundled with the release",
    ],
  },
  faq: {
    title: "Questions",
    items: [
      {
        q: "It says pre-alpha. Can I use it?",
        a: "On servers where you can tolerate rough edges, yes. Releases come every few days, each with a changelog, and a failed update restores the previous version with your data. Some modules are still missing; the list above says which.",
      },
      {
        q: "What does it change on my server?",
        a: "It installs into `/opt/unpanel`, keeps data in `/var/lib/unpanel` and settings in `/etc/unpanel`, and adds two systemd services and an `unpanel` user. It installs no system packages and does not touch your Nginx, Docker or cron configuration.",
      },
      {
        q: "Why does it need Node.js 24?",
        a: "The panel and the agent run on Node.js. Install Node.js 24 first, from your distribution's NodeSource packages or the official tarball. Bundling it with each release is planned, so this step will go away.",
      },
      {
        q: "How do I remove it?",
        a: "Stop and disable `unpanel` and `unpanel-agent`, then delete `/opt/unpanel`, `/etc/unpanel`, `/var/lib/unpanel` and the two unit files. An `unpanel uninstall` command is planned.",
      },
      {
        q: "Does it send data anywhere?",
        a: "There is no analytics or telemetry. The panel asks unpanel.codenav.dev and GitHub for new releases, and talks to Telegram or your email provider only after you set them up. Everything else stays on your panel's machine.",
      },
      {
        q: "If it's free, how will it last?",
        a: "Unpanel is built by CodeNav Ltd, and the one-edition promise is a recorded decision in the repository. The code is AGPL-3.0, so every released version stays yours to run, change and share.",
      },
      {
        q: "Which systems are supported?",
        a: "Linux with systemd on x86_64 or arm64: Debian 11 to 13 and Ubuntu 22.04 and 24.04. AlmaLinux and Rocky Linux 9 are best effort.",
      },
    ],
  },
  install: {
    title: "Install it in about half a minute",
    lede: "Run this as root on the server that should host the panel.",
    steps: [
      "Downloads the release for your CPU and checks its SHA-256.",
      "Starts the panel and its local agent as two systemd services.",
      "Prints the panel's address and certificate fingerprint. Open it, create your account and turn on two-factor sign-in.",
    ],
    then: "Then add each further server from Add node, with one command.",
  },
  footer: {
    by: "Made by",
    changelog: "Changelog",
    security: "Security policy",
    license: "AGPL-3.0",
  },
};

export type Messages = typeof en;
