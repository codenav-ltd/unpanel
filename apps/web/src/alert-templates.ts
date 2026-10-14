// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import type { AlertMetric, AlertRule } from "@unpanel/shared";

export interface TemplateLevel {
  threshold: number;
  durationSeconds: number;
}

export interface AlertTemplate {
  metric: AlertMetric;
  name: string;
  /** Why someone would want it, in one line. */
  why: string;
  /** Null for a single-level rule. */
  warning: TemplateLevel | null;
  /** The rule's top level; its severity is critical when there is a warning level. */
  top: TemplateLevel & { severity: "warning" | "critical" };
  recovery?: boolean;
}

export const templateGroups: { title: string; templates: AlertTemplate[] }[] = [
  {
    title: "Resources",
    templates: [
      {
        metric: "cpu",
        name: "CPU usage",
        why: "A process is spinning or the server is undersized.",
        warning: { threshold: 80, durationSeconds: 300 },
        top: { threshold: 90, durationSeconds: 300, severity: "critical" },
      },
      {
        metric: "load",
        name: "Load per core",
        why: "More work is queued than the cores can run, including work waiting on disk.",
        warning: { threshold: 100, durationSeconds: 600 },
        top: { threshold: 150, durationSeconds: 600, severity: "critical" },
      },
      {
        metric: "memory",
        name: "Memory usage",
        why: "Catches leaks before the kernel starts killing processes.",
        warning: { threshold: 80, durationSeconds: 300 },
        top: { threshold: 90, durationSeconds: 180, severity: "critical" },
      },
      {
        metric: "swap",
        name: "Swap usage",
        why: "Heavy swapping makes everything slow long before memory runs out.",
        warning: { threshold: 50, durationSeconds: 600 },
        top: { threshold: 80, durationSeconds: 300, severity: "critical" },
      },
      {
        metric: "disk",
        name: "System disk usage",
        why: "A full disk stops logs, databases and package updates.",
        warning: { threshold: 80, durationSeconds: 300 },
        top: { threshold: 90, durationSeconds: 60, severity: "critical" },
      },
    ],
  },
  {
    title: "Network",
    templates: [
      {
        metric: "network_in",
        name: "Inbound traffic",
        why: "A traffic spike or flood. Set it near your link speed.",
        warning: { threshold: 500, durationSeconds: 300 },
        top: { threshold: 800, durationSeconds: 300, severity: "critical" },
      },
      {
        metric: "network_out",
        name: "Outbound traffic",
        why: "Unexpected uploads, or a quota being used up.",
        warning: { threshold: 500, durationSeconds: 300 },
        top: { threshold: 800, durationSeconds: 300, severity: "critical" },
      },
      {
        metric: "connections",
        name: "TCP connections",
        why: "Connection leaks or a connection flood.",
        warning: { threshold: 5_000, durationSeconds: 300 },
        top: { threshold: 20_000, durationSeconds: 120, severity: "critical" },
      },
    ],
  },
  {
    title: "Availability",
    templates: [
      {
        metric: "offline",
        name: "Node offline",
        why: "The server or its network is down.",
        warning: { threshold: 1, durationSeconds: 60 },
        top: { threshold: 1, durationSeconds: 300, severity: "critical" },
      },
      {
        metric: "restarted",
        name: "Server restarted",
        why: "An unplanned reboot, a crash or a provider maintenance window.",
        warning: null,
        top: { threshold: 10, durationSeconds: 0, severity: "warning" },
        recovery: false,
      },
    ],
  },
  {
    title: "Certificates",
    templates: [
      {
        metric: "certificate",
        name: "Panel certificate expiry",
        why: "Browsers and agents stop trusting the panel when it expires.",
        warning: { threshold: 21, durationSeconds: 0 },
        top: { threshold: 7, durationSeconds: 0, severity: "critical" },
      },
      {
        metric: "certificates",
        name: "Managed certificate expiry",
        why: "Any certificate issued or imported in Certificates, one alert each.",
        warning: { threshold: 21, durationSeconds: 0 },
        top: { threshold: 7, durationSeconds: 0, severity: "critical" },
      },
    ],
  },
];

export const templates: AlertTemplate[] = templateGroups.flatMap((group) => group.templates);

export function templateFor(metric: AlertMetric): AlertTemplate {
  const found = templates.find((template) => template.metric === metric);
  if (!found) throw new Error(`No template for ${metric}`);
  return found;
}

/** The rule body a template creates: all nodes, all channels, enabled. */
export function ruleFromTemplate(template: AlertTemplate): Omit<AlertRule, "id"> {
  return {
    name: template.name,
    metric: template.metric,
    enabled: true,
    threshold: template.top.threshold,
    durationSeconds: template.top.durationSeconds,
    severity: template.top.severity,
    warning: template.warning,
    nodeIds: [],
    channelIds: [],
    recovery: template.recovery ?? true,
    repeatMinutes: template.top.severity === "critical" ? 60 : 0,
  };
}
