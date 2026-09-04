import config from "../test/deployment.js";
import { deploy, healthcheck, renderDockerfile, topologyFor } from "../src/index.js";
import { fakeHost } from "../test/fakes.js";

import { classify, ORIGINAL, reExecuted, type Op, type Scenario } from "./cache.js";

const topology = topologyFor(config, "staging");
const backend = config.apps.find((app) => app.name === "backend")!;
const front = topology.apps.find((app) => app.name === "frontend")!;
const back = topology.apps.find((app) => app.name === "backend")!;

const SCENARIOS: Scenario[] = [
  { name: "cold, nothing cached", changed: new Set(["stable", "clock", "commit", "source", "lockfile", "manifest"]) },
  { name: "source only", changed: new Set(["clock", "commit", "source"]) },
  { name: "lockfile changed", changed: new Set(["clock", "commit", "source", "lockfile"]) },
  { name: "same commit again", changed: new Set(["clock"]) },
];

function table(rows: (string | number)[][], head: string[]) {
  const all = [head, ...rows.map((row) => row.map(String))];
  const widths = head.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  const line = (row: string[]) =>
    row.map((cell, i) => String(cell).padEnd(widths[i]!)).join("  ");

  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of all.slice(1)) console.log(line(row));
}

// The rendered pipeline is the chain now, so this counts the instructions
// BuildKit would actually re-run rather than a model of them
function builderChain(): Op[] {
  const file = renderDockerfile(backend.build, {
    caches: back.caches,
    port: back.port,
    release: "abc1234",
    environment: "staging",
    envSecret: "backend-env-abc",
    fileSecrets: {},
  });

  // Only the builder, up to the runtime stage it feeds
  const lines = file.split("\n");
  const stages = lines.flatMap((line, index) => (line.startsWith("FROM ") ? [index] : []));
  const [start = 0, end = lines.length] = stages;

  return lines
    .slice(start, end)
    .filter((line) => /^(FROM|COPY|RUN|ENV|WORKDIR|ARG) /.test(line))
    .map((line) => ({ label: line, input: classify(line) }));
}

async function roundTrips(held: string[] = []) {
  const host = fakeHost({ existing: [front.container, back.container] });

  host.respond(front.container, '{"status":"ok"}');
  host.respond(back.container, '{"status":"up","redis":"up","database":"up"}');
  for (const image of held) host.images.add(image);

  await deploy({
    config,
    environment: "staging",
    host: host.host,
    secrets: { bitwarden: { read: async () => "DATABASE_URL=postgres://u:p@h:5432/d\n" } },
    health: { sleep: async () => {} },
  });

  return {
    // What a repeat deploy of the same commit would find already there
    images: [...host.images],
    commands: host.commands.length,
    inspects: host.commands.filter((c) => c.includes("docker inspect")).length,
    // Nothing is serialised or moved: the image is built where it is run
    transfers: host.commands.filter((c) => /^(load|save|push) /.test(c)).length,
    builds: host.commands.filter(
      (c) => c.startsWith("build ") && config.apps.some((app) => c.includes(`/${app.name}.Dockerfile`)),
    ).length,
  };
}

async function healthWait(readyOnAttempt: number, spec: typeof backend.health) {
  let waited = 0;
  let attempt = 0;

  await healthcheck("app", 3001, spec, {
    probe: async () => {
      attempt += 1;
      return attempt >= readyOnAttempt
        ? { code: 0, output: '{"status":"up","redis":"up","database":"up"}' }
        : { code: 7, output: "" };
    },
    sleep: async (ms) => { waited += ms; },
  });

  return waited;
}

console.log("Builder instructions re-executed per deploy, backend\n");
const chain = builderChain();
table(
  SCENARIOS.map((scenario) => [
    scenario.name,
    `${reExecuted(ORIGINAL, scenario)} / ${ORIGINAL.length}`,
    `${reExecuted(chain, scenario)} / ${chain.length}`,
  ]),
  ["scenario", "original", "redkite"],
);

console.log("\nHost round trips, two app deployment\n");
const cold = await roundTrips();
const warm = await roundTrips(cold.images);
table(
  [
    ["new commit", 62, cold.commands],
    ["commit already on host", 62, warm.commands],
    ["of which per-object inspects", 31, cold.inspects],
    ["app image transfers", 2, cold.transfers],
    ["app builds", 2, `${cold.builds} new, ${warm.builds} repeat`],
  ],
  ["measure", "original", "redkite"],
);

console.log("\nHealth check wall clock, milliseconds waited\n");
const OLD = { ...backend.health, retries: 5, intervalMs: 5000, delayMs: 10_000 };
table(
  await Promise.all(
    [1, 2, 4, 5].map(async (ready) => [
      `ready on probe ${ready}`,
      await healthWait(ready, OLD),
      await healthWait(ready, backend.health),
    ]),
  ),
  ["scenario", "original", "redkite"],
);

console.log(`
What these numbers are
----------------------
Re-executed instructions and round trips are counted, not estimated. The chain
for redkite is read off the Dockerfile it actually renders; the original is
transcribed from the hand-written pipeline it replaced. Health figures are the
loop's own arithmetic.

Cache behaviour is modelled the way BuildKit works: the first instruction whose
input changed re-runs, and so does everything below it.

What they are not
-----------------
Seconds. How long an apk add, a yarn install, an image transfer or a Bitwarden
CLI install actually take depends on the machine, the network and the image
size, and none of those exist in this proof of concept. The counts say how
often that work happens, not what it costs when it does.

The largest wins are therefore invisible here. The image is now built inside the
daemon that runs it, so the export, the tarball and the transfer stop existing,
and that was the single largest cost in a deploy. The Bitwarden CLI is a local
process rather than a container it was installed into on every run. And the
original set CACHE_BUST to Date.now() as its fourth operation, which is why its
floor is 20 of 23 operations no matter what changed.
`);
