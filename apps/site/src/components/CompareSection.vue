<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { product } from "@unpanel/shared";
import {
  comparison,
  measuredVersions,
  panels,
  sources,
  type CompareRow,
} from "../content/measurements";
import { format, useLocale } from "../i18n";

const { t } = useLocale();

function rowText(key: CompareRow): { label: string; note?: string } {
  return t.compare.rows[key];
}

function cell(value: string): string {
  return value in t.compare.values
    ? t.compare.values[value as keyof typeof t.compare.values]
    : value;
}
</script>

<template>
  <section id="compare" class="section">
    <div class="wrap">
      <header class="section-head">
        <h2>{{ t.compare.title }}</h2>
        <p class="lede">{{ t.compare.lede }}</p>
      </header>

      <div class="table-wrap" tabindex="0" :aria-label="t.compare.title">
        <table>
          <thead>
            <tr>
              <th scope="col" class="label">
                <span class="sr-only">{{ t.compare.measurement }}</span>
              </th>
              <th
                v-for="panel in panels"
                :key="panel"
                scope="col"
                :class="{ us: panel === 'Unpanel' }"
              >
                {{ panel }}
              </th>
            </tr>
          </thead>
          <tbody v-for="group in comparison" :key="group.group">
            <tr class="group">
              <th scope="colgroup" :colspan="panels.length + 1">
                <span>{{ t.compare.groups[group.group] }}</span>
              </th>
            </tr>
            <tr v-for="row in group.rows" :key="row.key">
              <th scope="row" class="label">
                {{ rowText(row.key).label }}
                <span v-if="rowText(row.key).note" class="note">{{ rowText(row.key).note }}</span>
              </th>
              <td
                v-for="(value, index) in row.values"
                :key="panels[index]"
                :data-panel="panels[index]"
                :class="{ us: index === 0, words: value in t.compare.values }"
              >
                {{ cell(value) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="foot">
        <p>{{ format(t.compare.method, { versions: measuredVersions }) }}</p>
        <p class="links">
          <a class="link" :href="`${product.sourceUrl}/blob/main/scripts/bench-footprint.sh`">{{
            t.compare.runIt
          }}</a>
          <a v-for="source in sources" :key="source.url" class="link" :href="source.url">{{
            t.compare.sources[source.key]
          }}</a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-frame);
  background: var(--surface);
}

table {
  width: 100%;
  min-width: 760px;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 0.94rem;
}

th,
td {
  padding: 12px 18px;
  text-align: left;
  vertical-align: top;
  border-top: 1px solid var(--line-soft);
}

thead th {
  padding-block: 18px 14px;
  border-top: 0;
  color: var(--text-2);
  font-size: 0.86rem;
  font-weight: 600;
}

.label {
  width: 28%;
  font-weight: 400;
  color: var(--text);
}

.note {
  display: block;
  margin-top: 2px;
  color: var(--text-3);
  font-size: 0.8rem;
}

td {
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 0.88rem;
  font-variant-numeric: tabular-nums;
}

/* Words read better in the body face; figures keep the mono one so they line up. */
td.words {
  font-family: var(--font-body);
  font-size: 0.9rem;
}

/* The Unpanel column reads as one lit strip from header to last row. */
.us {
  background: var(--primary-tint);
  color: var(--primary);
}

td.us {
  font-weight: 600;
}

thead th.us {
  color: var(--primary);
  box-shadow: inset 0 2px 0 var(--primary);
}

.group th {
  padding: 22px 18px 8px;
  border-top: 1px solid var(--line);
  color: var(--text-3);
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

tbody:first-of-type .group th {
  border-top: 1px solid var(--line-soft);
}

.foot {
  display: grid;
  gap: 10px;
  max-width: 62rem;
  margin-top: 20px;
  color: var(--text-3);
  font-size: 0.88rem;
}

.foot p {
  margin: 0;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
}

/* On a phone each row becomes a small card: its name, then the four panels two by two. */
@media (max-width: 720px) {
  .table-wrap {
    overflow: visible;
  }

  table,
  tbody {
    display: block;
    min-width: 0;
  }

  thead {
    display: none;
  }

  tr {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    padding: 0 0 14px;
    border-top: 1px solid var(--line-soft);
  }

  tr.group {
    display: block;
    padding: 0;
  }

  .group th {
    display: block;
    padding: 18px 14px 6px;
  }

  th,
  td {
    border-top: 0;
  }

  .label {
    grid-column: 1 / -1;
    width: auto;
    padding: 12px 14px 8px;
  }

  td {
    margin-inline: 14px;
    padding: 7px 10px;
    border-radius: var(--r-control);
    background: var(--ink);
  }

  td:nth-of-type(odd) {
    margin-right: 0;
  }

  td:nth-of-type(even) {
    margin-left: 0;
  }

  td + td {
    margin-top: 0;
  }

  td::before {
    content: attr(data-panel);
    display: block;
    color: var(--text-3);
    font-family: var(--font-body);
    font-size: 0.72rem;
    font-weight: 600;
  }

  td.us::before {
    color: var(--primary);
  }

  tr {
    column-gap: 6px;
    row-gap: 6px;
  }
}
</style>
