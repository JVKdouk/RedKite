import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import { healthcheck, type HealthDeps, type Task } from "../src/index.js";

const backend = config.apps.find((app) => app.name === "backend")!;
const frontend = config.apps.find((app) => app.name === "frontend")!;

// Records what the loop asked for, so a test can assert on the number of
// attempts rather than only on the verdict
function harness(responses: { code: number; output: string }[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];

  const deps: HealthDeps = {
    probe: async (container, url) => {
      calls.push(url);
      return responses[Math.min(calls.length - 1, responses.length - 1)]!;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      // A loop that never terminates would spin here forever in production,
      // so the harness turns that into a failure the test can see
      if (sleeps.length > 50) throw new Error("health loop did not terminate");
    },
  };

  return {
    deps,
    calls: () => calls,
    sleeps: () => sleeps,
    waited: () => sleeps.reduce((total, ms) => total + ms, 0),
  };
}

const up = { code: 0, output: '{"status":"up","redis":"up","database":"up"}' };
const degraded = { code: 0, output: '{"status":"up","redis":"down","database":"up"}' };
const refused = { code: 7, output: "connection refused" };
const garbage = { code: 0, output: "<html>502 Bad Gateway</html>" };

describe("health loop", () => {
  it("passes as soon as the predicate is satisfied", async () => {
    const { deps, calls } = harness([up]);
    const ok = await healthcheck("backend", 3001, { ...backend.health, delayMs: 0 }, deps);

    assert.equal(ok, true);
    assert.equal(calls().length, 1);
    assert.deepEqual(calls(), ["localhost:3001/health"]);
  });

  it("costs nothing at all when the container is already up", async () => {
    const { deps, waited } = harness([up]);
    await healthcheck("backend", 3001, backend.health, deps);

    // The first probe is free. A flat initial delay charged every deploy ten
    // seconds per app whether or not anything was wrong
    assert.equal(waited(), 0);
  });

  it("backs off, doubling up to the ceiling", async () => {
    const { deps, sleeps } = harness([refused]);
    await healthcheck("backend", 3001, { ...backend.health, intervalMs: 2000 }, deps);

    assert.deepEqual(sleeps(), [250, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000]);
  });

  it("reaches a slow container sooner than a fixed interval would", async () => {
    // Ready on the fourth probe, which the old loop met at 10s + 3 x 5s
    const { deps, waited } = harness([refused, refused, refused, up]);
    const ok = await healthcheck("backend", 3001, backend.health, deps);

    assert.equal(ok, true);
    assert.equal(waited(), 250 + 500 + 1000);
  });

  it("retries a container that is still starting, then passes", async () => {
    const { deps, calls } = harness([refused, refused, up]);
    const ok = await healthcheck("backend", 3001, { ...backend.health, delayMs: 0 }, deps);

    assert.equal(ok, true);
    assert.equal(calls().length, 3);
  });

  // The two implementations this replaces disagreed here, and the frontend one
  // never incremented its counter, so a container stuck in this state span
  it("gives up on a body that answers but never becomes healthy", async () => {
    const { deps, calls } = harness([degraded]);
    const ok = await healthcheck("backend", 3001, { ...backend.health, delayMs: 0 }, deps);

    assert.equal(ok, false);
    assert.equal(calls().length, 10); // the default retry budget
  });

  it("does the same for the frontend, which used to spin forever", async () => {
    const notReady = { code: 0, output: '{"status":"starting"}' };
    const { deps, calls } = harness([notReady]);
    const ok = await healthcheck("frontend", 3000, { ...frontend.health, delayMs: 0 }, deps);

    assert.equal(ok, false);
    assert.equal(calls().length, 10);
  });

  it("treats a non-JSON body as a failure rather than throwing", async () => {
    const { deps } = harness([garbage]);
    const ok = await healthcheck("frontend", 3000, { ...frontend.health, delayMs: 0, retries: 2 }, deps);

    assert.equal(ok, false);
  });

  it("uses each app's own predicate", async () => {
    const { deps } = harness([{ code: 0, output: '{"status":"ok"}' }]);

    assert.equal(
      await healthcheck("frontend", 3000, { ...frontend.health, delayMs: 0 }, deps),
      true,
    );

    const { deps: other } = harness([{ code: 0, output: '{"status":"ok"}' }]);

    // The same body must not satisfy the backend, which requires three fields
    assert.equal(
      await healthcheck("backend", 3001, { ...backend.health, delayMs: 0, retries: 1 }, other),
      false,
    );
  });
});

// A check that gave up is read for what the container said each time, so every
// attempt lands on the step rather than only the verdict
describe("what a health check says on its step", () => {
  function reported() {
    const said: string[] = [];

    const task = {
      detail: (message: string) => {
        said.push(`· ${message}`);
      },
      line: (message: string) => {
        said.push(`| ${message}`);
      },
      done: (message?: string) => {
        said.push(`done ${message ?? ""}`);
      },
      fail: (message: string) => {
        said.push(`failed ${message}`);
      },
    } satisfies Task;

    return { task, said };
  }

  it("says every attempt that did not pass, with what came back", async () => {
    const { deps } = harness([refused, garbage, degraded, up]);
    const { task, said } = reported();

    await healthcheck("backend", 3001, { ...backend.health, delayMs: 0 }, { ...deps, task });

    assert.deepEqual(said, [
      "· probing backend at localhost:3001/health",
      "· attempt 1 of 10: no answer on localhost:3001/health",
      "· attempt 2 of 10: answered with something that is not JSON: <html>502 Bad Gateway</html>",
      `· attempt 3 of 10: not healthy yet: ${degraded.output}`,
      "done backend healthy after 4 attempts",
    ]);
  });

  it("ends the step failed, saying how many attempts it made", async () => {
    const { deps } = harness([garbage]);
    const { task, said } = reported();

    await healthcheck("frontend", 3000, { ...frontend.health, delayMs: 0, retries: 2 }, { ...deps, task });

    assert.equal(said.at(-1), "failed frontend unhealthy after 2 attempts");
  });

  it("says one attempt, not attempts, when the first answer passes", async () => {
    const { deps } = harness([up]);
    const { task, said } = reported();

    await healthcheck("backend", 3001, { ...backend.health, delayMs: 0 }, { ...deps, task });

    assert.equal(said.at(-1), "done backend healthy after 1 attempt");
  });
});
