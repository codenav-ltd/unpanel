<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 CodeNav Ltd and contributors -->
<script setup lang="ts">
import { provide } from "vue";
import { localeKey, locales, type Locale } from "./i18n";
import CompareSection from "./components/CompareSection.vue";
import ConnectSection from "./components/ConnectSection.vue";
import FaqSection from "./components/FaqSection.vue";
import FootprintSection from "./components/FootprintSection.vue";
import HeroSection from "./components/HeroSection.vue";
import InstallSection from "./components/InstallSection.vue";
import PricingSection from "./components/PricingSection.vue";
import ProductTour from "./components/ProductTour.vue";
import PulseDivider from "./components/PulseDivider.vue";
import RoadmapSection from "./components/RoadmapSection.vue";
import SecuritySection from "./components/SecuritySection.vue";
import SiteFooter from "./components/SiteFooter.vue";
import SiteNav from "./components/SiteNav.vue";
import UpdatesSection from "./components/UpdatesSection.vue";

const props = defineProps<{ locale: Locale }>();
provide(localeKey, { locale: props.locale, t: locales[props.locale].messages });
</script>

<template>
  <SiteNav />
  <main>
    <HeroSection />
    <ProductTour />
    <FootprintSection />
    <PulseDivider :seed="11" />
    <ConnectSection />
    <SecuritySection />
    <UpdatesSection />
    <CompareSection />
    <PulseDivider :seed="23" />
    <RoadmapSection />
    <PricingSection />
    <FaqSection />
    <InstallSection />
  </main>
  <SiteFooter />
</template>
