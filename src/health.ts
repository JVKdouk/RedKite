import { silent, type Task } from "./log.js";
import type { HealthSpec } from "./types.js";

const RETRIES = 10;
// Ceiling for the backoff, not a fixed wait
const INTERVAL_MS = 5000;
// The first probe is free, for a container that is already up
const DELAY_MS = 0;
const FIRST_BACKOFF_MS = 250;

export type Probe = (
  container: string,
  url: string,
) => Promise<{ code: number; output: string }>;

export type HealthDeps = {
  probe: Probe;
  sleep: (ms: number) => Promise<void>;
  // Every attempt is said on it, so a failed check shows each answer
  task?: Task;
};

// One loop for every app; the two copies it replaced had drifted
export async function healthcheck(
  container: string,
  port: number,
  spec: HealthSpec,
  deps: HealthDeps,
): Promise<boolean> {
  const retries = spec.retries ?? RETRIES;
  const ceiling = spec.intervalMs ?? INTERVAL_MS;
  const task = deps.task ?? silent.step("");
  const delay = spec.delayMs ?? DELAY_MS;
  const url = `localhost:${port}${spec.path}`;

  task.detail(`probing ${container} at ${url}`);
  if (delay > 0) await deps.sleep(delay);

  let backoff = FIRST_BACKOFF_MS;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const { code, output } = await deps.probe(container, url);
    const said = (message: string) => task.detail(`attempt ${attempt} of ${retries}: ${message}`);

    if (code === 0 && passes(spec, output, said)) {
      task.done(`${container} healthy after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}`);
      return true;
    }

    // Nothing answered: still starting, or listening somewhere else
    if (code !== 0) said(`no answer on ${url}`);

    if (attempt === retries) break;

    // Doubling from a quarter second, so a fast start costs almost nothing
    await deps.sleep(backoff);
    backoff = Math.min(backoff * 2, ceiling);
  }

  task.fail(`${container} unhealthy after ${retries} attempts`);
  return false;
}

// A body that parses but fails the predicate is a retry, not a verdict
function passes(spec: HealthSpec, output: string, said: (message: string) => void) {
  let body: unknown;

  try {
    body = JSON.parse(output);
  } catch {
    said(`answered with something that is not JSON: ${output}`);
    return false;
  }

  if (typeof body !== "object" || body === null) {
    said(`answered with JSON that is not an object: ${output}`);
    return false;
  }

  if (spec.expect(body as Record<string, unknown>)) return true;

  said(`not healthy yet: ${output}`);
  return false;
}
