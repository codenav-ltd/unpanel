<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<!-- The mark from docs/design/08-frontend.md: a panel without its top wall, with the pulse inside. -->
<template>
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
    <path class="mark-u" d="M6 7v12a7 7 0 0 0 7 7h6a7 7 0 0 0 7-7V7" />
    <path class="mark-pulse" d="M10.5 17.5h3l1.8-5 2.6 8 1.8-4.5h2" />
  </svg>
</template>

<style scoped>
.mark {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mark-u {
  stroke: currentColor;
  stroke-width: 3;
}

.mark-pulse {
  stroke: var(--primary);
  stroke-width: 2.4;
}
</style>
