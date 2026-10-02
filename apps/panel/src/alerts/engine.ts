// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AlertIncident, AlertMetric, AlertRule } from "@unpanel/shared";
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
  breachAt: number | null;
  recoveryAt: number | null;
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
    ).map((row) => JSON.parse(row.config) as AlertRule);
  }
  function persist(rule: AlertRule): void {
    db.prepare(
      "INSERT INTO alert_rules VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config=excluded.config",
    ).run(rule.id, JSON.stringify(rule));
  }
  if (!db.prepare("SELECT 1 FROM alert_meta WHERE key = 'seeded'").get()) {
    const defaults: [string, AlertMetric, number, number, "warning" | "critical"][] = [
      ["Node offline", "offline", 1, 120, "critical"],
      ["Disk almost full", "disk", 90, 300, "warning"],
      ["Disk critically full", "disk", 97, 60, "critical"],
      ["Memory pressure", "memory", 95, 300, "warning"],
      ["Sustained CPU load", "cpu", 95, 600, "warning"],
      ["Panel certificate expires soon", "certificate", 14, 0, "warning"],
      ["Panel certificate needs renewal", "certificate", 3, 0, "critical"],
    ];
    for (const [name, metric, threshold, durationSeconds, level] of defaults)
      persist({
        id: randomUUID(),
        name,
        metric,
        threshold,
        durationSeconds,
        severity: level,
        enabled: true,
        nodeIds: [],
        channelIds: [],
        recovery: true,
        repeatMinutes: level === "critical" ? 60 : 0,
      });
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
  function detail(rule: AlertRule, target: Target): string {
    if (rule.metric === "offline")
      return target.value === 1
        ? "The node is not connected to the panel."
        : "The node is connected again.";
    if (rule.metric === "certificate")
      return `The active panel certificate has ${Math.max(0, Math.ceil(target.value ?? 0))} days remaining.`;
    return `${rule.metric[0]?.toUpperCase()}${rule.metric.slice(1)} usage is ${(target.value ?? 0).toFixed(1)}% (threshold ${rule.threshold}%).`;
  }
  function notify(
    rule: AlertRule,
    incident: IncidentRow,
    target: Target,
    kind: "firing" | "resolved" | "repeat",
  ): void {
    if (target.maintenance || incident.silencedUntil > now()) return;
    const title = `Unpanel · ${kind === "resolved" ? "Resolved" : rule.severity === "critical" ? "Critical" : "Warning"}: ${rule.name}`;
    const address = options.publicUrl();
    const queued = channels.notify(
      {
        title,
        text: `${target.name}\n${detail(rule, target)}\n${new Date(now()).toISOString()}${address ? `\n\n${address}/alerts` : ""}`,
        key: incident.id,
        source: { ruleId: rule.id, incidentId: incident.id, event: kind },
      },
      rule.severity,
      rule.channelIds,
    );
    if (queued)
      db.prepare("UPDATE alert_incidents SET lastNotified = ? WHERE id = ?").run(
        now(),
        incident.id,
      );
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
      };
      if (rule.repeatMinutes > 0 && rule.repeatMinutes < 5)
        throw new AlertError("Use at least 5 minutes between reminders, or 0 to turn them off.");
      if (old)
        closeRule(
          old.id,
          "Rule settings changed. New readings will be evaluated against the updated rule.",
        );
      persist(rule);
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
          const state = pending.get(key) ?? { breachAt: null, recoveryAt: null };
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
            state.recoveryAt = null;
            continue;
          }
          const breach =
            rule.metric === "certificate"
              ? target.value <= rule.threshold
              : target.value >= rule.threshold;
          const recovered =
            rule.metric === "certificate"
              ? target.value > rule.threshold + 1
              : rule.metric === "offline"
                ? target.value === 0
                : target.value < rule.threshold * 0.95;
          if (!incident) {
            state.recoveryAt = null;
            if (!breach) {
              state.breachAt = null;
              continue;
            }
            state.breachAt ??= now();
            if (now() - state.breachAt < rule.durationSeconds * 1000) continue;
            const created: IncidentRow = {
              id: randomUUID(),
              ruleId: rule.id,
              name: rule.name,
              targetId: target.id,
              targetName: target.name,
              severity: rule.severity,
              startedAt: now(),
              resolvedAt: null,
              acknowledgedAt: null,
              silencedUntil: 0,
              detail: detail(rule, target),
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
              rule.severity,
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
                ).run(now(), detail(rule, target), incident.id);
                if (rule.recovery && incident.lastNotified)
                  notify(rule, incident, target, "resolved");
                pending.delete(key);
                continue;
              }
            } else state.recoveryAt = null;
            if (
              !incident.acknowledgedAt &&
              (!incident.lastNotified ||
                (rule.repeatMinutes > 0 &&
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
