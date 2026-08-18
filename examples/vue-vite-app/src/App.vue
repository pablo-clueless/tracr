<script setup lang="ts">
import { ref } from "vue";

// ref() returns a RefImpl, so the WeakMap anchors the label and it survives
// Vue's internals without a shim.
const name = ref("");

const search = async () => {
  const term = name.value.trim().toLowerCase();
  await fetch("/users/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: term }),
  });
};
</script>

<template>
  <div>
    <h1>tracr vue example</h1>
    <input v-model="name" placeholder="name" />
    <button @click="search">search</button>
  </div>
</template>
