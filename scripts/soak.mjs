/**
 * Phase 3's gate: sustain the agent event rate without unbounded memory over a
 * run that never ends.
 *
 * The workload is deliberately the pathological one. `acc = acc + item` is what
 * broke the DAG (one node per iteration, forever) and then broke the label map
 * after the depth cap fixed the DAG. A soak on an easy workload would pass
 * whether or not either bound existed.
 *
 * Measures the daemon's resident set from outside the process. Structure counts
 * are the thing being bounded, but RSS is what the gate is actually about — a
 * bounded DAG with a leaking buffer would still fail the run.
 *
 *   node scripts/soak.mjs [seconds]
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BINARY = join(
  ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "tracr-core.exe" : "tracr-core",
);
const SITES = join(ROOT, "crates", "core", "tests", "fixtures", "sites.json");

const SECONDS = Number(process.argv[2] ?? 60);
const SAMPLE_MS = 5_000;
/** Events per batch, and batches per second. Well past a real agent's rate. */
const BATCH = 500;
const BATCH_MS = 10;

/**
 * Growth allowed between the two halves of the run.
 *
 * Compared on the *peak* of each half, not the last sample: the OS trims a
 * process's working set whenever it feels like it — this run watched RSS fall
 * from 9 MB to 5 MB while still ingesting — and a trim near the end would hide
 * a real leak behind a flattering final number.
 */
const GROWTH_BUDGET = 1.15;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Resident set in KB. The OS is the only honest source for another process. */
const rss = async (pid) => {
  if (process.platform === "win32") {
    const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
    const match = /"([\d,. ]+) K"\s*$/m.exec(stdout.trim());
    return match ? Number(match[1].replace(/[^\d]/g, "")) : null;
  }
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  const match = /VmRSS:\s+(\d+) kB/.exec(status);
  return match ? Number(match[1]) : null;
};

const startDaemon = async (port) => {
  const child = spawn(BINARY, [`127.0.0.1:${port}`, SITES], { stdio: "pipe" });
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never listened")), 10_000);
    child.stderr.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        ready();
      }
    });
    child.once("exit", (code) => fail(new Error(`daemon exited with ${code}`)));
  });
  return child;
};

const { wsTransport } = await import(
  pathToFileURL(join(ROOT, "packages", "runtime", "dist", "transport-ws.js")).href
);

const port = await freePort();
const daemon = await startDaemon(port);

const transport = wsTransport({ url: `ws://127.0.0.1:${port}/agent` });
await transport.open({
  runId: 0,
  procId: 1,
  language: "javascript",
  platform: "browser",
  protocolVersion: 1,
});

// A viewer, because ticking is part of the steady-state cost.
const viewer = new WebSocket(`ws://127.0.0.1:${port}/`);
let framesSeen = 0;
viewer.addEventListener("message", () => {
  framesSeen += 1;
});
await new Promise((r) => viewer.addEventListener("open", r, { once: true }));

console.log(`soaking ${SECONDS}s at ~${(BATCH * 1000) / BATCH_MS} events/s\n`);

let label = 2;
let sent = 0;
const started = Date.now();
const samples = [];

// Origin once; every batch then extends the chain from the previous label.
transport.send([[0, 1, 1, 0]], 0);

const pump = setInterval(() => {
  const events = [];
  for (let i = 0; i < BATCH; i += 1) {
    events.push([1, 2, label + 1, 0, [label, 1]]);
    label += 1;
  }
  transport.send(events, 0);
  sent += events.length;
}, BATCH_MS);

const sampler = setInterval(async () => {
  const kb = await rss(daemon.pid);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  samples.push({ elapsed: Number(elapsed), kb });
  console.log(`  ${String(elapsed).padStart(4)}s  rss ${String(kb).padStart(8)} KB  sent ${sent}`);
}, SAMPLE_MS);

await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(pump);
clearInterval(sampler);

await transport.close();
viewer.close();
daemon.kill();

const usable = samples.filter((s) => s.kb !== null);
if (usable.length < 3) {
  console.error("\nnot enough samples to judge growth");
  process.exit(1);
}

const half = Math.floor(usable.length / 2);
const peak = (rows) => Math.max(...rows.map((r) => r.kb));
const firstHalf = peak(usable.slice(0, half));
const secondHalf = peak(usable.slice(half));
const ratio = secondHalf / firstHalf;

console.log(`\nevents sent    ${sent}`);
console.log(`ui frames      ${framesSeen}`);
console.log(`rss peak 1st   ${firstHalf} KB`);
console.log(`rss peak 2nd   ${secondHalf} KB`);
console.log(`rss final      ${usable[usable.length - 1].kb} KB`);
console.log(`growth         ${ratio.toFixed(3)}x  (budget ${GROWTH_BUDGET}x, peak vs peak)`);

if (ratio > GROWTH_BUDGET) {
  console.error("\nFAIL — peak memory still climbing in the second half of the run");
  process.exit(1);
}
console.log("\nPASS");
