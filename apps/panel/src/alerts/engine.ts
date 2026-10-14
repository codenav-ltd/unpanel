// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AlertIncident,
  AlertMetric,
  AlertRule,
  AlertSeverity,
  AlertWarningLevel,
} from "@unpanel/shared";
import type { NodeLive } from "../hub.ts";
import type { NodeRecord } from "../nodes/store.ts";
import type { createChannels } from "./channels.ts";
import { AlertError, booleanField, ids, integer, severity, textField } from "./validation.ts";

interface Target {
  id: string;
  name: string;
  value: number | null;
  maintenance: boolean;
}
interface IncidentRow extends AlertIncident {
  lastNotified: number;
}
interface Pending {
  /** When the critical (or single) level started to hold. */
  breachAt: number | null;
  /** When the earlier warning level started to hold. */
  warnAt: number | null;
  recoveryAt: number | null;
  /** When a critical incident fell back below its critical level. */
  calmAt: number | null;
}

type Seed = [string, AlertMetric, number, number, AlertSeverity, AlertWarningLevel | null];

/** Seeded before alpha.41. Rules still exactly like these can be replaced by the current set. */
const LEGACY_DEFAULTS: Seed[] = [
  ["Node offline", "offline", 1, 120, "critical", null],
  ["Disk almost full", "disk", 90, 300, "warning", null],
  ["Disk critically full", "disk", 97, 60, "critical", null],
  ["Memory pressure", "memory", 95, 300, "warning", null],
  ["Sustained CPU load", "cpu", 95, 600, "warning", null],
  ["Panel certificate expires soon", "certificate", 14, 0, "warning", null],
  ["Panel certificate needs renewal", "certificate", 3, 0, "critical", null],
];

/** Warn early, then raise the same incident to critical. */
export const RECOMMENDED_RULES: Seed[] = [
  ["Node offline", "offline", 1, 300, "critical", { threshold: 1, durationSeconds: 60 }],
  ["CPU usage", "cpu", 90, 300, "critical", { threshold: 80, durationSeconds: 300 }],
  ["Memory usage", "memory", 90, 180, "critical", { threshold: 80, durationSeconds: 300 }],
  ["System disk usage", "disk", 90, 60, "critical", { threshold: 80, durationSeconds: 300 }],
  ["Swap usage", "swap", 80, 300, "critical", { threshold: 50, durationSeconds: 600 }],
  [
    "Panel certificate expiry",
    "certificate",
    7,
    0,
    "critical",
    { threshold: 21, durationSeconds: 0 },
  ],
];

function seeded([name, metric, threshold, durationSeconds, severity, warning]: Seed): AlertRule {
  return {
    id: randomUUID(),
    name,
    metric,
    threshold,
    durationSeconds,
    severity,
    warning,
    enabled: true,
    nodeIds: [],
    channelIds: [],
    recovery: true,
    repeatMinutes: severity === "critical" ? 60 : 0,
  };
}

function untouchedLegacy(rule: AlertRule): boolean {
  return LEGACY_DEFAULTS.some(
    ([name, metric, threshold, durationSeconds, severity]) =>
      rule.name === name &&
      rule.metric === metric &&
      rule.threshold === threshold &&
      rule.durationSeconds === durationSeconds &&
      rule.severity === severity &&
      rule.warning === null &&
      rule.enabled &&
      rule.recovery &&
      !rule.nodeIds.length &&
      !rule.channelIds.length &&
      rule.repeatMinutes === (severity === "critical" ? 60 : 0),
  );
}

/** True when `value` meets a level: usage at or above it, days remaining at or below it. */
function meets(metric: AlertMetric, value: number, threshold: number): boolean {
  return metric === "certificate" ? value <= threshold : value >= threshold;
}
export function createAlertEngine(options: {
  db: DatabaseSync;
  channels: ReturnType<typeof createChannels>;
  nodes: () => NodeRecord[];
  live: () => NodeLive[];
  sampledAt: (id: string) => number;
  certificates: () => { id: string; host: string; notAfter: number; active: boolean }[];
  publicUrl: () => string;
  now?: () => number;
}) {
  const { db, channels } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const pending = new Map<string, Pending>();
  let prunedAt = 0;
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_incidents (
      id TEXT PRIMARY KEY, ruleId TEXT NOT NULL, name TEXT NOT NULL,
      targetId TEXT NOT NULL, targetName TEXT NOT NULL, severity TEXT NOT NULL,
      startedAt INTEGER NOT NULL, resolvedAt INTEGER, acknowledgedAt INTEGER,
      silencedUntil INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL, lastNotified INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS incident_open ON alert_incidents(ruleId, targetId) WHERE resolvedAt IS NULL;
    CREATE INDEX IF NOT EXISTS incident_started ON alert_incidents(startedAt);
    CREATE TABLE IF NOT EXISTS alert_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  function rules(): AlertRule[] {
    return (
      db.prepare("SELECT config FROM alert_rules ORDER BY rowid").all() as { config: string }[]
    ).map((row) => {
      const rule = JSON.parse(row.config) as AlertRule;
      // Rules saved before alpha.41 have no warning level.
      return { ...rule, warning: rule.warning ?? null };
    });
  }
  function persist(rule: AlertRule): void {
    db.prepare(
      "INSERT INTO alert_rules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config=excluded.config",
    ).run(rule.id, JSON.stringify(rule));
  }
  if (!db.prepare("SELECT 1 FROM alert_meta WHERE key = 'seeded'").get()) {
    for (const seed of RECOMMENDED_RULES) persist(seeded(seed));
    db.prepare("INSERT INTO alert_meta VALUES ('seeded', '1')").run();
  }
  function targets(rule: AlertRule, nodes: NodeRecord[], live: Map<string, NodeLive>): Target[] {
    if (rule.metric === "certificate")
      return options
        .certificates()
        .filter((cert) => cert.active)
        .map((cert) => ({
          id: "panel-certificate",
          name: cert.host,
          value: (cert.notAfter - now()) / 86_400_000,
          maintenance: false,
        }));
    return nodes
      .filter(
        (node) =>
          node.status === "active" && (!rule.nodeIds.length || rule.nodeIds.includes(node.id)),
      )
      .map((node) => {
        const reading = live.get(node.id);
        let value: number | null = null;
        if (rule.metric === "offline")
          value = reading?.online ? 0 : now() - startedAt >= 180_000 ? 1 : null;
        else if (
          reading?.online &&
          options.sampledAt(node.id) > 0 &&
          now() - options.sampledAt(node.id) <= 45_000
        ) {
          if (rule.metric === "cpu")
            value = reading.cpuRatio === null ? null : reading.cpuRatio * 100;
          if (rule.metric === "memory")
            value = reading.memRatio === null ? null : reading.memRatio * 100;
          if (rule.metric === "disk")
            value = reading.diskRatio === null ? null : reading.diskRatio * 100;
          if (rule.metric === "swap")
            value =
              reading.swapTotal && reading.swapUsed !== null
                ? (reading.swapUsed / reading.swapTotal) * 100
                : null;
        }
        return {
          id: node.id,
          name: node.name || reading?.hostname || node.id,
          value,
          maintenance: node.maintenance,
        };
      });
  }
  /** The threshold behind an incident's current severity. */
  function levelThreshold(rule: AlertRule, level: AlertSeverity): number {
    return level === "warning" && rule.warning ? rule.warning.threshold : rule.threshold;
  }
  function detail(rule: AlertRule, target: Target, level: AlertSeverity = rule.severity): string {
    if (rule.metric === "offline")
      return target.value === 1
        ? "The node is not connected to the panel."
        : "The node is connected again.";
    if (rule.metric === "certificate")
      return `The active panel certificate has ${Math.max(0, Math.ceil(target.value ?? 0))} days remaining.`;
    return `${rule.metric[0]?.toUpperCase()}${rule.metric.slice(1)} usage is ${(target.value ?? 0).toFixed(1)}% (${level} at ${levelThreshold(rule, level)}%).`;
  }
  function notify(
    rule: AlertRule,
    incident: IncidentRow,
    target: Target,
    kind: "firing" | "resolved" | "repeat" | "escalated",
  ): void {
    if (target.maintenance || incident.silencedUntil > now()) return;
    const level = incident.severity;
    const label =
      kind === "resolved"
        ? "Resolved"
        : kind === "escalated"
          ? "Now critical"
          : level === "critical"
            ? "Critical"
            : "Warning";
    const title = `Unpanel · ${label}: ${rule.name}`;
    const address = options.publicUrl();
    const queued = channels.notify(
      {
        title,
        text: `${target.name}\n${detail(rule, target, level)}\n${new Date(now()).toISOString()}${address ? `\n\n${address}/alerts` : ""}`,
        key: incident.id,
        // An escalation is a new firing at the higher level, so critical-only channels get it.
        source: {
          ruleId: rule.id,
          incidentId: incident.id,
          event: kind === "escalated" ? "firing" : kind,
        },
      },
      level,
      rule.channelIds,
    );
    if (queued)
      db.prepare("UPDATE alert_incidents SET lastNotified = ? WHERE id = ?").run(
        now(),
        incident.id,
      );
  }
  function warningLevel(value: unknown, rule: AlertRule): AlertWarningLevel | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value))
      throw new AlertError("Send the warning level as an object, or null for none.");
    if (rule.severity !== "critical")
      throw new AlertError("An earlier warning level needs a critical rule.");
    const level = value as Record<string, unknown>;
    const durationSeconds = integer(
      level["durationSeconds"],
      "Warning duration in seconds",
      0,
      86400,
    );
    if (rule.metric === "offline") {
      if (durationSeconds >= rule.durationSeconds)
        throw new AlertError("Warn about an offline node sooner than the critical alert.");
      return { threshold: 1, durationSeconds };
    }
    if (rule.metric === "certificate") {
      const threshold = integer(level["threshold"], "Warning days", 1, 90);
      if (threshold <= rule.threshold)
        throw new AlertError("The warning needs more days remaining than the critical level.");
      return { threshold, durationSeconds: 0 };
    }
    const threshold = integer(level["threshold"], "Warning threshold", 1, 100);
    if (threshold >= rule.threshold)
      throw new AlertError("The warning threshold must be below the critical threshold.");
    return { threshold, durationSeconds };
  }
  function closeRule(id: string, reason: string): void {
    channels.cancelRule(id);
    db.prepare(
      "UPDATE alert_incidents SET resolvedAt = ?, detail = ? WHERE ruleId = ? AND resolvedAt IS NULL",
    ).run(now(), reason, id);
    for (const key of pending.keys()) if (key.startsWith(`${id}:`)) pending.delete(key);
  }
  function refreshNotificationTime(id: string): number {
    const at = channels.lastNotification(id);
    db.prepare(
      "UPDATE alert_incidents SET lastNotified = ? WHERE id = ? AND lastNotified != ?",
    ).run(at, id, at);
    return at;
  }
  return {
    rules,
    incidents(): AlertIncident[] {
      // Active incidents remain visible; the history is bounded independently.
      const rows = db
        .prepare(
          "SELECT * FROM alert_incidents WHERE resolvedAt IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, startedAt DESC",
        )
        .all();
      const history = db
        .prepare(
          "SELECT * FROM alert_incidents WHERE resolvedAt IS NOT NULL ORDER BY resolvedAt DESC LIMIT 100",
        )
        .all();
      return [...rows, ...history].map((row) => {
        const incident = row as unknown as IncidentRow;
        return {
          id: incident.id,
          ruleId: incident.ruleId,
          name: incident.name,
          targetId: incident.targetId,
          targetName: incident.targetName,
          severity: incident.severity,
          startedAt: incident.startedAt,
          resolvedAt: incident.resolvedAt,
          acknowledgedAt: incident.acknowledgedAt,
          silencedUntil: incident.silencedUntil,
          detail: incident.detail,
        };
      });
    },
    save(body: Record<string, unknown>, id?: string): void {
      const old = id ? rules().find((rule) => rule.id === id) : null;
      if (id && !old) throw new AlertError("This rule no longer exists.", 404);
      if (!old && rules().length >= 100)
        throw new AlertError("You can configure up to 100 alert rules.");
      const metric = body["metric"] as AlertMetric;
      if (!["offline", "cpu", "memory", "disk", "swap", "certificate"].includes(metric))
        throw new AlertError("Choose a supported alert condition.");
      const nodeIds = ids(body["nodeIds"]);
      const channelIds = ids(body["channelIds"]);
      if (nodeIds.some((id) => !options.nodes().some((node) => node.id === id)))
        throw new AlertError("One of the selected nodes no longer exists.");
      if (channelIds.some((id) => !channels.view().some((channel) => channel.id === id)))
        throw new AlertError("One of the selected channels no longer exists.");
      const rule: AlertRule = {
        id: id ?? randomUUID(),
        name: textField(body["name"], "rule name", 100),
        metric,
        enabled: booleanField(body["enabled"]),
        threshold:
          metric === "offline"
            ? 1
            : integer(body["threshold"], "Threshold", 1, metric === "certificate" ? 90 : 100),
        durationSeconds: integer(body["durationSeconds"], "Duration in seconds", 0, 86400),
        severity: severity(body["severity"]),
        nodeIds: metric === "certificate" ? [] : nodeIds,
        channelIds,
        recovery: booleanField(body["recovery"]),
        repeatMinutes: integer(body["repeatMinutes"], "Repeat interval in minutes", 0, 10080),
        warning: null,
      };
      rule.warning = warningLevel(body["warning"], rule);
      if (rule.repeatMinutes > 0 && rule.repeatMinutes < 5)
        throw new AlertError("Use at least 5 minutes between reminders, or 0 to turn them off.");
      if (old)
        closeRule(
          old.id,
          "Rule settings changed. New readings will be evaluated against the updated rule.",
        );
      persist(rule);
    },
    /** How many rules are still the untouched defaults from before alpha.41. */
    legacyDefaults(): number {
      return rules().filter(untouchedLegacy).length;
    },
    /** Replaces untouched old defaults with the current set; edited rules are left alone. */
    adoptRecommended(): void {
      const current = rules();
      for (const rule of current.filter(untouchedLegacy)) {
        closeRule(rule.id, "Replaced by the recommended rules.");
        db.prepare("DELETE FROM alert_rules WHERE id = ?").run(rule.id);
      }
      const names = new Set(rules().map((rule) => rule.name));
      for (const seed of RECOMMENDED_RULES) if (!names.has(seed[0])) persist(seeded(seed));
    },
    remove(id: string): void {
      closeRule(id, "Rule removed by an administrator.");
      db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
    },
    acknowledge(id: string): void {
      const result = db
        .prepare(
          "UPDATE alert_incidents SET acknowledgedAt = ? WHERE id = ? AND resolvedAt IS NULL",
        )
        .run(now(), id);
      if (!result.changes)
        throw new AlertError("This incident has already resolved or no longer exists.", 409);
      channels.cancelIncident(id, "Incident acknowledged before this reminder was delivered.", [
        "repeat",
      ]);
    },
    silence(id: string, seconds: unknown): void {
      const until = now() + integer(seconds, "Silence duration", 0, 7 * 86400) * 1000;
      const result = db
        .prepare("UPDATE alert_incidents SET silencedUntil = ? WHERE id = ? AND resolvedAt IS NULL")
        .run(until, id);
      if (!result.changes)
        throw new AlertError("This incident has already resolved or no longer exists.", 409);
      if (until > now() && channels.cancelIncident(id, "Incident silenced before delivery."))
        refreshNotificationTime(id);
    },
    tick(): void {
      const live = new Map(options.live().map((node) => [node.id, node]));
      const nodes = options.nodes();
      const currentRules = rules();
      const open = db
        .prepare("SELECT * FROM alert_incidents WHERE resolvedAt IS NULL")
        .all() as unknown as IncidentRow[];
      const openMap = new Map(
        open.map((incident) => [`${incident.ruleId}:${incident.targetId}`, incident]),
      );
      const valid = new Set<string>();
      for (const rule of currentRules.filter((rule) => rule.enabled))
        for (const target of targets(rule, nodes, live)) {
          const key = `${rule.id}:${target.id}`;
          valid.add(key);
          const state = pending.get(key) ?? {
            breachAt: null,
            warnAt: null,
            recoveryAt: null,
            calmAt: null,
          };
          const incident = openMap.get(key);
          pending.set(key, state);
          if (
            incident &&
            target.maintenance &&
            channels.cancelIncident(incident.id, "Node entered maintenance before delivery.")
          )
            incident.lastNotified = refreshNotificationTime(incident.id);
          if (target.value === null || !Number.isFinite(target.value)) {
            state.breachAt = null;
            state.warnAt = null;
            state.recoveryAt = null;
            state.calmAt = null;
            continue;
          }
          const value = target.value;
          // Offline has no threshold; its two levels differ only in how long it lasts.
          const breach = meets(rule.metric, value, rule.threshold);
          const warn = rule.warning ? meets(rule.metric, value, rule.warning.threshold) : false;
          if (breach) state.breachAt ??= now();
          else state.breachAt = null;
          if (warn) state.warnAt ??= now();
          else state.warnAt = null;
          const criticalHeld =
            state.breachAt !== null && now() - state.breachAt >= rule.durationSeconds * 1000;
          const warningHeld =
            rule.warning !== null &&
            state.warnAt !== null &&
            now() - state.warnAt >= rule.warning.durationSeconds * 1000;
          const level: AlertSeverity | null = criticalHeld
            ? rule.severity
            : warningHeld
              ? "warning"
              : null;
          const floor = rule.warning?.threshold ?? rule.threshold;
          const recovered =
            rule.metric === "certificate"
              ? value > floor + 1
              : rule.metric === "offline"
                ? value === 0
                : value < floor * 0.95;
          if (!incident) {
            state.recoveryAt = null;
            if (!level) continue;
            const created: IncidentRow = {
              id: randomUUID(),
              ruleId: rule.id,
              name: rule.name,
              targetId: target.id,
              targetName: target.name,
              severity: level,
              startedAt: now(),
              resolvedAt: null,
              acknowledgedAt: null,
              silencedUntil: 0,
              detail: detail(rule, target, level),
              lastNotified: 0,
            };
            db.prepare(
              "INSERT INTO alert_incidents (id,ruleId,name,targetId,targetName,severity,startedAt,detail) VALUES (?,?,?,?,?,?,?,?)",
            ).run(
              created.id,
              rule.id,
              rule.name,
              target.id,
              target.name,
              level,
              now(),
              created.detail,
            );
            notify(rule, created, target, "firing");
          } else {
            if (!incident.lastNotified)
              incident.lastNotified = refreshNotificationTime(incident.id);
            if (recovered) {
              state.recoveryAt ??= now();
              if (now() - state.recoveryAt >= 60_000) {
                channels.endIncident(incident.id);
                channels.cancelIncident(incident.id, "Incident recovered before delivery.", [
                  "firing",
                  "repeat",
                ]);
                db.prepare(
                  "UPDATE alert_incidents SET resolvedAt = ?, detail = ? WHERE id = ?",
                ).run(now(), detail(rule, target, incident.severity), incident.id);
                if (rule.recovery && incident.lastNotified)
                  notify(rule, incident, target, "resolved");
                pending.delete(key);
                continue;
              }
            } else state.recoveryAt = null;
            if (incident.severity === "warning" && level === "critical") {
              // Raise in place: one incident, one new notification at the higher level.
              incident.severity = "critical";
              incident.acknowledgedAt = null;
              state.calmAt = null;
              db.prepare(
                "UPDATE alert_incidents SET severity = 'critical', acknowledgedAt = NULL, detail = ? WHERE id = ?",
              ).run(detail(rule, target, "critical"), incident.id);
              notify(rule, incident, target, "escalated");
              continue;
            }
            if (
              rule.warning &&
              incident.severity === "critical" &&
              !recovered &&
              !meets(rule.metric, value, rule.threshold)
            ) {
              // Back under critical but still past the warning: step down quietly once stable.
              state.calmAt ??= now();
              if (now() - state.calmAt >= 60_000) {
                incident.severity = "warning";
                state.calmAt = null;
                db.prepare(
                  "UPDATE alert_incidents SET severity = 'warning', detail = ? WHERE id = ?",
                ).run(detail(rule, target, "warning"), incident.id);
              }
            } else state.calmAt = null;
            // Reminders are for the rule's top level; an early warning is said once.
            if (
              !incident.acknowledgedAt &&
              (!incident.lastNotified ||
                (rule.repeatMinutes > 0 &&
                  incident.severity === rule.severity &&
                  now() - incident.lastNotified >= rule.repeatMinutes * 60_000))
            )
              notify(rule, incident, target, incident.lastNotified ? "repeat" : "firing");
          }
        }
      for (const incident of open)
        if (!valid.has(`${incident.ruleId}:${incident.targetId}`)) {
          channels.endIncident(incident.id);
          channels.cancelIncident(incident.id, "Monitoring ended before delivery.");
          db.prepare(
            "UPDATE alert_incidents SET resolvedAt = ?, detail = 'Monitoring ended: the rule or target was disabled, removed, or replaced.' WHERE id = ?",
          ).run(now(), incident.id);
        }
      for (const key of pending.keys()) if (!valid.has(key)) pending.delete(key);
      if (now() - prunedAt > 3_600_000) {
        db.prepare(
          "DELETE FROM alert_incidents WHERE resolvedAt IS NOT NULL AND resolvedAt < ?",
        ).run(now() - 90 * 86_400_000);
        prunedAt = now();
      }
    },
  };
}
