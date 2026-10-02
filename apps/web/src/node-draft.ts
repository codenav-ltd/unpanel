// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { ref, watch } from "vue";

interface NodeIdentity {
  nodeId: string;
  name: string;
  tags: string[];
  maintenance: boolean;
}

/** Live snapshots can update clean fields without replacing a user's draft. */
export function useNodeDraft(source: NodeIdentity) {
  const name = ref(source.name);
  const tagText = ref(source.tags.join(", "));
  const maintenance = ref(source.maintenance);

  watch(
    () => [source.nodeId, source.name, source.tags.join(", "), source.maintenance] as const,
    (
      [id, nextName, nextTags, nextMaintenance],
      [previousId, previousName, previousTags, previousMaintenance],
    ) => {
      const changedNode = id !== previousId;
      if (changedNode || name.value === previousName) name.value = nextName;
      if (changedNode || tagText.value === previousTags) tagText.value = nextTags;
      if (changedNode || maintenance.value === previousMaintenance)
        maintenance.value = nextMaintenance;
    },
  );

  function acceptSaved(saved: Omit<NodeIdentity, "nodeId">): void {
    name.value = saved.name;
    tagText.value = saved.tags.join(", ");
    maintenance.value = saved.maintenance;
  }

  return { name, tagText, maintenance, acceptSaved };
}
