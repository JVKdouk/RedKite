import { silent, type Log } from "./log.js";
import type { HealthSpec } from "./types.js";

const RETRIES = 10;
// Ceiling for the backoff, not a fixed wait
const INTERVAL_MS = 5000;
// The first probe is free, a container that is already up answers it
const DELAY_MS = 0;
const FIRST_BACKOFF_MS = 250;

export type Probe = (
  container: string,
  url: string,
) => Promise<{ code: number; output: string }>;

export type HealthDeps = {
  probe: Probe;
  sleep: (ms: number) => Promise<void>;
  log?: Log;
};

// One loop for every app. The two copies it replaces had already drifted: the
// frontend never incremented its counter on a failed predicate, so a container
// that answered but never became healthy span until the deploy was killed.
export async function healthcheck(
  container: string,
  port: number,
  spec: HealthSpec,
  deps: HealthDeps,
): Promise<boolean> {
  const retries = spec.retries ?? RETRIES;
  const ceiling = spec.intervalMs ?? INTERVAL_MS;
  const log = deps.log ?? silent;
  const delay = spec.delayMs ?? DELAY_MS;

  if (delay > 0) await deps.sleep(delay);

  let backoff = FIRST_BACKOFF_MS;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const url = `localhost:${port}${spec.path}`;
    const { code, output } = await deps.probe(container, url);

    if (code === 0 && passes(spec, output, log, container)) {
      log.done(`${container} is healthy`);
      return true;
    }

    if (attempt === retries) break;

    // Doubling from a quarter second means a container that starts quickly
    // costs almost nothing, and one that does not still gets the same budget
    await deps.sleep(backoff);
    backoff = Math.min(backoff * 2, ceiling);
  }

  log.fail(`${container} failed its health check after ${retries} attempts`);
  return false;
}

// A body that parses but fails the predicate is a retry, not a verdict. The
// container may still be warming up, and the caller has a retry budget for it
function passes(
  spec: HealthSpec,
  output: string,
  log: Log,
  container: string,
) {
  let body: unknown;

  try {
    body = JSON.parse(output);
  } catch {
    log.warn(`${container} returned a body that is not JSON: ${output}`);
    return false;
  }

  if (typeof body !== "object" || body === null) return false;
  if (spec.expect(body as Record<string, unknown>)) return true;

  log.warn(`${container} is not healthy yet: ${output}`);
  return false;
}
