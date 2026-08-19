# tracr

A code context tracer. Hooks into a local runtime, propagates data provenance through
execution, and renders a live node graph showing how data actually travels across an
application's files and functions.

Not a call-graph viewer, not an APM tracer. The differentiator is **value-level
provenance**: given a value at a sink, show the exact derivation chain back to its source.

Ships as a `devDependency` and compiles to nothing when disabled.

> **Status: pre-Phase-0.** The package layout, protocol types, and toolchain are in place.
> The transform itself is a visitor skeleton and the daemon does not run yet, so nothing is
> published to npm. See [Roadmap](#roadmap).

## Install

```sh
pnpm add -D @pablo_clueless/tracr
```

## Layout

```
packages/
  cli            @pablo_clueless/tracr — CLI, config, Node loader hook, spawns the daemon
  vite           @pablo_clueless/vite — Vite plugin, enforce: 'post'
  webpack        @pablo_clueless/webpack — Webpack loader
  babel-plugin   @pablo_clueless/babel-plugin — the transform itself
  runtime        @pablo_clueless/runtime — the $t runtime: interner, anchoring, ring buffer
  react          @pablo_clueless/react — adapter: hook shims, sources, sinks
  vue            @pablo_clueless/vue — adapter: sources, sinks
  protocol       @pablo_clueless/protocol — language-neutral wire contract
  ui             @pablo_clueless/ui — the graph UI (private, not published)
crates/
  core           tracr-core — the Rust daemon
examples/
  react-vite-app
  vue-vite-app
  express-api
```

The `tracr` command itself keeps its bare name; only the package it ships in is scoped.

## How it fits together

The transform is framework-agnostic — it sees `let`, binary ops, calls, returns. Adapters
exist because framework internals are uninstrumented frames, where the call-scoped taint
channel is dead and only object-anchored taint survives.

```
Browser (React/Vue)          Node (Express)
  Vite plugin                  module.register()
    └─ Babel transform           └─ Babel transform
         └─ runtime                   └─ runtime
         │                            │
         └──────────┬─────────────────┘
                    │ MessagePack
                    ▼
          tracr-core (Rust daemon)
            provenance DAG, static skeleton, aggregation
                    │ skeleton once, then deltas
                    ▼
          the graph UI
            zustand → graphology → layout worker → Cytoscape
```

Two invariants carry the whole design:

- **Untainted short-circuits.** Label `0` means untainted, and no operation may do work
  when every operand is `0`. Universal taint costs 10–100x; short-circuiting is what makes
  this shippable at 2–3x.
- **Topology is static.** The skeleton is parsed once; runtime is an overlay where edges
  light up and carry counts. A node per call makes the graph unrenderable in seconds.

## Development

Requires Node >= 20.19, pnpm 10, and a stable Rust toolchain.

```sh
pnpm install

pnpm build        # tsc -b across every package
pnpm typecheck    # includes the UI and all three examples
pnpm test
pnpm lint
pnpm format

pnpm core:build   # cargo build -p tracr-core
pnpm core:test
```

Run the UI and the example apps:

```sh
pnpm ui:dev           # the graph UI
pnpm example:express  # the Phase 0 gate app
pnpm example:react
pnpm example:vue
```

## Roadmap

Each phase has a gate that must hold before the next one starts.

| Phase         | Scope                                       | Gate                                                             |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| 0 — spike     | Babel plugin only, console-dump the DAG     | `req.body.name` → `db.query` chains _through_ Express middleware |
| 1 — agents    | Node loader hook, Vite plugin, transport    | Express under 5x baseline; HMR still under 500ms                 |
| 2 — adapters  | Vue first (no shims), then React hook shims | Typed input reaches a `fetch` body with provenance intact        |
| 3 — core      | Rust daemon owns the DAG and the skeleton   | Sustains agent event rate, bounded memory over 10 minutes        |
| 4 — UI        | graphology → worker → Cytoscape, ~2k cap    | Live updates without layout thrash under load                    |
| 5 — expansion | SWC port (Next.js) or a Go agent            | Zero changes needed in `crates/core` or the UI                   |

Deliberately out of scope for v1: async context propagation, full cross-process taint,
implicit flows, flamegraphs, time-travel replay, Vue template-line attribution, and
Next.js/Nuxt/SvelteKit/Angular.

## License

[License](./LICENSE)
