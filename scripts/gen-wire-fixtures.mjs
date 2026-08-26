/**
 * Emits wire fixtures from the *JavaScript* encoder for the Rust core to decode.
 *
 * A protocol shared by two independent implementations is only verified when
 * bytes cross the boundary. Round-tripping each side against itself proves they
 * are each self-consistent and says nothing about whether they agree.
 *
 * Values are chosen to walk MessagePack's width boundaries — fixint, uint8,
 * uint16, uint32 — because those are where a hand-rolled encoder and a library
 * decoder are most likely to part ways.
 *
 *   node scripts/gen-wire-fixtures.mjs
 *
 * Regenerate after any protocol change and commit the result; the Rust test
 * asserts the exact decoded values, so a drift in either direction fails.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "crates", "core", "tests", "fixtures");

const require = createRequire(join(HERE, "..", "packages", "runtime", "noop.js"));
const runtime = await import(pathToFileURL(require.resolve("@pablo_clueless/runtime")).href);
const { encodeBatch, encodeHello, frameStream } = runtime;

const EventTag = { Origin: 0, Combine: 1, Flow: 2, Sink: 3, Dropped: 4 };

const hello = {
  protocolVersion: 1,
  runId: 0,
  procId: 4242,
  language: "javascript",
  platform: "node",
};

/** One of every event, at widths that cross each encoding boundary. */
const events = [
  [EventTag.Origin, 1, 1, 0],
  [EventTag.Combine, 200, 2, 3, [1]],
  [EventTag.Combine, 70000, 3, 8, [1, 2]],
  [EventTag.Flow, 5, 65535, 3],
  [EventTag.Sink, 300, 3, 7],
  [EventTag.Dropped, 4294967295],
];

const files = {
  // A hello frame on its own.
  "hello.bin": encodeHello(hello),
  // A batch carrying one of each event kind.
  "batch.bin": encodeBatch(events, 0),
  // A batch that carries only a drop count: the agent lost data and said so.
  "dropped-only.bin": encodeBatch([], 9001),
  // Enough events to push the array header past fixarray into array16.
  "large.bin": encodeBatch(
    Array.from({ length: 300 }, (_, i) => [EventTag.Origin, i + 1, i + 1, 0]),
    0,
  ),
  // Two frames back to back with stream length prefixes, for the reassembler.
  "stream.bin": Buffer.concat([
    Buffer.from(frameStream(encodeHello(hello))),
    Buffer.from(frameStream(encodeBatch(events, 0))),
  ]),
};

await mkdir(OUT, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(join(OUT, name), Buffer.from(bytes));
  process.stdout.write(`${name.padEnd(18)} ${Buffer.from(bytes).length} bytes\n`);
}
