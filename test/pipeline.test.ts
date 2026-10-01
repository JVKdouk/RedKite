import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
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

// Asserts the order, the value each step sees, and that any can be replaced

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
    run: "deploy",
  };
}

// Stamps the value, so a hook can be shown to run between two of them
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
    defineStep("swap", (input) => {
      trace.push("swap");
      return { ...input, ok: true, released: ["web"], reverted: [], checked: [] };
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
      record(trace, "swap:before:announce"),
      record(trace, "setup:before:check"),
      record(trace, "setup:provision"),
      record(trace, "build:after:sourcemaps"),
      record(trace, "build:before:warm"),
      record(trace, "setup:after:seed"),
      record(trace, "swap:after:tag"),
      record(trace, "cleanup:before:drain"),
    ];

    await runPipeline("deploy", merge(supplied(trace), added), setting());

    assert.deepEqual(trace, [
      "setup:before:check",
      "setup",
      "setup:provision",
      "setup:after:seed",
      "build:before:warm",
      "build",
      "build:after:sourcemaps",
      "swap:before:announce",
      "swap",
      "swap:after:tag",
      "cleanup:before:drain",
      "cleanup",
      "cleanup:after:notify",
    ]);
  });

  it("keeps the order a slot's steps were written in", async () => {
    const trace: string[] = [];

    await runPipeline("deploy", 
      merge(supplied(trace), [
        record(trace, "swap:after:first"),
        record(trace, "swap:after:second"),
        record(trace, "swap:after:third"),
      ]),
      setting(),
    );

    assert.deepEqual(
      trace.filter((event) => event.startsWith("swap:after:")),
      ["swap:after:first", "swap:after:second", "swap:after:third"],
    );
  });
});

// Nothing makes redkite's four harder to displace than any other step
describe("a step at a point redkite already uses", () => {
  it("replaces it, where redkite had it", async () => {
    const trace: string[] = [];

    const steps = merge(supplied(trace), [
      defineStep("build", (input) => {
        trace.push("mine");
        return { ...input, apps: [] };
      }),
    ]);

    await runPipeline("deploy", steps, setting());

    assert.deepEqual(trace, ["setup", "mine", "swap", "cleanup"]);
  });

  it("is how one of redkite's is turned off", async () => {
    const trace: string[] = [];

    // A cleanup that reclaims nothing
    const steps = merge(supplied(trace), [
      defineStep("cleanup", (input) => ({ ...input, removed: [], reclaimed: [] })),
    ]);

    const result = await runPipeline("deploy", steps, setting());

    assert.ok(!trace.includes("cleanup"));
    assert.deepEqual(result.reclaimed, []);
  });

  it("leaves a point redkite does not use alone", () => {
    const trace: string[] = [];
    const mine = record(trace, "swap:after:notify");
    const points = sequence(merge(supplied(trace), [mine])).map((step) => step.point);

    assert.deepEqual(points, ["setup", "build", "swap", "swap:after:notify", "cleanup"]);
  });
});

// Said before the run touches anything, not once the images are built
describe("what a step checks before the run", () => {
  it("runs every check before the first step", async () => {
    const trace: string[] = [];
    const checked: AnyStep = {
      point: "cleanup:after:notify",
      check: () => trace.push("checked"),
      run: (input) => input,
    };

    await runPipeline("deploy", merge(supplied(trace), [checked]), setting());

    assert.equal(trace[0], "checked");
  });

  it("ends the run without having run a step", async () => {
    const trace: string[] = [];
    const broken: AnyStep = {
      point: "swap:before:migrate",
      check: () => {
        throw new Error("backend names no app in this deployment");
      },
      run: (input) => input,
    };

    await assert.rejects(
      () => runPipeline("deploy", merge(supplied(trace), [broken]), setting()),
      /names no app/,
    );

    assert.deepEqual(trace, []);
  });
});

describe("what a step is handed", () => {
  it("gives it what the step before it answered with", async () => {
    const seen: Released[] = [];

    const added: AnyStep[] = [
      defineStep("swap:after:one", (input) => ({ ...input, released: ["rewritten"] })),
      defineStep("swap:after:two", (input) => {
        seen.push(input);
        return input;
      }),
    ];

    await runPipeline("deploy", merge(supplied([]), added), setting());

    assert.deepEqual(seen[0]?.released, ["rewritten"]);
  });

  it("gives it everything the steps above it produced", async () => {
    const seen: Finished[] = [];

    const step = defineStep("cleanup:after:report", (input) => {
      seen.push(input);
      return input;
    });

    await runPipeline("deploy", merge(supplied([]), [step]), setting());

    // The value grows rather than being replaced, so the last step sees it all
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

    await runPipeline("deploy", merge(supplied([]), [step]), setting());

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
      () => runPipeline("deploy", merge(supplied(trace), added), setting()),
      /build:before:refuse/,
    );

    // Everything after assumed the steps before worked, so none of them ran
    assert.deepEqual(trace, ["setup"]);
  });

  it("keeps what actually failed reachable", async () => {
    const step = defineStep("cleanup:after:notify", () => {
      throw new Error("the webhook is down");
    });

    const error = await runPipeline("deploy", merge(supplied([]), [step]), setting()).catch(
      (e: unknown) => e,
    );

    assert.ok(error instanceof Error);
    assert.match(String((error.cause as Error).message), /the webhook is down/);
  });
});

// A stop unwinds through the failure path, so the scratch directory goes
describe("stopping a run", () => {
  it("stops before the next step rather than inside one", async () => {
    const trace: string[] = [];
    const stopping = new AbortController();

    const steps = merge(supplied(trace), [
      defineStep("build:after:stop", (input) => {
        stopping.abort();
        return input;
      }),
    ]);

    await assert.rejects(
      () => runPipeline("deploy", steps, setting(), stopping.signal),
      /Stopped before swap/,
    );

    assert.deepEqual(trace, ["setup", "build"], "and nothing after it ran");
  });

  it("runs everything when nothing asks it to stop", async () => {
    const trace: string[] = [];
    const stopping = new AbortController();

    await runPipeline("deploy", supplied(trace), setting(), stopping.signal);
    assert.deepEqual(trace, ["setup", "build", "swap", "cleanup"]);
  });
});

describe("a point that is not one", () => {
  it("names a phase that exists", () => {
    assert.throws(() => addressOf("provision:after:x"), /names no phase/);
    assert.throws(() => addressOf("provision"), /names no phase/);
  });

  // A config written against the old name is told what it became
  it("says what a phase that was renamed became", () => {
    assert.throws(() => addressOf("deploy:before:migrate"), /which is now swap/);
    assert.throws(() => addressOf("deploy"), /which is now swap/);
  });

  it("addresses redkite's own step by the phase alone", () => {
    assert.deepEqual(addressOf("build"), { phase: "build", slot: "main", name: "build" });
    assert.deepEqual(addressOf("swap:migrate"), {
      phase: "swap",
      slot: "main",
      name: "migrate",
    });
  });

  it("spells its slot", () => {
    assert.throws(() => addressOf("swap:around:x"), /names no slot/);
    assert.throws(() => addressOf("swap:after:x:y"), /is not a point/);
  });

  it("is named the way everything else redkite derives is", () => {
    assert.throws(() => addressOf("swap:after:"), /kebab-case/);
    assert.throws(() => addressOf("swap:after:Notify"), /kebab-case/);
    assert.equal(addressOf("swap:after:upload-sourcemaps").name, "upload-sourcemaps");
  });

  it("is refused twice over", () => {
    const steps = [
      defineStep("swap:after:notify", (input) => input),
      defineStep("swap:after:notify", (input) => input),
    ];

    assert.throws(() => assertSteps(steps), /Two steps share the point/);
  });
});
