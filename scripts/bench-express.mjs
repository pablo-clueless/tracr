/**
 * Phase 1 latency gate: an instrumented Express app must stay under 5x baseline
 * on an *untainted* route.
 *
 * The route matters. `/health` touches no declared source, so every label is 0
 * and the runtime's short-circuits carry the whole cost. If any operation does
 * work when all operands are untainted, the performance thesis collapses and it
 * shows up here first.
 *
 * Requests are sequential on purpose — this measures latency, not throughput.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "examples", "express-api");

const BUDGET = 5;
const REQUESTS = 1500;
const WARMUP = 300;

const ENTRY = ["--experimental-strip-types", "src/server.ts"];
const REGISTER = ["--import", "@pablo_clueless/tracr/register"];

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const stats = (times) => {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
  };
};

const startServer = (args, port, debug = false) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: APP,
      env: { ...process.env, PORT: String(port), TRACR_DEBUG: debug ? "1" : "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const fail = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start within 30s: ${args.join(" ")}`));
    }, 30_000);

    let err = "";
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
      child.stderrText = err;
    });
    child.stderrText = "";
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(fail);
        resolve(child);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(fail);
      reject(new Error(`server exited with ${code}\n${err}`));
    });
  });

const stop = (child) =>
  new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });

const hit = async (port) => {
  const started = process.hrtime.bigint();
  const response = await fetch(`http://localhost:${port}/health`);
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`/health returned ${response.status}`);
  return Number(process.hrtime.bigint() - started) / 1e6;
};

/**
 * A benchmark that silently measured uninstrumented code would report a
 * beautiful ratio and mean nothing, so prove the transform is live before
 * trusting the numbers. The tainted route is hit once, off the measured path.
 */
const assertInstrumented = async (child, port) => {
  const response = await fetch(`http://localhost:${port}/users/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "  BENCH  " }),
  });
  await response.arrayBuffer();

  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!child.stderrText.includes("origin express.body")) {
    throw new Error(
      "instrumented run produced no derivation chain — the loader is not " +
        `transforming, so the ratio would be meaningless.\n${child.stderrText}`,
    );
  }
};

const measure = async (label, args, port, { verify = false } = {}) => {
  const child = await startServer(args, port, verify);
  try {
    if (verify) await assertInstrumented(child, port);
    for (let i = 0; i < WARMUP; i++) await hit(port);
    const times = [];
    for (let i = 0; i < REQUESTS; i++) times.push(await hit(port));
    const result = stats(times);
    process.stdout.write(
      `${label.padEnd(14)} p50 ${result.p50.toFixed(3)}ms  ` +
        `p95 ${result.p95.toFixed(3)}ms  p99 ${result.p99.toFixed(3)}ms\n`,
    );
    return result;
  } finally {
    await stop(child);
  }
};

const main = async () => {
  process.stdout.write(`untainted route, ${REQUESTS} sequential requests\n\n`);

  const baseline = await measure("baseline", ENTRY, 41801);
  const traced = await measure("instrumented", [...REGISTER, ...ENTRY], 41802, { verify: true });

  const p50 = traced.p50 / baseline.p50;
  const p95 = traced.p95 / baseline.p95;

  process.stdout.write(
    `\nratio          p50 ${p50.toFixed(2)}x  p95 ${p95.toFixed(2)}x  (budget ${BUDGET}x)\n`,
  );

  if (p50 > BUDGET) {
    process.stdout.write(`\nFAIL: p50 ${p50.toFixed(2)}x exceeds the ${BUDGET}x budget\n`);
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
