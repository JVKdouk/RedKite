import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
import type { AnyStep, Context, Finished, Hook, Released } from "../src/index.js";
import {
  addressOf,
  assertSteps,
  defineStep,
  merge,
  runPipeline,
  sequence,
  silent,
  topologyFor,
  Docker,
} from "../src/index.js";
import { fakeHost } from "./fakes.js";

// A run is one list of steps, and redkite's four are ordinary members of it. What
// is asserted here is the order they run in, the value each one is handed, and
// that a deployment can put its own step where one of redkite's was.

function setting(): Omit<Context, "task"> {
  const host = fakeHost();

  return {
    config,
    environment: "staging",
    topology: topologyFor(config, "staging"),
    host: host.host,
    docker: new Docker(host.host),
    secrets: {},
    log: silent,
  };
}

// Stands in for redkite's four, stamping the value so a hook can be asserted to
// have run between two of them rather than merely to have run
function supplied(trace: string[]): AnyStep[] {
  return [
    defineStep("setup", (input) => {
      trace.push("setup");
      return { ...input, network: "net", services: ["redis"] };
    }),
    defineStep("build", (input) => {
      trace.push("build");
      return { ...input, apps: [] };
    }),
    defineStep("deploy", (input) => {
      trace.push("deploy");
      return { ...input, ok: true, released: ["web"], reverted: [] };
    }),
    defineStep("cleanup", (input) => {
      trace.push("cleanup");
      return { ...input, removed: [], reclaimed: [] };
    }),
  ];
}

const record = <P extends Hook>(trace: string[], point: P) =>
  defineStep(point, (input) => {
    trace.push(point);
    return input;
  });

describe("where a step runs", () => {
  it("hangs the added ones around the four redkite supplies", async () => {
    const trace: string[] = [];

    const added: AnyStep[] = [
      record(trace, "cleanup:after:notify"),
      record(trace, "deploy:before:announce"),
      record(trace, "setup:before:check"),
      record(trace, "setup:provision"),
      record(trace, "build:after:sourcemaps"),
      record(trace, "build:before:warm"),
      record(trace, "setup:after:seed"),
      record(trace, "deploy:after:tag"),
      record(trace, "cleanup:before:drain"),
    ];

    await runPipeline(merge(supplied(trace), added), setting());

    assert.deepEqual(trace, [
      "setup:before:check",
      "setup",
      "setup:provision",
      "setup:after:seed",
      "build:before:warm",
      "build",
      "build:after:sourcemaps",
      "deploy:before:announce",
      "deploy",
      "deploy:after:tag",
      "cleanup:before:drain",
      "cleanup",
      "cleanup:after:notify",
    ]);
  });

  it("keeps the order a slot's steps were written in", async () => {
    const trace: string[] = [];

    await runPipeline(
      merge(supplied(trace), [
        record(trace, "deploy:after:first"),
        record(trace, "deploy:after:second"),
        record(trace, "deploy:after:third"),
      ]),
      setting(),
    );

    assert.deepEqual(
      trace.filter((event) => event.startsWith("deploy:after:")),
      ["deploy:after:first", "deploy:after:second", "deploy:after:third"],
    );
  });
});

// Nothing about redkite's four makes them harder to displace than any other step
describe("a step at a point redkite already uses", () => {
  it("replaces it, where redkite had it", async () => {
    const trace: string[] = [];

    const steps = merge(supplied(trace), [
      defineStep("build", (input) => {
        trace.push("mine");
        return { ...input, apps: [] };
      }),
    ]);

    await runPipeline(steps, setting());

    assert.deepEqual(trace, ["setup", "mine", "deploy", "cleanup"]);
  });

  it("is how one of redkite's is turned off", async () => {
    const trace: string[] = [];

    // A cleanup that reclaims nothing, for a host somebody else prunes
    const steps = merge(supplied(trace), [
      defineStep("cleanup", (input) => ({ ...input, removed: [], reclaimed: [] })),
    ]);

    const result = await runPipeline(steps, setting());

    assert.ok(!trace.includes("cleanup"));
    assert.deepEqual(result.reclaimed, []);
  });

  it("leaves a point redkite does not use alone", () => {
    const trace: string[] = [];
    const mine = record(trace, "deploy:after:notify");
    const points = sequence(merge(supplied(trace), [mine])).map((step) => step.point);

    assert.deepEqual(points, ["setup", "build", "deploy", "deploy:after:notify", "cleanup"]);
  });
});

describe("what a step is handed", () => {
  it("gives it what the step before it answered with", async () => {
    const seen: Released[] = [];

    const added: AnyStep[] = [
      defineStep("deploy:after:one", (input) => ({ ...input, released: ["rewritten"] })),
      defineStep("deploy:after:two", (input) => {
        seen.push(input);
        return input;
      }),
    ];

    await runPipeline(merge(supplied([]), added), setting());

    assert.deepEqual(seen[0]?.released, ["rewritten"]);
  });

  it("gives it everything the steps above it produced", async () => {
    const seen: Finished[] = [];

    const step = defineStep("cleanup:after:report", (input) => {
      seen.push(input);
      return input;
    });

    await runPipeline(merge(supplied([]), [step]), setting());

    // The value grows rather than being replaced, so the last step still reads
    // the environment the run started with and the network setup brought up
    assert.equal(seen[0]?.environment, "staging");
    assert.equal(seen[0]?.network, "net");
    assert.equal(seen[0]?.ok, true);
  });

  it("gives it the project context and its own progress row", async () => {
    const seen: Context[] = [];

    const step = defineStep("setup:before:inspect", (input, context) => {
      seen.push(context);
      return input;
    });

    await runPipeline(merge(supplied([]), [step]), setting());

    assert.equal(seen[0]?.topology.network, "acme-staging-network");
    assert.equal(seen[0]?.config.project, "acme");
    assert.equal(typeof seen[0]?.task.detail, "function");
  });
});

describe("a step that throws", () => {
  it("ends the run", async () => {
    const trace: string[] = [];

    const added: AnyStep[] = [
      defineStep("build:before:refuse", () => {
        throw new Error("not today");
      }),
    ];

    await assert.rejects(
      () => runPipeline(merge(supplied(trace), added), setting()),
      /build:before:refuse/,
    );

    // Everything after it was written assuming the steps before did what they
    // said they would, so none of them ran
    assert.deepEqual(trace, ["setup"]);
  });

  it("keeps what actually failed reachable", async () => {
    const step = defineStep("cleanup:after:notify", () => {
      throw new Error("the webhook is down");
    });

    const error = await runPipeline(merge(supplied([]), [step]), setting()).catch(
      (e: unknown) => e,
    );

    assert.ok(error instanceof Error);
    assert.match(String((error.cause as Error).message), /the webhook is down/);
  });
});

// Checked where the config is defined, so a typo is a config that fails to load
// rather than a deploy that stops half way with the host already changed
describe("a point that is not one", () => {
  it("names a phase that exists", () => {
    assert.throws(() => addressOf("provision:after:x"), /names no phase/);
    assert.throws(() => addressOf("provision"), /names no phase/);
  });

  it("addresses redkite's own step by the phase alone", () => {
    assert.deepEqual(addressOf("build"), { phase: "build", slot: "main", name: "build" });
    assert.deepEqual(addressOf("deploy:migrate"), {
      phase: "deploy",
      slot: "main",
      name: "migrate",
    });
  });

  it("spells its slot", () => {
    assert.throws(() => addressOf("deploy:around:x"), /names no slot/);
    assert.throws(() => addressOf("deploy:after:x:y"), /is not a point/);
  });

  it("is named the way everything else redkite derives is", () => {
    assert.throws(() => addressOf("deploy:after:"), /kebab-case/);
    assert.throws(() => addressOf("deploy:after:Notify"), /kebab-case/);
    assert.equal(addressOf("deploy:after:upload-sourcemaps").name, "upload-sourcemaps");
  });

  it("is refused twice over", () => {
    const steps = [
      defineStep("deploy:after:notify", (input) => input),
      defineStep("deploy:after:notify", (input) => input),
    ];

    assert.throws(() => assertSteps(steps), /Two steps share the point/);
  });
});
