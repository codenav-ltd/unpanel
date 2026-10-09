// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Identifiers forks and packagers rebrand from this one module. */
export const product = {
  name: "Unpanel",
  tagline: "The server panel that doesn't act like one.",
  version: "0.1.0-alpha.35",
  license: "AGPL-3.0-or-later",
  sourceUrl: "https://github.com/codenav-ltd/unpanel",
  siteUrl: "https://unpanel.codenav.dev",
  /** channels.json. The panel also reads GitHub releases if this file is missing. */
  updatesUrl: "https://unpanel.codenav.dev/channels.json",
  bin: "unpanel",
  agentBin: "unpanel-agent",
  manageBin: "unpanel-manage",
  user: "unpanel",
  envPrefix: "UNPANEL_",
  agentEnvPrefix: "UNPANEL_AGENT_",
  paths: {
    etc: "/etc/unpanel",
    lib: "/var/lib/unpanel",
    run: "/run/unpanel",
    socket: "/run/unpanel/agent.sock",
    agentEtc: "/etc/unpanel-agent",
    agentLib: "/var/lib/unpanel-agent",
    manageBin: "/usr/local/sbin/unpanel-manage",
  },
  units: {
    panel: "unpanel.service",
    agent: "unpanel-agent.service",
  },
  cookies: {
    host: "__Host-unpanel_sid",
    loopback: "unpanel_sid",
  },
} as const;
