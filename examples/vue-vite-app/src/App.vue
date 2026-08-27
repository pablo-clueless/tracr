<script setup lang="ts">
import { ref } from "vue";

import type { User } from "./types";

// ref() returns a RefImpl, so the WeakMap anchors the label and it survives
// Vue's internals without a shim.
const users = ref<User[]>([]);
const name = ref("");

const fetchUsers = async () => {
  const response = await fetch("https://jsonplaceholder.typicode.com/users");
  if (!response.ok) throw new Error(response.statusText);
  const users = await response.json();
  users.value = users;
};

fetchUsers();

/**
 * Deliberately not `v-model`.
 *
 * `v-model` compiles to a handler that receives the already-unwrapped string:
 * the `vModelText` directive reads `el.value` inside Vue's own uninstrumented
 * runtime and passes it on. So there is no `.target.value` read left in
 * instrumented code for the declared source to match, and a primitive crossing
 * an uninstrumented frame has nothing for the WeakMap to anchor to.
 *
 * An explicit handler keeps the read where the transform can see it. Restoring
 * `v-model` needs a shim on the directive — the same problem React's hooks have.
 */
const onInput = (event: Event) => {
  name.value = (event.target as HTMLInputElement).value;
};

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
    <input :value="name" placeholder="name" @input="onInput" />
    <button @click="search">search</button>
  </div>
  <div>
    <div v-for="user in users" :key="user.id">
      <p>{{ user.name }}</p>
    </div>
  </div>
</template>
