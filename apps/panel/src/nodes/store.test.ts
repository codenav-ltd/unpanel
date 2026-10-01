// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { createNodes, NodesError } from "./store.ts";

describe("node catalog", () => {
  it("keeps the local node first and enrolls a pending node once", () => {
    const now = 1_700_000_000_000;
    const nodes = createNodes(openDatabase(":memory:"), () => now);
    nodes.ensureLocal({ agentPk: "local-key", name: "", tags: [], maintenance: false });
    const created = nodes.create({ name: "edge-1", tags: ["prod", "prod"], createdBy: "ada" });
    expect(created.node.status).toBe("pending");
    expect(created.token.startsWith("pe_")).toBe(true);
    expect(nodes.list().map((node) => node.id)[0]).toBe("local");

    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" });
    const pemText = typeof pem === "string" ? pem : pem.toString();
    const enrolled = nodes.enroll(created.token, pemText);
    expect(enrolled).toEqual({ id: created.node.id });
    expect(nodes.get(created.node.id)?.status).toBe("active");
    expect(nodes.publicKey(created.node.id)?.asymmetricKeyType).toBe("ed25519");
    expect(nodes.enroll(created.token, pemText)).toBeNull();
  });

  it("rejects an expired token and a duplicate name", () => {
    let now = 1_700_000_000_000;
    const nodes = createNodes(openDatabase(":memory:"), () => now);
    const created = nodes.create({ name: "edge-1", tags: [], createdBy: "ada" });
    now += 60 * 60 * 1000 + 1;
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" });
    expect(nodes.enroll(created.token, typeof pem === "string" ? pem : pem.toString())).toBeNull();
    expect(() => nodes.create({ name: "edge-1", tags: [], createdBy: "ada" })).toThrow(NodesError);
    expect(() => nodes.create({ name: "", tags: [], createdBy: "ada" })).toThrow(NodesError);
  });

  it("disables, re-enrolls, and remembers a removed id", () => {
    const nodes = createNodes(openDatabase(":memory:"));
    nodes.ensureLocal({ agentPk: "local-key", name: "", tags: [], maintenance: false });
    const created = nodes.create({ name: "edge-1", tags: [], createdBy: "ada" });
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" });
    const pemText = typeof pem === "string" ? pem : pem.toString();
    nodes.enroll(created.token, pemText);
    expect(nodes.disable(created.node.id).status).toBe("disabled");
    expect(nodes.enable(created.node.id).status).toBe("active");
    const again = nodes.reenroll(created.node.id, "ada");
    expect(again.node.status).toBe("pending");
    expect(again.node.hasKey).toBe(false);
    expect(nodes.enroll(created.token, pemText)).toBeNull();
    expect(nodes.enroll(again.token, pemText)?.id).toBe(created.node.id);
    nodes.remove(created.node.id);
    expect(nodes.get(created.node.id)).toBeNull();
    expect(nodes.state(created.node.id)).toBe("disabled");
    expect(() => nodes.remove("local")).toThrow(/local/);
    expect(() => nodes.reenroll("local", "ada")).toThrow(/local/);
  });
});
