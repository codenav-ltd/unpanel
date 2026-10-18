// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

export interface ReleaseSummary {
  version: string;
  date: string;
  /** The first sentence of the release's first entry, as plain text. */
  summary: string;
}

const MAX_SUMMARY = 140;

/** Reads `## [version] - date` sections of a Keep a Changelog file, newest first. */
export function parseReleases(markdown: string): ReleaseSummary[] {
  const releases: ReleaseSummary[] = [];
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    const heading = /^\[([^\]]+)\] - (\d{4}-\d{2}-\d{2})/.exec(section);
    if (!heading) continue;
    const entry = /^- (.+)$/m.exec(section)?.[1] ?? "";
    releases.push({ version: heading[1]!, date: heading[2]!, summary: firstSentence(entry) });
  }
  return releases;
}

export function firstSentence(text: string): string {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
  // A sentence ends at ". " followed by a capital, so "e.g. the" and "1.5 MB" stay whole.
  const end = /[.!?](?=\s+[A-Z])/.exec(plain);
  const sentence = end ? plain.slice(0, end.index + 1) : plain;
  if (sentence.length <= MAX_SUMMARY) return sentence;
  const cut = sentence.slice(0, MAX_SUMMARY - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}
