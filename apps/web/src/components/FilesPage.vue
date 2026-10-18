<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 CodeNav Ltd and contributors
-->
<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  ArrowUpOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderFilled,
  FolderOpenOutlined,
  LinkOutlined,
  ReloadOutlined,
  ScissorOutlined,
  SearchOutlined,
  SnippetsOutlined,
} from "@ant-design/icons-vue";
import ActionMenu from "./ActionMenu.vue";
import AppDialog from "./AppDialog.vue";
import FileArchiveDialog from "./FileArchiveDialog.vue";
import FileTransferDialog from "./FileTransferDialog.vue";
import FileTree from "./FileTree.vue";
import ReauthenticateDialog from "./ReauthenticateDialog.vue";
import { copyText } from "../copy.ts";
import {
  baseName,
  crumbs,
  filesClient,
  FilesRequestError,
  isArchive,
  isFolder,
  joinPath,
  modeString,
  normalizePath,
  octal,
  parentOf,
  sortEntries,
  validName,
  type FileEntry,
  type Listing,
  type SortKey,
} from "../files-client.ts";
import {
  commandKey,
  deleteShortcut,
  emptySelection,
  fileClipboard,
  pastePlan,
  select,
  shortcut,
  type Selection,
} from "../files-selection.ts";
import { formatBytes } from "../format.ts";
import { en } from "../i18n/en.ts";
import { needsStepUp, useStepUp } from "../step-up.ts";
import type { ThemeName } from "../theme/tokens.ts";

const props = defineProps<{
  nodeId: string;
  online: boolean;
  /** Null when the agent offers no file manager; empty when the whole filesystem is open. */
  roots: string[] | null;
  canManage: boolean;
  theme: ThemeName;
}>();
const FileEditor = defineAsyncComponent(() => import("./FileEditor.vue"));

const client = filesClient(props.nodeId);
const { open: verifying, intercept, verified, cancel: cancelVerify } = useStepUp();

const available = computed(() => props.canManage && props.online && props.roots !== null);
const treeRoots = computed(() => (props.roots?.length ? props.roots : ["/"]));
const places = computed(() =>
  props.roots?.length
    ? props.roots
    : ["/", "/etc/nginx", "/var/log", "/srv", "/opt", "/home", "/var/lib/docker/volumes"],
);
const placesFound = ref<string[]>([]);

const path = ref("");
const listing = ref<Listing | null>(null);
const loading = ref(false);
const failure = ref("");
const sortKey = ref<SortKey>("name");
const descending = ref(false);
const status = ref("");
const tree = ref<InstanceType<typeof FileTree> | null>(null);
let request = 0;

const HIDDEN_KEY = "unpanel.files.hidden";
function savedHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) !== "0";
  } catch {
    return true;
  }
}
/** Dotfiles are shown by default: on a server, .env and .ssh are what people look for. */
const showHidden = ref(savedHidden());
const filter = ref("");
const filterField = ref<HTMLInputElement | null>(null);

const sorted = computed(() =>
  listing.value ? sortEntries(listing.value.entries, sortKey.value, descending.value) : [],
);
/** The rows shown: sorted, without dotfiles when hidden, narrowed by the filter. */
const entries = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return sorted.value.filter(
    (entry) =>
      (showHidden.value || !entry.name.startsWith(".")) &&
      (!needle || entry.name.toLowerCase().includes(needle)),
  );
});
const order = computed(() => entries.value.map((entry) => entry.name));
const hiddenRows = computed(() => sorted.value.length - entries.value.length);

function toggleHidden(): void {
  showHidden.value = !showHidden.value;
  try {
    localStorage.setItem(HIDDEN_KEY, showHidden.value ? "1" : "0");
  } catch {
    // The choice still applies until the page reloads.
  }
}

/* Selection: checkboxes, Ctrl/⌘ and Shift clicks, and the keyboard. */
const selection = ref<Selection>(emptySelection);
/** The row the keyboard is on. */
const cursor = ref<string | null>(null);
const tableWrap = ref<HTMLElement | null>(null);
const selected = computed(() =>
  entries.value.filter((entry) => selection.value.names.has(entry.name)),
);
const allSelected = computed(
  () => entries.value.length > 0 && selected.value.length === entries.value.length,
);

function clearSelection(): void {
  selection.value = emptySelection;
}

function selectAll(): void {
  selection.value = { names: new Set(order.value), anchor: order.value[0] ?? null };
}

function pick(entry: FileEntry, event: MouseEvent | KeyboardEvent | null): void {
  const mode = event?.shiftKey
    ? event && commandKey(event)
      ? "extend"
      : "range"
    : event && commandKey(event)
      ? "toggle"
      : "replace";
  selection.value = select(selection.value, order.value, entry.name, mode);
  cursor.value = entry.name;
}

function onRowClick(entry: FileEntry, event: MouseEvent): void {
  pick(entry, event);
  tableWrap.value?.focus({ preventScroll: true });
}

/** A name opens its file or folder; with Ctrl/⌘ or Shift it selects instead. */
function onNameClick(entry: FileEntry, event: MouseEvent): void {
  if (event.shiftKey || commandKey(event)) {
    onRowClick(entry, event);
    return;
  }
  cursor.value = entry.name;
  openEntry(entry);
}

function onCheck(entry: FileEntry, event: MouseEvent): void {
  selection.value = select(
    selection.value,
    order.value,
    entry.name,
    event.shiftKey ? "extend" : "toggle",
  );
  cursor.value = entry.name;
}

function onRowMenu(entry: FileEntry, event: MouseEvent): void {
  // Right-click on a row outside the selection works on that row alone, as in a desktop.
  if (!selection.value.names.has(entry.name)) pick(entry, null);
  cursor.value = entry.name;
  menus.get(entry.name)?.openAt(event.clientX, event.clientY);
}

watch(path, () => {
  selection.value = emptySelection;
  cursor.value = null;
  filter.value = "";
});

// A reload keeps what is still there selected.
watch(sorted, (now) => {
  const names = new Set(now.map((entry) => entry.name));
  const kept = [...selection.value.names].filter((name) => names.has(name));
  if (kept.length !== selection.value.names.size)
    selection.value = { names: new Set(kept), anchor: selection.value.anchor };
  if (cursor.value && !names.has(cursor.value)) cursor.value = null;
});

function moveCursor(index: number, event: KeyboardEvent): void {
  const name = order.value[Math.max(0, Math.min(index, order.value.length - 1))];
  if (name === undefined) return;
  cursor.value = name;
  selection.value = select(
    selection.value,
    order.value,
    name,
    event.shiftKey ? "range" : "replace",
  );
  void nextTick(() =>
    tableWrap.value?.querySelector('tr[data-cursor="true"]')?.scrollIntoView({ block: "nearest" }),
  );
}

const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Keys of the listing. See modules/terminal-files.md §2.6. */
function onListKey(event: KeyboardEvent): void {
  if (editing.value || editable(event.target)) return;
  const command = commandKey(event);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const index = cursor.value === null ? -1 : order.value.indexOf(cursor.value);
  const current = index >= 0 ? entries.value[index] : undefined;
  const handled = (): void => event.preventDefault();
  if (key === "ArrowDown" && !command) {
    handled();
    moveCursor(index + 1, event);
  } else if (key === "ArrowUp" && (command || event.altKey)) {
    handled();
    if (!upDisabled.value) void go(parentOf(path.value));
  } else if (key === "ArrowUp") {
    handled();
    moveCursor(index < 0 ? order.value.length - 1 : index - 1, event);
  } else if (key === "Home" || key === "End") {
    handled();
    moveCursor(key === "Home" ? 0 : order.value.length - 1, event);
  } else if (key === "Enter" && current) {
    handled();
    openEntry(current);
  } else if (key === " " && current) {
    handled();
    pick(current, { ...event, metaKey: true, ctrlKey: true, shiftKey: false } as KeyboardEvent);
  } else if (key === "Escape" && selection.value.names.size) {
    handled();
    clearSelection();
  } else if (command && key === "a") {
    handled();
    selectAll();
  } else if (command && (key === "c" || key === "x") && selected.value.length) {
    handled();
    putAside(key === "x" ? "cut" : "copy");
  } else if (command && key === "v" && clip.value) {
    handled();
    void paste();
  } else if (command && key === "d" && selected.value.length) {
    handled();
    void duplicate(selected.value);
  } else if (key === "F2" && selected.value.length === 1 && selected.value[0]) {
    handled();
    openName("rename", selected.value[0]);
  } else if ((key === "Delete" || (command && key === "Backspace")) && selected.value.length) {
    handled();
    openDelete(selected.value);
  } else if (key === "Backspace" && !command) {
    handled();
    if (!upDisabled.value) void go(parentOf(path.value));
  } else if (key === "/" && !command) {
    handled();
    filterField.value?.focus();
  }
}

function onFilterKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    filter.value = "";
    tableWrap.value?.focus();
  } else if (event.key === "ArrowDown" || event.key === "Enter") {
    event.preventDefault();
    tableWrap.value?.focus();
    if (order.value.length) moveCursor(0, event);
  }
}
const trail = computed(() => crumbs(path.value || "/"));
const upDisabled = computed(() => path.value === "/" || treeRoots.value.includes(path.value));

const editingPath = ref(false);
const pathInput = ref("");
const pathError = ref("");
const pathField = ref<HTMLInputElement | null>(null);
const crumbBar = ref<HTMLElement | null>(null);

// A deep path keeps its last folder in view.
watch(
  path,
  () => void nextTick(() => crumbBar.value?.scrollTo({ left: crumbBar.value.scrollWidth })),
);

/** Reads `?path=` so a folder can be linked to and Back returns to the previous one. */
function pathFromUrl(): string | null {
  const value = new URLSearchParams(globalThis.location.search).get("path");
  return value ? normalizePath(value) : null;
}

/** The file open in the editor, which takes the listing's place. */
const editing = ref<{ path: string; size: number } | null>(null);
const editor = ref<{ dirty: boolean; requestClose: () => void } | null>(null);

async function go(next: string, push = true): Promise<void> {
  // Unsaved edits are confirmed before the editor gives way to a listing.
  if (editing.value && editor.value?.dirty) {
    editor.value.requestClose();
    return;
  }
  editing.value = null;
  editingPath.value = false;
  pathError.value = "";
  if (push && next !== path.value) {
    const url = new URL(globalThis.location.href);
    url.searchParams.set("path", next);
    globalThis.history.pushState(null, "", `${url.pathname}${url.search}`);
  }
  path.value = next;
  await load();
}

async function load(): Promise<void> {
  const ticket = ++request;
  loading.value = true;
  failure.value = "";
  try {
    const result = await client.list(path.value);
    if (ticket !== request) return;
    listing.value = result;
    tree.value?.show(result.path, result.entries);
    // A link or `..` resolves to the real folder; show where we actually are.
    if (result.path !== path.value) {
      path.value = result.path;
      const url = new URL(globalThis.location.href);
      url.searchParams.set("path", result.path);
      globalThis.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  } catch (error) {
    if (ticket !== request) return;
    listing.value = null;
    failure.value = error instanceof Error ? error.message : en.files.unavailable;
  } finally {
    if (ticket === request) loading.value = false;
  }
}

function onPop(): void {
  if (!globalThis.location.pathname.endsWith("/files")) return;
  void go(pathFromUrl() ?? treeRoots.value[0] ?? "/", false);
}

function sortBy(key: SortKey): void {
  if (sortKey.value === key) descending.value = !descending.value;
  else {
    sortKey.value = key;
    descending.value = key !== "name";
  }
}

function sortState(key: SortKey): "ascending" | "descending" | "none" {
  if (sortKey.value !== key) return "none";
  return descending.value ? "descending" : "ascending";
}

function startPathEdit(): void {
  pathInput.value = path.value;
  pathError.value = "";
  editingPath.value = true;
  void nextTick(() => pathField.value?.select());
}

function submitPath(): void {
  const next = normalizePath(pathInput.value);
  if (!next) {
    pathError.value = en.files.pathInvalid;
    return;
  }
  void go(next);
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const modified = (entry: FileEntry): string => dateFormat.format(entry.mtime);
const fullPath = (entry: FileEntry): string =>
  joinPath(listing.value?.path ?? path.value, entry.name);

function linkTitle(entry: FileEntry): string | undefined {
  if (entry.type !== "link" || entry.target === undefined) return undefined;
  return (entry.targetType ? en.files.linkTo : en.files.brokenLink).replace(
    "{target}",
    entry.target,
  );
}

function openEntry(entry: FileEntry): void {
  if (isFolder(entry)) void go(fullPath(entry));
  else if (entry.type === "file" || entry.targetType === "file")
    // A link's own size is its target's name; the editor checks the real file.
    editing.value = { path: fullPath(entry), size: entry.type === "file" ? entry.size : 0 };
}

function rowActions(entry: FileEntry) {
  if (selected.value.length > 1 && selection.value.names.has(entry.name))
    return [
      { id: "cut", label: en.files.cut, shortcut: shortcut("mod+x") },
      { id: "copyItems", label: en.files.copy, shortcut: shortcut("mod+c") },
      { id: "duplicate", label: en.files.duplicate, shortcut: shortcut("mod+d") },
      { id: "copyTo", label: en.files.copyTo, separator: true },
      { id: "moveTo", label: en.files.moveTo },
      { id: "compress", label: en.files.compressMenu },
      {
        id: "delete",
        label: en.files.delete,
        danger: true,
        separator: true,
        shortcut: deleteShortcut(),
      },
    ];
  const folder = isFolder(entry);
  const archive = isArchive(entry);
  return [
    { id: "open", label: en.files.open, shortcut: "Enter" },
    { id: "download", label: folder ? en.files.downloadFolder : en.files.download },
    ...(archive
      ? [
          { id: "extractHere", label: en.files.extractHere, separator: true },
          { id: "extractTo", label: en.files.extractTo },
        ]
      : []),
    { id: "rename", label: en.files.rename, separator: true, shortcut: "F2" },
    { id: "duplicate", label: en.files.duplicate, shortcut: shortcut("mod+d") },
    { id: "copyTo", label: en.files.copyTo },
    { id: "moveTo", label: en.files.moveTo },
    { id: "compress", label: en.files.compressMenu },
    { id: "cut", label: en.files.cut, separator: true, shortcut: shortcut("mod+x") },
    { id: "copyItems", label: en.files.copy, shortcut: shortcut("mod+c") },
    { id: "copy", label: en.files.copyPath },
    { id: "permissions", label: en.files.permissions, separator: true },
    { id: "delete", label: en.files.delete, danger: true, shortcut: deleteShortcut() },
  ].filter((action) => action.id !== "open" || folder || entry.type !== "other");
}

/** What a row action applies to: the selection when the row is part of it, otherwise the row. */
function targets(entry: FileEntry): FileEntry[] {
  return selection.value.names.has(entry.name) && selected.value.length > 1
    ? selected.value
    : [entry];
}

const menus = new Map<string, InstanceType<typeof ActionMenu>>();
function setMenu(name: string, menu: unknown): void {
  if (menu) menus.set(name, menu as InstanceType<typeof ActionMenu>);
  else menus.delete(name);
}

function rowAction(entry: FileEntry, action: string): void {
  const items = targets(entry);
  if (action === "open") openEntry(entry);
  else if (action === "download") void download(entry);
  else if (action === "rename") openName("rename", entry);
  else if (action === "duplicate") void duplicate(items);
  else if (action === "copyTo" || action === "moveTo") openTransfer(action, items);
  else if (action === "compress") compressing.value = items.map(fullPath);
  else if (action === "extractHere") void extractHere(entry);
  else if (action === "extractTo") transfer.value = { mode: "extract", sources: [fullPath(entry)] };
  else if (action === "cut" || action === "copyItems") {
    selection.value = select(emptySelection, order.value, entry.name, "replace");
    if (items.length > 1)
      selection.value = { names: new Set(items.map((item) => item.name)), anchor: entry.name };
    putAside(action === "cut" ? "cut" : "copy");
  } else if (action === "copy") void copyPath(entry);
  else if (action === "permissions") openPermissions(entry);
  else if (action === "delete") openDelete(items);
}

function openTransfer(action: "copyTo" | "moveTo", items: FileEntry[]): void {
  if (items.length)
    transfer.value = { mode: action === "copyTo" ? "copy" : "move", sources: items.map(fullPath) };
}

/* The blank area's menu */
const backgroundMenu = ref<InstanceType<typeof ActionMenu> | null>(null);
const backgroundActions = computed(() => [
  { id: "newFile", label: en.files.newFile },
  { id: "newFolder", label: en.files.newFolder },
  { id: "upload", label: en.files.uploadFiles },
  ...(clip.value
    ? [
        {
          id: "paste",
          label: en.files.pasteCount.replace("{count}", String(clip.value.paths.length)),
          separator: true,
          shortcut: shortcut("mod+v"),
        },
      ]
    : []),
  ...(entries.value.length
    ? [
        {
          id: "selectAll",
          label: en.files.selectAll,
          separator: !clip.value,
          shortcut: shortcut("mod+a"),
        },
      ]
    : []),
  {
    id: "toggleHidden",
    label: showHidden.value ? en.files.hideHidden : en.files.showHidden,
    separator: true,
  },
  { id: "copyFolderPath", label: en.files.copyFolderPath },
  { id: "refresh", label: en.files.refresh },
]);

function onBackgroundMenu(event: MouseEvent): void {
  if ((event.target as HTMLElement).closest("tbody tr, button, input")) return;
  event.preventDefault();
  backgroundMenu.value?.openAt(event.clientX, event.clientY);
}

function backgroundAction(action: string): void {
  if (action === "newFile") openName("file");
  else if (action === "newFolder") openName("folder");
  else if (action === "upload") picker.value?.click();
  else if (action === "paste") void paste();
  else if (action === "selectAll") selectAll();
  else if (action === "toggleHidden") toggleHidden();
  else if (action === "copyFolderPath")
    void copyText(path.value).then(() => (status.value = en.files.copied));
  else if (action === "refresh") void load();
}

/* Cut, copy and paste */
const clip = computed(() =>
  fileClipboard.value?.node === props.nodeId ? fileClipboard.value : null,
);
const clipNames = computed(() => {
  const paths = clip.value?.paths ?? [];
  return paths.length === 1
    ? baseName(paths[0] ?? "")
    : en.files.itemCount.replace("{count}", String(paths.length));
});

function putAside(mode: "copy" | "cut"): void {
  const items = selected.value;
  if (!items.length) return;
  fileClipboard.value = {
    node: props.nodeId,
    mode,
    paths: items.map(fullPath),
    folders: items.filter((item) => item.type === "dir").map(fullPath),
  };
  status.value = (mode === "cut" ? en.files.cutDone : en.files.copyDone).replace(
    "{name}",
    clipNames.value,
  );
}

/** Progress of a multi-item change, shown in the selection bar. */
const working = ref<{ label: string; done: number; total: number } | null>(null);

/**
 * Runs one change per item, one at a time, asking for identity once if needed. Failures are
 * collected and shown together; returns the paths that were produced.
 */
async function batch(
  label: string,
  steps: { name: string; result: string; work: () => Promise<unknown> }[],
): Promise<string[]> {
  if (!steps.length) return [];
  working.value = { label, done: 0, total: steps.length };
  const produced: string[] = [];
  const failed: string[] = [];
  failure.value = "";
  for (const step of steps) {
    try {
      const result = await withStepUp(step.work);
      if (result === null) break;
      produced.push(step.result);
    } catch (error) {
      failed.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    working.value.done += 1;
  }
  working.value = null;
  if (failed.length)
    failure.value = [
      en.files.batchFailed
        .replace("{failed}", String(failed.length))
        .replace("{total}", String(steps.length)),
      ...failed,
    ].join("\n");
  return produced;
}

/** Selects what a change produced in this folder and brings it into view. */
async function reveal(paths: string[]): Promise<void> {
  await load();
  const names = paths.filter((item) => parentOf(item) === path.value).map(baseName);
  if (!names.length) return;
  selection.value = { names: new Set(names), anchor: names[0] ?? null };
  cursor.value = names[0] ?? null;
  for (const name of names) flash(name);
}

async function paste(): Promise<void> {
  const current = clip.value;
  if (!current || working.value) return;
  const folder = path.value;
  const plan = pastePlan(current, folder, listing.value?.entries.map((entry) => entry.name) ?? []);
  const cut = current.mode === "cut";
  const produced = await batch(
    cut ? en.files.moving : en.files.copying,
    plan.map((step) => ({
      name: baseName(step.from),
      result: step.to,
      work: () => (cut ? client.rename(step.from, step.to) : client.copy(step.from, step.to)),
    })),
  );
  // What was cut is gone from where it was; pasting it again would find nothing.
  if (cut && produced.length) fileClipboard.value = null;
  if (produced.length || !plan.length)
    status.value = en.files.pasted.replace("{count}", String(produced.length));
  await reveal(produced);
}

/** The row a change just produced, highlighted briefly so the eye finds it. */
const flashed = ref(new Set<string>());
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(name: string): void {
  flashed.value = new Set([...flashed.value, name]);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flashed.value = new Set()), 1600);
  void nextTick(() =>
    document
      .querySelector(`.files-table tr[data-flash="true"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}

/** Copies each item next to itself under a free name, then selects the copies. */
async function duplicate(items: FileEntry[]): Promise<void> {
  if (working.value) return;
  const plan = pastePlan(
    {
      mode: "copy",
      paths: items.map(fullPath),
      folders: items.filter((item) => item.type === "dir").map(fullPath),
    },
    path.value,
    listing.value?.entries.map((entry) => entry.name) ?? [],
  );
  const produced = await batch(
    en.files.copying,
    plan.map((step) => ({
      name: baseName(step.from),
      result: step.to,
      work: () => client.copy(step.from, step.to),
    })),
  );
  if (produced.length === 1)
    status.value = en.files.duplicated.replace("{name}", baseName(produced[0] ?? ""));
  await reveal(produced);
}

/* Copy to…, Move to… and Extract to… */
const transfer = ref<{ mode: "copy" | "move" | "extract"; sources: string[] } | null>(null);

async function transferred(destination: string, count: number, produced: string[]): Promise<void> {
  const current = transfer.value;
  if (!current) return;
  const subject =
    count === 1 && current.sources.length === 1
      ? baseName(current.sources[0] ?? "")
      : en.files.itemCount.replace("{count}", String(count));
  status.value =
    current.mode === "extract"
      ? en.files.extracted.replace("{name}", produced[0] ?? destination)
      : (current.mode === "move" ? en.files.movedTo : en.files.copiedTo)
          .replace("{name}", subject)
          .replace("{path}", destination);
  // Into this folder: select what arrived. Elsewhere: what moved away is gone from here.
  if (destination === path.value) await reveal(produced);
  else await load();
}

/* Compress… and Extract here */
const compressing = ref<string[] | null>(null);
const takenNames = computed(() => new Set(listing.value?.entries.map((entry) => entry.name)));

async function compressed(to: string): Promise<void> {
  compressing.value = null;
  status.value = en.files.compressed.replace("{name}", baseName(to));
  await reveal([to]);
}

/** Unpacks into a new folder beside the archive, named by the agent. */
async function extractHere(entry: FileEntry): Promise<void> {
  if (working.value) return;
  working.value = {
    label: en.files.extracting.replace("{name}", entry.name),
    done: 0,
    total: 1,
  };
  failure.value = "";
  try {
    const result = await withStepUp(() => client.extract(fullPath(entry), path.value));
    if (!result) return;
    const name = baseName(result.path);
    status.value = result.skipped
      ? en.files.extractSkipped.replace("{name}", name).replace("{count}", String(result.skipped))
      : en.files.extracted.replace("{name}", name);
    working.value = null;
    await reveal([result.path]);
  } catch (error) {
    failure.value = `${entry.name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    working.value = null;
  }
}

async function copyPath(entry: FileEntry): Promise<void> {
  await copyText(fullPath(entry));
  status.value = en.files.copied;
}

let dismissed: (() => void) | null = null;

/**
 * Runs a request that may need step-up. When the panel asks for it, the identity dialog opens
 * and the request runs again once confirmed; null when the dialog is dismissed.
 */
async function withStepUp<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (!needsStepUp(error)) throw error;
    const confirmed = await new Promise<boolean>((resolve) => {
      intercept(error, () => resolve(true));
      dismissed = () => resolve(false);
    });
    dismissed = null;
    return confirmed ? withStepUp(work) : null;
  }
}

function onVerifyClose(): void {
  cancelVerify();
  dismissed?.();
}

/** `withStepUp` with failures shown through `onError`; undefined when it did not complete. */
async function guarded<T>(
  work: () => Promise<T>,
  onError: (message: string) => void,
): Promise<T | undefined> {
  try {
    return (await withStepUp(work)) ?? undefined;
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function download(entry: FileEntry): Promise<void> {
  await downloadPath(fullPath(entry));
}

async function downloadPath(target: string): Promise<void> {
  const ok = await guarded(
    () => client.downloadCheck(target),
    (message) => (failure.value = message),
  );
  if (!ok) return;
  const link = document.createElement("a");
  link.href = client.downloadUrl(target);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/* New folder, new file and rename share one dialog. */
const nameDialog = ref<{
  kind: "folder" | "file" | "rename";
  entry: FileEntry | null;
  value: string;
  error: string;
  busy: boolean;
} | null>(null);
const nameField = ref<HTMLInputElement | null>(null);

function openName(kind: "folder" | "file" | "rename", entry: FileEntry | null = null): void {
  nameDialog.value = { kind, entry, value: entry?.name ?? "", error: "", busy: false };
  void nextTick(() => {
    const field = nameField.value;
    if (!field) return;
    field.focus();
    // Select the stem so typing keeps the extension.
    const dot = entry && !isFolder(entry) ? entry.name.lastIndexOf(".") : -1;
    field.setSelectionRange(0, dot > 0 ? dot : field.value.length);
  });
}

const nameTitle = computed(() => {
  const dialog = nameDialog.value;
  if (!dialog) return "";
  if (dialog.kind === "rename")
    return en.files.renameTitle.replace("{name}", dialog.entry?.name ?? "");
  return (dialog.kind === "folder" ? en.files.newFolderTitle : en.files.newFileTitle).replace(
    "{path}",
    path.value,
  );
});

async function submitName(): Promise<void> {
  const dialog = nameDialog.value;
  if (!dialog || dialog.busy) return;
  const name = dialog.value.trim();
  if (!validName(name)) {
    dialog.error = en.files.nameInvalid;
    return;
  }
  if (dialog.kind === "rename" && name === dialog.entry?.name) {
    nameDialog.value = null;
    return;
  }
  const target = joinPath(path.value, name);
  dialog.busy = true;
  dialog.error = "";
  const done = await guarded(
    async () => {
      if (dialog.kind === "folder") await client.mkdir(target);
      else if (dialog.kind === "file")
        await client.write({ path: target, content: "", create: true });
      else if (dialog.entry) await client.rename(fullPath(dialog.entry), target);
      return true;
    },
    (message) => (dialog.error = message),
  );
  dialog.busy = false;
  if (!done) return;
  nameDialog.value = null;
  await load();
}

/* Delete */
const deleteDialog = ref<{ entries: FileEntry[]; busy: boolean; error: string } | null>(null);
const deleteTitle = computed(() => {
  const items = deleteDialog.value?.entries ?? [];
  return items.length === 1
    ? en.files.deleteTitle.replace("{name}", items[0]?.name ?? "")
    : en.files.deleteManyTitle.replace("{count}", String(items.length));
});

function openDelete(entries: FileEntry[]): void {
  if (entries.length) deleteDialog.value = { entries, busy: false, error: "" };
}

async function submitDelete(): Promise<void> {
  const dialog = deleteDialog.value;
  if (!dialog || dialog.busy) return;
  dialog.busy = true;
  dialog.error = "";
  const failed: string[] = [];
  for (const entry of dialog.entries) {
    try {
      // A link is removed itself, never what it points to.
      const done = await withStepUp(() => client.remove(fullPath(entry), entry.type === "dir"));
      if (done === null) break;
    } catch (error) {
      failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  dialog.busy = false;
  await load();
  if (failed.length) {
    dialog.error = failed.join("\n");
    dialog.entries = dialog.entries.filter((entry) =>
      failed.some((line) => line.startsWith(`${entry.name}:`)),
    );
    return;
  }
  deleteDialog.value = null;
  tableWrap.value?.focus({ preventScroll: true });
}

/* Permissions */
const permDialog = ref<{
  entry: FileEntry;
  mode: string;
  owner: string;
  group: string;
  recursive: boolean;
  busy: boolean;
  error: string;
} | null>(null);
const bits = [
  { who: en.files.ownerUser, shift: 6 },
  { who: en.files.ownerGroup, shift: 3 },
  { who: en.files.others, shift: 0 },
] as const;
const kinds = [
  { label: en.files.read, bit: 4 },
  { label: en.files.write, bit: 2 },
  { label: en.files.execute, bit: 1 },
] as const;

function openPermissions(entry: FileEntry): void {
  permDialog.value = {
    entry,
    mode: octal(entry.mode),
    owner: entry.owner,
    group: entry.group,
    recursive: false,
    busy: false,
    error: "",
  };
}

const parsedMode = computed(() => {
  const value = permDialog.value?.mode.trim() ?? "";
  return /^[0-7]{3,4}$/.test(value) ? Number.parseInt(value, 8) : null;
});

function toggleBit(shift: number, bit: number): void {
  const dialog = permDialog.value;
  if (!dialog || parsedMode.value === null) return;
  dialog.mode = octal(parsedMode.value ^ (bit << shift));
}

async function submitPermissions(): Promise<void> {
  const dialog = permDialog.value;
  if (!dialog || dialog.busy) return;
  const mode = parsedMode.value;
  if (mode === null) {
    dialog.error = en.files.modeInvalid;
    return;
  }
  const target = fullPath(dialog.entry);
  const deep = dialog.recursive && isFolder(dialog.entry);
  dialog.busy = true;
  dialog.error = "";
  const done = await guarded(
    async () => {
      if (mode !== dialog.entry.mode || deep) await client.chmod(target, mode, deep);
      if (dialog.owner !== dialog.entry.owner || dialog.group !== dialog.entry.group || deep)
        await client.chown(target, dialog.owner.trim(), dialog.group.trim(), deep);
      return true;
    },
    (message) => (dialog.error = message),
  );
  dialog.busy = false;
  if (!done) return;
  permDialog.value = null;
  await load();
}

/* Uploads: one at a time, each confirmed before its bytes are sent. */
interface Upload {
  id: number;
  name: string;
  folder: string;
  file: File;
  sent: number;
  state: "queued" | "uploading" | "done" | "failed" | "cancelled";
  error: string;
  controller: AbortController;
}
const uploads = ref<Upload[]>([]);
const picker = ref<HTMLInputElement | null>(null);
const replaceDialog = ref<{ upload: Upload; decide: (replace: boolean) => void } | null>(null);
const dragging = ref(false);
/** Enter and leave fire for every child; the count says whether the pointer is still inside. */
let dragDepth = 0;
let nextUpload = 1;
let pumping = false;

function enqueue(files: Iterable<File>): void {
  uploads.value = uploads.value.filter((item) => item.state !== "cancelled");
  for (const file of files)
    uploads.value.push({
      id: nextUpload++,
      name: file.name,
      folder: path.value,
      file,
      sent: 0,
      state: "queued",
      error: "",
      controller: new AbortController(),
    });
  void pump();
}

function askReplace(upload: Upload): Promise<boolean> {
  return new Promise((resolve) => {
    replaceDialog.value = {
      upload,
      decide: (replace) => {
        replaceDialog.value = null;
        resolve(replace);
      },
    };
  });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (
      let next = uploads.value.find((item) => item.state === "queued");
      next;
      next = uploads.value.find((item) => item.state === "queued")
    ) {
      const upload = next;
      upload.state = "uploading";
      const target = joinPath(upload.folder, upload.name);
      try {
        const found = await withStepUp(() => client.uploadCheck(target));
        if (found === null) {
          upload.state = "cancelled";
          continue;
        }
        if (found.exists && (found.type !== "file" || !(await askReplace(upload)))) {
          upload.state = "cancelled";
          continue;
        }
        await client.upload(target, upload.file, {
          overwrite: found.exists,
          signal: upload.controller.signal,
          progress: (sent) => (upload.sent = sent),
        });
        upload.sent = upload.file.size;
        upload.state = "done";
        status.value = en.files.uploaded.replace("{name}", upload.name);
        if (upload.folder === path.value) void load();
        globalThis.setTimeout(() => dismiss(upload), 4000);
      } catch (error) {
        if (error instanceof FilesRequestError && error.code === "E_CANCELLED")
          upload.state = "cancelled";
        else {
          upload.state = "failed";
          upload.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
  } finally {
    pumping = false;
  }
}

function cancelUpload(upload: Upload): void {
  if (upload.state === "queued") upload.state = "cancelled";
  else upload.controller.abort();
}

function dismiss(upload: Upload): void {
  // By id: the queue hands out reactive proxies, so object identity is not reliable.
  uploads.value = uploads.value.filter((item) => item.id !== upload.id);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files) enqueue([...input.files]);
  input.value = "";
}

function onDrop(event: DragEvent): void {
  dragDepth = 0;
  dragging.value = false;
  const items = [...(event.dataTransfer?.items ?? [])];
  const folders = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
  if (folders) failure.value = en.files.folderUpload;
  const files = items
    .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length) enqueue(files);
}

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
}

function onDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragDepth += 1;
  dragging.value = true;
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

const activeUploads = computed(() => uploads.value.filter((item) => item.state !== "cancelled"));

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!uploads.value.some((item) => item.state === "uploading" || item.state === "queued")) return;
  event.preventDefault();
}

async function findPlaces(): Promise<void> {
  if (props.roots?.length) {
    placesFound.value = props.roots;
    return;
  }
  const checks = await Promise.all(
    places.value.map((place) =>
      place === "/"
        ? Promise.resolve(true)
        : client.list(parentOf(place)).then(
            (result) =>
              result.entries.some((entry) => entry.name === baseName(place) && isFolder(entry)),
            () => false,
          ),
    ),
  );
  placesFound.value = places.value.filter((_, index) => checks[index]);
}

function start(): void {
  if (!available.value) return;
  void go(pathFromUrl() ?? treeRoots.value[0] ?? "/", false);
  void findPlaces();
}

watch(available, (now, before) => {
  if (now && !before) start();
});

onMounted(() => {
  globalThis.addEventListener("popstate", onPop);
  globalThis.addEventListener("beforeunload", onBeforeUnload);
  start();
});

onBeforeUnmount(() => {
  globalThis.removeEventListener("popstate", onPop);
  globalThis.removeEventListener("beforeunload", onBeforeUnload);
  for (const upload of uploads.value) upload.controller.abort();
});

defineExpose({ reload: load });
</script>

<template>
  <section class="files-page">
    <header class="page-head">
      <div>
        <h2>{{ en.files.title }}</h2>
        <p class="hint">{{ en.files.hint }}</p>
      </div>
      <div v-if="available" class="files-actions">
        <button type="button" @click="picker?.click()">
          <CloudUploadOutlined aria-hidden="true" />{{ en.files.upload }}
        </button>
        <button type="button" class="quiet" @click="openName('folder')">
          <FolderAddOutlined aria-hidden="true" />{{ en.files.newFolder }}
        </button>
        <button type="button" class="quiet" @click="openName('file')">
          <FileAddOutlined aria-hidden="true" />{{ en.files.newFile }}
        </button>
        <input ref="picker" type="file" multiple hidden @change="onPick" />
      </div>
    </header>

    <div v-if="!available" class="files-empty">
      <FolderOpenOutlined aria-hidden="true" />
      <p v-if="!canManage">{{ en.files.forbidden }}</p>
      <p v-else-if="!online">{{ en.files.offline }}</p>
      <template v-else>
        <h3>{{ en.files.unavailableTitle }}</h3>
        <p class="hint">{{ en.files.unavailable }}</p>
      </template>
    </div>

    <div v-else class="files-frame">
      <aside class="files-side">
        <h3>{{ en.files.places }}</h3>
        <ul class="files-places">
          <li v-for="place in placesFound" :key="place">
            <button
              type="button"
              :aria-current="place === path ? 'location' : undefined"
              @click="go(place)"
            >
              {{ place === "/" ? en.files.root : place }}
            </button>
          </li>
        </ul>
        <h3>{{ en.files.folders }}</h3>
        <FileTree
          ref="tree"
          :client="client"
          :current="path"
          :pending="loading ? path : ''"
          :roots="treeRoots"
          @navigate="go"
        />
      </aside>

      <div
        class="files-main"
        :data-dragging="dragging"
        @keydown="onListKey"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <template v-if="!editing">
          <div class="files-bar">
            <button
              type="button"
              class="quiet files-icon"
              :aria-label="en.files.up"
              :title="en.files.up"
              :disabled="upDisabled"
              @click="go(parentOf(path))"
            >
              <ArrowUpOutlined aria-hidden="true" />
            </button>
            <form v-if="editingPath" class="files-path-form" @submit.prevent="submitPath">
              <input
                ref="pathField"
                v-model="pathInput"
                :aria-label="en.files.path"
                spellcheck="false"
                autocomplete="off"
                :aria-invalid="pathError ? 'true' : undefined"
                @keydown.esc="editingPath = false"
                @blur="editingPath = false"
              />
            </form>
            <nav
              v-else
              ref="crumbBar"
              class="files-crumbs"
              :aria-label="en.files.path"
              @dblclick="startPathEdit"
            >
              <template v-for="(crumb, index) in trail" :key="crumb.path">
                <span v-if="index > 1" class="files-sep" aria-hidden="true">/</span>
                <button
                  type="button"
                  :aria-current="index === trail.length - 1 ? 'location' : undefined"
                  @click="go(crumb.path)"
                >
                  {{ crumb.name }}
                </button>
              </template>
            </nav>
            <button
              v-if="!editingPath"
              type="button"
              class="quiet files-icon"
              :aria-label="en.files.editPath"
              :title="en.files.editPath"
              @click="startPathEdit"
            >
              <EditOutlined aria-hidden="true" />
            </button>
            <label class="files-filter" :data-active="Boolean(filter) || undefined">
              <SearchOutlined aria-hidden="true" />
              <input
                ref="filterField"
                v-model="filter"
                type="search"
                :placeholder="en.files.filter"
                :aria-label="en.files.filterLabel"
                :title="en.files.filterHint"
                spellcheck="false"
                autocomplete="off"
                @keydown="onFilterKey"
              />
              <small v-if="filter" aria-live="polite">{{
                en.files.filterCount
                  .replace("{shown}", String(entries.length))
                  .replace("{total}", String(sorted.length))
              }}</small>
            </label>
            <button
              type="button"
              class="quiet files-icon"
              :aria-pressed="showHidden"
              :aria-label="en.files.showHidden"
              :title="showHidden ? en.files.hideHidden : en.files.showHidden"
              @click="toggleHidden"
            >
              <EyeOutlined v-if="showHidden" aria-hidden="true" /><EyeInvisibleOutlined
                v-else
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="quiet files-icon"
              :aria-label="en.files.refresh"
              :title="en.files.refresh"
              :disabled="loading"
              @click="load"
            >
              <ReloadOutlined :spin="loading" aria-hidden="true" />
            </button>
          </div>
          <p v-if="pathError" class="form-error" role="alert">{{ pathError }}</p>
          <p v-if="failure" class="form-error files-failure files-lines" role="alert">
            {{ failure }}
            <button
              type="button"
              class="files-dismiss"
              :aria-label="en.files.dismiss"
              @click="failure = ''"
            >
              <CloseOutlined aria-hidden="true" />
            </button>
          </p>
          <p v-if="listing?.truncated" class="form-warn">
            {{ en.files.truncated.replace("{count}", listing.entries.length.toLocaleString()) }}
          </p>

          <div
            v-if="selected.length || clip || working"
            class="files-selbar"
            role="toolbar"
            :aria-label="en.files.selectionActions"
          >
            <template v-if="working">
              <span class="spinner" aria-hidden="true" />
              <span class="files-selbar-text" aria-live="polite">{{
                working.label
                  .replace("{done}", String(working.done))
                  .replace("{total}", String(working.total))
              }}</span>
            </template>
            <template v-else-if="selected.length">
              <button
                type="button"
                class="bar-action"
                :aria-label="en.files.clearSelection"
                :title="`${en.files.clearSelection} (Esc)`"
                @click="clearSelection"
              >
                <CloseOutlined aria-hidden="true" />
              </button>
              <span class="files-selbar-text">{{
                en.files.selectedCount.replace("{count}", String(selected.length))
              }}</span>
              <span class="bar-sep" aria-hidden="true" />
              <button
                type="button"
                class="bar-action"
                :title="`${en.files.cut} (${shortcut('mod+x')})`"
                @click="putAside('cut')"
              >
                <ScissorOutlined aria-hidden="true" /><span>{{ en.files.cut }}</span>
              </button>
              <button
                type="button"
                class="bar-action"
                :title="`${en.files.copy} (${shortcut('mod+c')})`"
                @click="putAside('copy')"
              >
                <CopyOutlined aria-hidden="true" /><span>{{ en.files.copy }}</span>
              </button>
              <button
                v-if="clip"
                type="button"
                class="bar-action"
                :title="`${en.files.pasteHere} (${shortcut('mod+v')})`"
                @click="paste"
              >
                <SnippetsOutlined aria-hidden="true" /><span>{{
                  en.files.pasteCount.replace("{count}", String(clip.paths.length))
                }}</span>
              </button>
              <span class="bar-sep" aria-hidden="true" />
              <button
                type="button"
                class="bar-action"
                :title="`${en.files.duplicate} (${shortcut('mod+d')})`"
                @click="duplicate(selected)"
              >
                <span>{{ en.files.duplicate }}</span>
              </button>
              <button type="button" class="bar-action" @click="openTransfer('copyTo', selected)">
                <span>{{ en.files.copyTo }}</span>
              </button>
              <button type="button" class="bar-action" @click="openTransfer('moveTo', selected)">
                <span>{{ en.files.moveTo }}</span>
              </button>
              <button
                type="button"
                class="bar-action"
                @click="compressing = selected.map(fullPath)"
              >
                <span>{{ en.files.compressMenu }}</span>
              </button>
              <button
                v-if="selected.length === 1 && selected[0]"
                type="button"
                class="bar-action"
                :title="en.files.download"
                @click="selected[0] && download(selected[0])"
              >
                <DownloadOutlined aria-hidden="true" /><span>{{ en.files.download }}</span>
              </button>
              <button
                type="button"
                class="bar-action files-selbar-danger"
                :title="`${en.files.delete} (${deleteShortcut()})`"
                @click="openDelete(selected)"
              >
                <DeleteOutlined aria-hidden="true" /><span>{{ en.files.delete }}</span>
              </button>
            </template>
            <template v-else-if="clip">
              <SnippetsOutlined class="files-selbar-icon" aria-hidden="true" />
              <span class="files-selbar-text">{{
                (clip.mode === "cut" ? en.files.clipCut : en.files.clipCopied).replace(
                  "{name}",
                  clipNames,
                )
              }}</span>
              <button
                type="button"
                class="bar-action bar-primary"
                :title="`${en.files.pasteHere} (${shortcut('mod+v')})`"
                @click="paste"
              >
                <span>{{ en.files.pasteHere }}</span>
              </button>
              <button type="button" class="bar-action" @click="fileClipboard = null">
                <span>{{ en.files.clearClipboard }}</span>
              </button>
            </template>
          </div>

          <div
            ref="tableWrap"
            class="files-table-wrap"
            tabindex="0"
            :aria-busy="loading"
            :aria-label="en.files.listLabel"
            @contextmenu="onBackgroundMenu"
          >
            <span v-if="loading" class="files-progress" aria-hidden="true" />
            <table
              v-if="listing && entries.length"
              class="files-table"
              :data-stale="loading && listing.path !== path"
            >
              <thead>
                <tr>
                  <th class="files-check-cell">
                    <input
                      type="checkbox"
                      :checked="allSelected"
                      :indeterminate="selected.length > 0 && !allSelected"
                      :aria-label="en.files.selectAll"
                      @change="allSelected ? clearSelection() : selectAll()"
                    />
                  </th>
                  <th :aria-sort="sortState('name')">
                    <button type="button" class="files-sort" @click="sortBy('name')">
                      {{ en.files.name }}
                    </button>
                  </th>
                  <th class="files-num" :aria-sort="sortState('size')">
                    <button type="button" class="files-sort" @click="sortBy('size')">
                      {{ en.files.size }}
                    </button>
                  </th>
                  <th class="files-wide" :aria-sort="sortState('mtime')">
                    <button type="button" class="files-sort" @click="sortBy('mtime')">
                      {{ en.files.modified }}
                    </button>
                  </th>
                  <th class="files-wide">{{ en.files.permissions }}</th>
                  <th class="files-wide">{{ en.files.owner }}</th>
                  <th>
                    <span class="sr-only">{{ en.files.actions }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in entries"
                  :key="entry.name"
                  :data-type="entry.type"
                  :data-flash="flashed.has(entry.name) || undefined"
                  :data-selected="selection.names.has(entry.name) || undefined"
                  :data-cursor="cursor === entry.name || undefined"
                  @click="onRowClick(entry, $event)"
                  @dblclick="openEntry(entry)"
                  @contextmenu.prevent="onRowMenu(entry, $event)"
                >
                  <td class="files-check-cell" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selection.names.has(entry.name)"
                      :aria-label="en.files.selectName.replace('{name}', entry.name)"
                      @click="onCheck(entry, $event)"
                    />
                  </td>
                  <td class="files-name-cell">
                    <button
                      type="button"
                      class="files-name"
                      :title="linkTitle(entry) ?? entry.name"
                      :disabled="
                        entry.type === 'other' || (entry.type === 'link' && !entry.targetType)
                      "
                      @click.stop="onNameClick(entry, $event)"
                    >
                      <FolderFilled
                        v-if="isFolder(entry)"
                        class="files-folder"
                        aria-hidden="true"
                      />
                      <FileOutlined v-else aria-hidden="true" />
                      <span>{{ entry.name }}</span>
                      <LinkOutlined
                        v-if="entry.type === 'link'"
                        class="files-link"
                        :aria-label="linkTitle(entry)"
                      />
                    </button>
                    <small class="files-narrow">{{ modified(entry) }}</small>
                  </td>
                  <td class="files-num">{{ isFolder(entry) ? "—" : formatBytes(entry.size) }}</td>
                  <td class="files-wide files-muted" :title="new Date(entry.mtime).toISOString()">
                    {{ modified(entry) }}
                  </td>
                  <td class="files-wide files-mono" :title="octal(entry.mode)">
                    {{ modeString(entry.mode, entry.type) }}
                  </td>
                  <td class="files-wide files-muted">
                    {{
                      entry.owner === entry.group ? entry.owner : `${entry.owner}:${entry.group}`
                    }}
                  </td>
                  <td class="files-row-actions" @click.stop>
                    <ActionMenu
                      :ref="(menu) => setMenu(entry.name, menu)"
                      :name="
                        selected.length > 1 && selection.names.has(entry.name)
                          ? en.files.itemCount.replace('{count}', String(selected.length))
                          : entry.name
                      "
                      :disabled="false"
                      :actions="rowActions(entry)"
                      @action="rowAction(entry, $event)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else-if="listing && !loading && hiddenRows" class="files-none">
              <SearchOutlined aria-hidden="true" />
              <p>
                {{
                  filter
                    ? en.files.noMatch.replace("{filter}", filter.trim())
                    : en.files.onlyHidden.replace("{count}", String(hiddenRows))
                }}
              </p>
              <button type="button" class="quiet" @click="filter ? (filter = '') : toggleHidden()">
                {{ filter ? en.files.clearFilter : en.files.showHidden }}
              </button>
            </div>
            <div v-else-if="listing && !loading" class="files-none">
              <FolderOpenOutlined aria-hidden="true" />
              <p>{{ en.files.empty }}</p>
              <p class="hint">{{ en.files.emptyHint }}</p>
            </div>
            <p v-else-if="loading && !listing" class="files-none hint">
              <span class="spinner" /> {{ en.files.loading }}
            </p>
            <ActionMenu
              ref="backgroundMenu"
              bare
              :name="path"
              :disabled="false"
              :actions="backgroundActions"
              @action="backgroundAction"
            />
            <p v-if="dragging" class="files-drop" aria-hidden="true">
              {{ en.files.dropHere.replace("{path}", path) }}
            </p>
          </div>
        </template>
        <FileEditor
          v-else
          ref="editor"
          :key="editing.path"
          :client="client"
          :path="editing.path"
          :size="editing.size"
          :guard="withStepUp"
          @close="editing = null"
          @saved="load"
          @download="editing && downloadPath(editing.path)"
        />

        <section v-if="activeUploads.length" class="files-uploads" :aria-label="en.files.uploads">
          <div
            v-for="upload in activeUploads"
            :key="upload.id"
            class="files-upload"
            :data-state="upload.state"
          >
            <div class="files-upload-line">
              <span class="files-upload-name">{{ upload.name }}</span>
              <span class="files-upload-figure">
                {{ formatBytes(upload.sent) }} / {{ formatBytes(upload.file.size) }}
              </span>
              <button
                v-if="upload.state === 'queued' || upload.state === 'uploading'"
                type="button"
                class="quiet files-icon"
                :aria-label="en.files.cancelUpload.replace('{name}', upload.name)"
                @click="cancelUpload(upload)"
              >
                <CloseOutlined aria-hidden="true" />
              </button>
              <button
                v-else
                type="button"
                class="quiet files-icon"
                :aria-label="en.files.dismiss"
                @click="dismiss(upload)"
              >
                <CloseOutlined aria-hidden="true" />
              </button>
            </div>
            <div
              class="meter"
              role="progressbar"
              :aria-label="en.files.uploading.replace('{name}', upload.name)"
              :aria-valuenow="Math.round((upload.sent / Math.max(1, upload.file.size)) * 100)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span
                class="meter-fill"
                :data-level="
                  upload.state === 'failed' ? 'danger' : upload.state === 'done' ? 'ok' : undefined
                "
                :style="{ transform: `scaleX(${upload.sent / Math.max(1, upload.file.size)})` }"
              />
            </div>
            <p v-if="upload.error" class="files-upload-error">{{ upload.error }}</p>
          </div>
        </section>
      </div>
    </div>
    <p class="sr-only" aria-live="polite">{{ status }}</p>

    <AppDialog :open="nameDialog !== null" narrow :title="nameTitle" @close="nameDialog = null">
      <form v-if="nameDialog" id="files-name-form" @submit.prevent="submitName">
        <label class="field">
          <span>{{ en.files.nameLabel }}</span>
          <input
            ref="nameField"
            v-model="nameDialog.value"
            spellcheck="false"
            autocomplete="off"
            :aria-invalid="nameDialog.error ? 'true' : undefined"
          />
        </label>
        <p v-if="nameDialog.error" class="form-error" role="alert">{{ nameDialog.error }}</p>
      </form>
      <template #footer>
        <button type="button" class="quiet" @click="nameDialog = null">
          {{ en.files.cancel }}
        </button>
        <button type="submit" form="files-name-form" :disabled="nameDialog?.busy">
          <span v-if="nameDialog?.busy" class="spinner" />
          {{ nameDialog?.kind === "rename" ? en.files.rename : en.files.create }}
        </button>
      </template>
    </AppDialog>

    <FileArchiveDialog
      :client="client"
      :sources="compressing"
      :taken="takenNames"
      :guard="withStepUp"
      @done="compressed"
      @close="compressing = null"
    />

    <FileTransferDialog
      :client="client"
      :mode="transfer?.mode ?? null"
      :sources="transfer?.sources ?? []"
      :roots="treeRoots"
      :guard="withStepUp"
      @done="transferred"
      @close="transfer = null"
    />

    <AppDialog
      :open="deleteDialog !== null"
      narrow
      :title="deleteTitle"
      @close="!deleteDialog?.busy && (deleteDialog = null)"
    >
      <template v-if="deleteDialog">
        <p
          v-if="deleteDialog.entries.length === 1 && deleteDialog.entries[0]"
          class="hint files-wrap"
        >
          {{
            (deleteDialog.entries[0].type === "dir"
              ? en.files.deleteFolder
              : en.files.deleteFile
            ).replace("{path}", fullPath(deleteDialog.entries[0]))
          }}
        </p>
        <template v-else>
          <p class="hint">{{ en.files.deleteMany.replace("{path}", path) }}</p>
          <ul class="files-delete-list">
            <li v-for="entry in deleteDialog.entries.slice(0, 8)" :key="entry.name">
              <FolderFilled v-if="isFolder(entry)" class="files-folder" aria-hidden="true" />
              <FileOutlined v-else aria-hidden="true" />{{ entry.name }}
            </li>
            <li v-if="deleteDialog.entries.length > 8" class="hint">
              {{ en.files.andMore.replace("{count}", String(deleteDialog.entries.length - 8)) }}
            </li>
          </ul>
        </template>
        <p v-if="deleteDialog.error" class="form-error files-lines" role="alert">
          {{ deleteDialog.error }}
        </p>
      </template>
      <template #footer>
        <button
          type="button"
          class="quiet"
          :disabled="deleteDialog?.busy"
          @click="deleteDialog = null"
        >
          {{ en.files.cancel }}
        </button>
        <button type="button" class="danger" :disabled="deleteDialog?.busy" @click="submitDelete">
          <span v-if="deleteDialog?.busy" class="spinner" />{{ en.files.deleteConfirm }}
        </button>
      </template>
    </AppDialog>

    <AppDialog
      :open="permDialog !== null"
      :title="en.files.permissionsTitle.replace('{name}', permDialog?.entry.name ?? '')"
      @close="permDialog = null"
    >
      <form v-if="permDialog" id="files-perm-form" @submit.prevent="submitPermissions">
        <table class="files-bits">
          <thead>
            <tr>
              <th />
              <th v-for="kind in kinds" :key="kind.bit" scope="col">{{ kind.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in bits" :key="row.shift">
              <th scope="row">{{ row.who }}</th>
              <td v-for="kind in kinds" :key="kind.bit">
                <input
                  type="checkbox"
                  :aria-label="`${row.who} ${kind.label}`"
                  :disabled="parsedMode === null"
                  :checked="parsedMode !== null && ((parsedMode >> row.shift) & kind.bit) !== 0"
                  @change="toggleBit(row.shift, kind.bit)"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div class="files-perm-fields">
          <label class="field files-mode">
            <span>{{ en.files.mode }}</span>
            <input
              v-model="permDialog.mode"
              inputmode="numeric"
              spellcheck="false"
              :aria-invalid="parsedMode === null ? 'true' : undefined"
            />
          </label>
          <label class="field">
            <span>{{ en.files.user }}</span>
            <input v-model="permDialog.owner" spellcheck="false" autocomplete="off" />
          </label>
          <label class="field">
            <span>{{ en.files.group }}</span>
            <input v-model="permDialog.group" spellcheck="false" autocomplete="off" />
          </label>
        </div>
        <label
          v-if="isFolder(permDialog.entry) && permDialog.entry.type === 'dir'"
          class="files-check"
        >
          <input v-model="permDialog.recursive" type="checkbox" />
          <span>{{ en.files.recursive }}</span>
        </label>
        <p v-if="permDialog.recursive" class="hint">{{ en.files.recursiveHint }}</p>
        <p v-if="permDialog.error" class="form-error" role="alert">{{ permDialog.error }}</p>
      </form>
      <template #footer>
        <button type="button" class="quiet" @click="permDialog = null">
          {{ en.files.cancel }}
        </button>
        <button type="submit" form="files-perm-form" :disabled="permDialog?.busy">
          <span v-if="permDialog?.busy" class="spinner" />{{ en.files.save }}
        </button>
      </template>
    </AppDialog>

    <AppDialog
      :open="replaceDialog !== null"
      narrow
      :title="en.files.replaceTitle.replace('{name}', replaceDialog?.upload.name ?? '')"
      @close="replaceDialog?.decide(false)"
    >
      <p v-if="replaceDialog" class="hint files-wrap">
        {{
          en.files.replaceBody.replace(
            "{path}",
            joinPath(replaceDialog.upload.folder, replaceDialog.upload.name),
          )
        }}
      </p>
      <template #footer>
        <button type="button" class="quiet" @click="replaceDialog?.decide(false)">
          {{ en.files.skip }}
        </button>
        <button type="button" class="danger" @click="replaceDialog?.decide(true)">
          {{ en.files.replace }}
        </button>
      </template>
    </AppDialog>

    <ReauthenticateDialog
      :open="verifying"
      :reason="en.files.verify"
      @close="onVerifyClose"
      @verified="verified"
    />
  </section>
</template>

<style scoped>
.files-page {
  display: flex;
  flex-direction: column;
  /* The panes scroll inside the viewport below the shell header instead of the page. */
  height: calc(100dvh - 140px);
}
.files-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.files-frame {
  display: grid;
  flex: 1 1 0;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 420px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.files-side {
  min-height: 0;
  padding: 12px 8px;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--raised);
}
.files-side h3 {
  margin: 0 8px 6px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
}
.files-side h3:not(:first-child) {
  margin-top: 18px;
}
.files-places {
  margin: 0;
  padding: 0;
  list-style: none;
}
.files-places button {
  width: 100%;
  min-height: 28px;
  justify-content: flex-start;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
}
.files-places button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.files-places button[aria-current="location"] {
  background: var(--bg-hover);
  color: var(--text);
}
.files-main {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.files-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
button.files-icon {
  flex: none;
  width: 32px;
  min-height: 32px;
  padding: 0;
  border-color: transparent;
}
.files-crumbs {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  font-family: var(--font-mono);
  font-size: 13px;
}
.files-crumbs button {
  flex: none;
  min-height: 30px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font-weight: 400;
}
.files-crumbs button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.files-crumbs button[aria-current="location"] {
  color: var(--text);
  font-weight: 600;
}
.files-sep {
  color: var(--text-3);
}
.files-path-form {
  flex: 1;
}
.files-path-form input {
  padding: 5px 8px;
  font-family: var(--font-mono);
  font-size: 13px;
}
.files-main > .form-error,
.files-main > .form-warn {
  margin: 8px 8px 0;
}
.files-failure {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 8px;
}
button.files-dismiss {
  flex: none;
  min-height: 20px;
  padding: 2px;
  border: 0;
  background: transparent;
  color: inherit;
}
.files-table-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
}
.files-lines {
  white-space: pre-line;
}
.files-filter {
  display: flex;
  flex: 0 1 200px;
  align-items: center;
  gap: 6px;
  min-width: 96px;
  height: 30px;
  margin-inline: 4px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--raised);
  color: var(--text-3);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.files-filter:focus-within,
.files-filter[data-active] {
  border-color: var(--primary);
}
.files-filter input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
  box-shadow: none;
}
.files-filter input::-webkit-search-cancel-button {
  display: none;
}
.files-filter small {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
button.files-icon[aria-pressed="false"] {
  color: var(--text-3);
}
.files-selbar {
  display: flex;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
  container-type: inline-size;
  gap: 2px;
  min-height: 40px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--primary) 7%, var(--surface));
  animation: files-selbar var(--dur) var(--ease-out);
}
@keyframes files-selbar {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .files-selbar {
    animation: none;
  }
}
.files-selbar-text {
  flex: none;
  margin-inline: 6px 4px;
  white-space: nowrap;
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.files-selbar-icon {
  margin-inline-start: 6px;
  color: var(--primary);
}
.files-selbar > .spinner {
  margin-inline-start: 8px;
}
button.bar-action.files-selbar-danger {
  color: var(--danger);
}
button.bar-action.files-selbar-danger:hover {
  background: var(--danger-tint);
  color: var(--danger);
}
.files-table .files-check-cell {
  width: 36px;
  padding: 0 0 0 12px;
}
.files-check-cell input {
  display: block;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--primary);
  cursor: pointer;
}
.files-table tbody tr {
  cursor: default;
}
.files-table tbody tr[data-selected="true"] {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
}
.files-table tbody tr[data-selected="true"]:hover {
  background: color-mix(in srgb, var(--primary) 16%, transparent);
}
.files-table-wrap:focus-visible tr[data-cursor="true"] td {
  box-shadow:
    inset 0 1px 0 var(--primary),
    inset 0 -1px 0 var(--primary);
}
.files-table-wrap:focus-visible tr[data-cursor="true"] td:first-child {
  box-shadow:
    inset 2px 0 0 var(--primary),
    inset 0 1px 0 var(--primary),
    inset 0 -1px 0 var(--primary);
}
.files-delete-list {
  display: grid;
  gap: 4px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.files-delete-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-wrap: anywhere;
}
/* The list's own width decides, since the tree beside it takes a varying share. */
@container (max-width: 860px) {
  .files-selbar .bar-action:has(.anticon) > span:not(.anticon) {
    display: none;
  }
}
@media (max-width: 560px) {
  .files-bar {
    flex-wrap: wrap;
  }
  .files-filter {
    order: 10;
    flex: 1 0 100%;
    margin: 2px 0 0;
  }
}
.files-progress {
  position: sticky;
  top: 0;
  z-index: 2;
  display: block;
  height: 2px;
  margin-bottom: -2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--primary) 18%, transparent);
}
.files-progress::after {
  content: "";
  display: block;
  width: 35%;
  height: 100%;
  background: var(--primary);
  animation: files-progress 1s var(--ease-out) infinite;
}
@keyframes files-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .files-progress::after {
    width: 100%;
    animation: none;
  }
}
.files-table {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.files-table tr[data-flash="true"] td {
  animation: files-flash 1.6s var(--ease-out);
}
@keyframes files-flash {
  from {
    background: color-mix(in srgb, var(--primary) 22%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .files-table tr[data-flash="true"] td {
    animation: none;
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
}
/* The previous folder fades only if the next one is slow, so quick loads do not flicker. */
.files-table[data-stale="true"] {
  opacity: 0.45;
  pointer-events: none;
  transition-delay: 150ms;
}
.files-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  text-align: left;
}
.files-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
}
.files-table td {
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.files-table tbody tr:last-child td {
  border-bottom: 0;
}
.files-table tbody tr:hover {
  background: var(--bg-hover);
}
button.files-sort {
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
}
button.files-sort:hover:not(:disabled) {
  background: transparent;
  color: var(--text);
}
th[aria-sort="ascending"] .files-sort::after {
  content: " ↑";
}
th[aria-sort="descending"] .files-sort::after {
  content: " ↓";
}
.files-name-cell {
  width: 100%;
  max-width: 0;
}
button.files-name {
  justify-content: flex-start;
  max-width: 100%;
  min-height: 30px;
  gap: 8px;
  padding: 0 6px;
  margin-inline-start: -6px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-weight: 400;
}
button.files-name:hover:not(:disabled) {
  background: transparent;
  color: var(--primary);
}
button.files-name:disabled {
  opacity: 0.7;
}
button.files-name span {
  overflow: hidden;
  text-overflow: ellipsis;
}
button.files-name :deep(.anticon) {
  flex: none;
  color: var(--text-3);
}
.files-folder :deep(svg),
button.files-name .files-folder {
  color: var(--primary);
}
.files-link {
  font-size: 11px;
}
.files-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
th.files-num {
  text-align: right;
}
.files-muted {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.files-mono {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 12px;
}
.files-row-actions {
  width: 1%;
  text-align: right;
}
.files-row-actions :deep(.action-more) {
  border-color: transparent;
}
.files-narrow {
  display: none;
}
.files-none {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 48px 16px;
  margin: 0;
  color: var(--text-2);
  text-align: center;
}
.files-none p {
  margin: 0;
}
.files-none :deep(svg) {
  font-size: 22px;
  color: var(--text-3);
}
.files-main[data-dragging="true"] .files-table-wrap {
  outline: 2px dashed var(--primary);
  outline-offset: -6px;
}
.files-drop {
  position: absolute;
  inset: auto 16px 16px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--raised);
  box-shadow: var(--shadow-popover);
  color: var(--text);
  font-size: 13px;
  pointer-events: none;
}
.files-uploads {
  display: grid;
  gap: 10px;
  max-height: 40%;
  padding: 10px 12px;
  overflow: auto;
  border-top: 1px solid var(--line);
  background: var(--raised);
}
.files-upload-line {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.files-upload-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.files-upload-figure {
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.files-upload .meter {
  margin-top: 4px;
}
.files-upload .meter-fill:not([data-level]) {
  background: var(--primary);
}
.files-upload-error {
  margin: 6px 0 0;
  color: var(--danger);
  font-size: 12px;
}
.files-empty {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 24px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
.files-empty :deep(svg) {
  font-size: 22px;
  color: var(--text-3);
}
.files-empty h3,
.files-empty p {
  margin: 0;
  max-width: 64ch;
  text-wrap: pretty;
}
.files-wrap {
  overflow-wrap: anywhere;
}
.files-bits {
  border-collapse: collapse;
}
.files-bits th,
.files-bits td {
  padding: 6px 14px 6px 0;
  font-size: 13px;
  text-align: left;
}
.files-bits thead th {
  color: var(--text-3);
  font-size: 11px;
  font-weight: 500;
}
.files-bits tbody th {
  color: var(--text-2);
  font-weight: 400;
}
.files-bits input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
}
.files-perm-fields {
  display: grid;
  grid-template-columns: 96px 1fr 1fr;
  gap: 12px;
}
.files-mode input {
  font-family: var(--font-mono);
}
.files-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  font-size: 13px;
}
.files-check input {
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
}
@media (max-width: 900px) {
  .files-frame {
    grid-template-columns: minmax(0, 1fr);
  }
  .files-side {
    display: none;
  }
}
@media (max-width: 720px) {
  .files-wide {
    display: none;
  }
  .files-narrow {
    display: block;
    margin-top: -4px;
    padding-bottom: 6px;
    color: var(--text-3);
    font-size: 11px;
  }
  .files-table td {
    height: auto;
    padding-top: 6px;
  }
  .files-perm-fields {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 640px) {
  .files-page {
    height: calc(100dvh - 120px);
  }
  .files-frame {
    margin-inline: -12px;
    border-inline: 0;
    border-radius: 0;
  }
}
</style>
