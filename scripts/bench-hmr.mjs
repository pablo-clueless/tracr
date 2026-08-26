/**
 * Phase 1 HMR gate: the Vite dev server must still turn an edit around in under
 * 500ms with the tracr plugin active.
 *
 * Measured from the moment the file is written to the moment the HMR update
 * lands on the client socket, so the watcher, both transforms and the module
 * graph invalidation are all inside the number. Runs the same app twice, with
 * and without the plugin, because an absolute budget alone hides a regression
 * that is really the machine being slow.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "examples", "vue-vite-app");
const TARGET = join(APP, "src", "App.vue");

const BUDGET_MS = 500;
const EDITS = 12;
const WARMUP = 3;
const SETTLE_MS = 400;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/** Resolves on the next HMR message the server pushes. */
const nextUpdate = (socket) =>
  new Promise((resolve, reject) => {
    const fail = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("no HMR update within 10s"));
    }, 10_000);

    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type !== "update" && payload.type !== "full-reload") return;
      clearTimeout(fail);
      socket.removeEventListener("message", onMessage);
      resolve(payload.type);
    };

    socket.addEventListener("message", onMessage);
  });

/**
 * Resolves once the server has sent `connected`, not merely once the socket is
 * open — an edit written before that is watched by nobody and the run stalls.
 */
const openClient = (port) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`, "vite-hmr");
    const fail = setTimeout(() => reject(new Error("HMR socket never connected")), 10_000);

    const onMessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload.type !== "connected") return;
      clearTimeout(fail);
      socket.removeEventListener("message", onMessage);
      resolve(socket);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", () => {
      clearTimeout(fail);
      reject(new Error("HMR socket errored"));
    });
  });

/** Chokidar misses writes that land before it has finished its initial scan. */
const watcherReady = (server) =>
  new Promise((resolve) => {
    const done = () => setTimeout(resolve, 300);
    server.watcher.once("ready", done);
    // Already ready: `ready` has fired and will not fire again.
    setTimeout(done, 2000);
  });

/**
 * Edits inside the `<script setup>` block so the change is real work for both
 * plugin-vue and the tracr transform, not a template-only fast path.
 *
 * It has to change *code*, not a comment: Vue strips comments when it compiles
 * the block, so a comment-only edit yields byte-identical output and Vite
 * rightly skips the update — the run then stalls waiting for a message that is
 * never coming.
 */
const editedSource = (original, n) =>
  original.replace('const name = ref("");', `const name = ref("bench${n}");`);

/**
 * A benchmark that silently measured an inactive plugin would report a lovely
 * number and mean nothing, so prove the transform is in the output.
 */
const assertInstrumented = (result) => {
  if (result?.code?.includes("installWebAgent") === true) return;
  throw new Error(
    "the rebuilt module carries no tracr boot import — the plugin is not " +
      "transforming, so the timing would be meaningless.",
  );
};

const measure = async (label, port, disable) => {
  process.env.TRACR_DISABLE = disable ? "1" : "";

  const original = await readFile(TARGET, "utf8");

  // vite is a dependency of the example, not of the workspace root.
  const fromApp = createRequire(join(APP, "noop.js"));
  const { createServer } = await import(pathToFileURL(fromApp.resolve("vite")).href);

  const server = await createServer({
    root: APP,
    logLevel: "silent",
    configFile: join(APP, "vite.config.ts"),
    // No `hmr.port`: that stands up a second ws server and the updates then
    // never reach a client attached to the http port.
    server: { port, strictPort: true },
  });

  await server.listen();
  const socket = await openClient(port);

  const samples = [];
  try {
    // Populate the module graph; an update on a module nobody asked for is free.
    await server.transformRequest("/src/main.ts");
    await server.transformRequest("/src/App.vue");
    await watcherReady(server);

    for (let i = 0; i < WARMUP + EDITS; i++) {
      const settled = nextUpdate(socket);
      const started = process.hrtime.bigint();

      await writeFile(TARGET, editedSource(original, i), "utf8");
      await settled;

      // The update message only says *what* changed; Vite transforms the module
      // when the client fetches it. Both transforms run here, so stopping the
      // clock at the notification would measure everything except tracr.
      // A browser does this refetch itself — this socket cannot.
      const rebuilt = await server.transformRequest("/src/App.vue");

      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      if (i >= WARMUP) samples.push(elapsed);

      if (!disable && i === 0) assertInstrumented(rebuilt);

      // Back-to-back writes get coalesced by the watcher into a single change
      // event, and the next iteration then waits for an update that was already
      // folded into the last one. Off the clock.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    }
  } finally {
    await writeFile(TARGET, original, "utf8");
    socket.close();
    await server.close();
  }

  const p50 = median(samples);
  const p95 = percentile(samples, 0.95);
  process.stdout.write(
    `${label.padEnd(20)} median ${p50.toFixed(1)}ms   p95 ${p95.toFixed(1)}ms\n`,
  );
  return { p50, p95 };
};

const main = async () => {
  process.stdout.write(`vue SFC edit -> HMR update, ${EDITS} edits\n\n`);

  const baseline = await measure("without plugin", 41901, true);
  const traced = await measure("with tracr", 41902, false);

  process.stdout.write(
    `\noverhead             ${(traced.p50 - baseline.p50).toFixed(1)}ms median  ` +
      `(budget ${BUDGET_MS}ms absolute)\n`,
  );

  if (traced.p50 > BUDGET_MS) {
    process.stdout.write(
      `\nFAIL: median ${traced.p50.toFixed(1)}ms exceeds the ${BUDGET_MS}ms budget\n`,
    );
    return 1;
  }

  process.stdout.write(`\nPASS\n`);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
