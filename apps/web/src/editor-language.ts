// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

/** Syntax modes the file editor knows. Everything else opens as plain text. */
export type EditorLanguage =
  | "nginx"
  | "shell"
  | "yaml"
  | "json"
  | "javascript"
  | "typescript"
  | "properties"
  | "toml"
  | "dockerfile"
  | "python"
  | "css"
  | "xml"
  | "sql"
  | "diff";

export const languageLabels: Record<EditorLanguage, string> = {
  nginx: "Nginx",
  shell: "Shell",
  yaml: "YAML",
  json: "JSON",
  javascript: "JavaScript",
  typescript: "TypeScript",
  properties: "INI / env",
  toml: "TOML",
  dockerfile: "Dockerfile",
  python: "Python",
  css: "CSS",
  xml: "HTML / XML",
  sql: "SQL",
  diff: "Diff",
};

const byExtension: Record<string, EditorLanguage> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  env: "properties",
  ini: "properties",
  cfg: "properties",
  cnf: "properties",
  properties: "properties",
  service: "properties",
  socket: "properties",
  timer: "properties",
  mount: "properties",
  toml: "toml",
  py: "python",
  css: "css",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  diff: "diff",
  patch: "diff",
};

const shellNames = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zprofile",
  "profile",
  "bashrc",
]);

/** The mode for a file, from its name and where it lives. */
export function languageFor(path: string): EditorLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile"))
    return "dockerfile";
  if (shellNames.has(lower)) return "shell";
  if (lower === ".env" || lower.startsWith(".env.")) return "properties";
  // Nginx keeps `.conf` files and extensionless site files under its own tree.
  if (path.startsWith("/etc/nginx/") || /(^|\/)nginx[^/]*\.conf$/.test(path)) return "nginx";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return byExtension[lower.slice(dot + 1)] ?? null;
}

/** The line separator a file uses, so saving does not rewrite its line endings. */
export function lineSeparator(text: string): "\n" | "\r\n" {
  const first = text.indexOf("\n");
  return first > 0 && text[first - 1] === "\r" ? "\r\n" : "\n";
}
