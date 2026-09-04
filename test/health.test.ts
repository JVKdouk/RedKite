import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import { healthcheck, type HealthDeps } from "../src/index.js";

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
