import type { SinkSpec, SourceSpec, TracrAdapter } from "@tracr/protocol";

const sources: SourceSpec[] = [{ id: "vue.input.value", module: "*", path: "event.target.value" }];

const sinks: SinkSpec[] = [
  { id: "fetch.body", module: "*", path: "fetch", args: [1] },
  { id: "vue.vHtml", module: "vue", path: "v-html" },
];

/**
 * No shims. `ref()` returns a RefImpl and `reactive()` returns a Proxy, so both
 * are objects the WeakMap can anchor, and taint survives Vue's internals for
 * free. Props objects too.
 */
export const vueAdapter: TracrAdapter = {
  name: "vue",
  sources,
  sinks,
};

export default vueAdapter;
