// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { effectScope, nextTick, reactive } from "vue";
import { describe, expect, it } from "vitest";
import { useNodeDraft } from "./node-draft.ts";

describe("node identity drafts", () => {
  it("preserves edits when polling returns an equivalent tags array", async () => {
    const scope = effectScope();
    const source = reactive({ nodeId: "a", name: "Node A", tags: ["prod"], maintenance: false });
    const draft = scope.run(() => useNodeDraft(source));
    if (!draft) throw new Error("The draft scope did not start");
    draft.name.value = "My name";
    draft.tagText.value = "My tags";
    draft.maintenance.value = true;
    source.tags = ["prod"];
    await nextTick();
    expect([draft.name.value, draft.tagText.value, draft.maintenance.value]).toEqual([
      "My name",
      "My tags",
      true,
    ]);
    scope.stop();
  });

  it("updates clean fields while preserving a dirty field", async () => {
    const scope = effectScope();
    const source = reactive({ nodeId: "a", name: "Node A", tags: ["prod"], maintenance: false });
    const draft = scope.run(() => useNodeDraft(source));
    if (!draft) throw new Error("The draft scope did not start");
    draft.name.value = "Unsaved name";
    Object.assign(source, { name: "Remote name", tags: ["test"], maintenance: true });
    await nextTick();
    expect([draft.name.value, draft.tagText.value, draft.maintenance.value]).toEqual([
      "Unsaved name",
      "test",
      true,
    ]);
    scope.stop();
  });

  it("resets drafts when a different node is selected", async () => {
    const scope = effectScope();
    const source = reactive({ nodeId: "a", name: "Node A", tags: ["prod"], maintenance: false });
    const draft = scope.run(() => useNodeDraft(source));
    if (!draft) throw new Error("The draft scope did not start");
    draft.name.value = "Unsaved name";
    draft.tagText.value = "Unsaved tags";
    draft.maintenance.value = true;
    Object.assign(source, { nodeId: "b", name: "Node B", tags: ["test"], maintenance: false });
    await nextTick();
    expect([draft.name.value, draft.tagText.value, draft.maintenance.value]).toEqual([
      "Node B",
      "test",
      false,
    ]);
    scope.stop();
  });

  it("accepts normalized saved values and follows later clean updates", async () => {
    const scope = effectScope();
    const source = reactive({ nodeId: "a", name: "Node A", tags: ["prod"], maintenance: false });
    const draft = scope.run(() => useNodeDraft(source));
    if (!draft) throw new Error("The draft scope did not start");
    draft.tagText.value = " test, prod ";
    const saved = { name: "Node A", tags: ["prod", "test"], maintenance: false };
    draft.acceptSaved(saved);
    Object.assign(source, saved);
    await nextTick();
    expect(draft.tagText.value).toBe("prod, test");
    source.tags = ["latest"];
    await nextTick();
    expect(draft.tagText.value).toBe("latest");
    scope.stop();
  });
});
