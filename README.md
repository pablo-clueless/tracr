# tracr

A code context tracer. Hooks into a local runtime, propagates data provenance through
execution, and renders a live node graph showing how data actually travels across an
application's files and functions.

Not a call-graph viewer, not an APM tracer. The differentiator is **value-level
provenance**: given a value at a sink, show the exact derivation chain back to its source.

Ships as a `devDependency` and compiles to nothing when disabled.

## Layout

```
packages/
  cli            tracr — CLI, config, Node loader hook, spawns the daemon
  vite           @tracr/vite — Vite plugin, enforce: 'post'
  webpack        @tracr/webpack — Webpack loader
  babel-plugin   @tracr/babel-plugin — the transform itself
  runtime        @tracr/runtime — the $t runtime: interner, anchoring, ring buffer
  react          @tracr/react — adapter: hook shims, sources, sinks
  vue            @tracr/vue — adapter: sources, sinks
  protocol       @tracr/protocol — language-neutral wire contract
  ui             @tracr/ui — the graph UI (private)
crates/
  core           tracr-core — the Rust daemon
examples/
  react-vite-app
  vue-vite-app
  express-api
```

## Development

```sh
pnpm add -D @pablo_clueless/tracr
```
