<script setup lang="ts">
const route = useRoute();
const runtimeReady = useCadenzaRuntimeReady();
</script>

<template>
  <div class="app-shell">
    <div class="app-shell__backdrop" />
    <header class="topbar">
      <NuxtLink class="topbar__brand" to="/">
        <span class="topbar__eyebrow">Cadenza Demo 2</span>
        <span class="topbar__title">Fleet Operations Console</span>
      </NuxtLink>
      <nav class="topbar__nav">
        <NuxtLink
          class="topbar__link"
          :class="{ 'topbar__link--active': route.path === '/' }"
          to="/"
        >
          Fleet
        </NuxtLink>
        <span class="topbar__status" :class="{ 'topbar__status--live': runtimeReady }">
          {{ runtimeReady ? "browser runtime live" : "hydrating runtime" }}
        </span>
      </nav>
    </header>
    <main class="page-shell">
      <NuxtPage />
    </main>
  </div>
</template>
