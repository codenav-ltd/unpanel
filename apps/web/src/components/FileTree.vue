<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { CaretRightOutlined, FolderOutlined } from "@ant-design/icons-vue";
import { en } from "../i18n/en.ts";
import {
  baseName,
  crumbs,
  isFolder,
  joinPath,
  type FileEntry,
  type FilesClient,
} from "../files-client.ts";

const props = defineProps<{
  client: FilesClient;
  /** The folder shown in the listing; its ancestors open automatically. */
  current: string;
  /** Where the tree starts: `/`, or the folders this node is limited to. */
  roots: string[];
  /** The folder the listing is loading; its children arrive with the listing. */
  pending: string;
  /** Without a listing beside it (a folder picker), the tree loads the current folder itself. */
  standalone?: boolean;
}>();
const emit = defineEmits<{ navigate: [path: string] }>();

interface Branch {
  children: string[] | null;
  loading: boolean;
}

const branches = reactive(new Map<string, Branch>());
const expanded = reactive(new Set<string>());
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function branch(path: string): Branch {
  if (!branches.has(path)) branches.set(path, { children: null, loading: false });
  // The reactive map hands out proxies; changing those is what re-renders the tree.
  return branches.get(path) as Branch;
}

function folders(path: string, entries: FileEntry[]): string[] {
  return entries
    .filter(isFolder)
    .map((entry) => entry.name)
    .sort(collator.compare)
    .map((name) => joinPath(path, name));
}

async function load(path: string, force = false): Promise<void> {
  const node = branch(path);
  if (node.loading || (node.children && !force)) return;
  node.loading = true;
  try {
    const listing = await props.client.list(path);
    node.children = folders(path, listing.entries);
  } catch {
    // A folder the tree cannot read simply shows no children; the listing explains why.
    node.children = [];
  } finally {
    node.loading = false;
  }
}

function toggle(path: string): void {
  if (expanded.has(path)) expanded.delete(path);
  else {
    expanded.add(path);
    void load(path);
  }
}

/** The tree rendered as rows, depth first through the open folders. */
const rows = computed(() => {
  const out: { path: string; name: string; depth: number }[] = [];
  const visit = (path: string, depth: number, name: string): void => {
    out.push({ path, name, depth });
    if (!expanded.has(path)) return;
    for (const child of branches.get(path)?.children ?? [])
      visit(child, depth + 1, baseName(child));
  };
  for (const root of props.roots) visit(root, 0, root);
  return out;
});

watch(
  () => [props.current, props.roots] as const,
  ([current, roots]) => {
    // Open every ancestor of the current folder that lies inside a root.
    const root = roots.find(
      (item) => item === "/" || current === item || current.startsWith(`${item}/`),
    );
    if (!root) return;
    for (const crumb of crumbs(current)) {
      if (crumb.path.length < root.length) continue;
      expanded.add(crumb.path);
      // The current folder's children come from the listing through `show`.
      if (crumb.path !== current || props.standalone) void load(crumb.path);
    }
  },
  { immediate: true },
);

const root = ref<HTMLElement | null>(null);

// The current folder stays in view as the tree opens around it.
watch(
  () => [props.current, rows.value.length] as const,
  () =>
    void nextTick(() =>
      root.value?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "nearest" }),
    ),
);

/** Takes the listing the page loaded, so the tree never lists the same folder twice. */
function show(path: string, entries: FileEntry[]): void {
  branch(path).children = folders(path, entries);
}
defineExpose({ show });
</script>

<template>
  <nav ref="root" class="file-tree" :aria-label="en.files.folders">
    <ul>
      <li v-for="row in rows" :key="row.path" :style="{ '--depth': row.depth }">
        <button
          type="button"
          class="file-tree-toggle"
          :aria-label="`${expanded.has(row.path) ? 'Collapse' : 'Expand'} ${row.name}`"
          :aria-expanded="expanded.has(row.path)"
          :data-empty="branches.get(row.path)?.children?.length === 0"
          @click="toggle(row.path)"
        >
          <span
            v-if="branches.get(row.path)?.loading || row.path === pending"
            class="spinner"
            aria-hidden="true"
          />
          <CaretRightOutlined v-else aria-hidden="true" />
        </button>
        <button
          type="button"
          class="file-tree-name"
          :aria-current="row.path === current ? 'location' : undefined"
          :aria-busy="row.path === pending || undefined"
          :title="row.path"
          @click="emit('navigate', row.path)"
        >
          <FolderOutlined aria-hidden="true" /><span>{{ row.name }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.file-tree ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.file-tree li {
  display: flex;
  align-items: center;
  padding-inline-start: calc(var(--depth) * 14px);
}
.file-tree button {
  min-height: 28px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-weight: 400;
}
.file-tree button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.file-tree-toggle {
  flex: none;
  width: 22px;
  padding: 0;
  font-size: 10px;
}
.file-tree-toggle :deep(svg) {
  transition: transform var(--dur-fast) var(--ease-out);
}
.file-tree-toggle[aria-expanded="true"] :deep(svg) {
  transform: rotate(90deg);
}
.file-tree-toggle[data-empty="true"] {
  visibility: hidden;
}
.file-tree-toggle .spinner {
  width: 10px;
  height: 10px;
}
.file-tree-name {
  flex: 1;
  min-width: 0;
  justify-content: flex-start;
  gap: 6px;
  padding: 0 6px;
  font-size: 13px;
}
.file-tree-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-tree-name :deep(.anticon) {
  flex: none;
  color: var(--text-3);
}
.file-tree-name[aria-current="location"] {
  background: var(--bg-hover);
  color: var(--text);
  font-weight: 500;
}
.file-tree-name[aria-current="location"] :deep(svg) {
  color: var(--primary);
}
</style>
