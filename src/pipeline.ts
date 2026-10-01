import type { Docker } from "./docker.js";
import type { Host } from "./host.js";
import type { Log, Task } from "./log.js";
import type { SecretStores } from "./secrets/refs.js";
import type { Topology } from "./topology.js";
import type { Deployment } from "./types.js";

// Work addressed by where it runs, each step handed what the one before answered

// Each is also the name of the point its step sits at. No run walks all of them
export const PHASES = ["setup", "build", "verify", "swap", "cleanup"] as const;
export type Phase = (typeof PHASES)[number];

// A phase left out is not run, and a step hung on its slots never fires
export const RUNS = {
  deploy: ["setup", "build", "swap", "cleanup"],
  verify: ["setup", "build", "verify", "cleanup"],
} as const satisfies Record<string, readonly Phase[]>;

export type Run = keyof typeof RUNS;

// Everything before the phase's step, its own slot, then everything after
export const SLOTS = ["before", "main", "after"] as const;
export type Slot = (typeof SLOTS)[number];

// The bare phase is where redkite's own step sits, and a step there replaces it
export type Point = Phase | `${Phase}:${string}`;

// Every point but redkite's four; a hook takes and answers with one value
export type Hook = Exclude<Point, Phase>;

// Each phase adds to what it was handed, so a late step reads everything above

export type Start = {
  environment: string;
};

export type Prepared = Start & {
  network: string;
  // Every service's container, created by this run or adopted
  services: string[];
};

export type BuiltApp = {
  name: string;
  container: string;
  release: string;
  fingerprint: string;
  // The host already held this image, and nothing was rebuilt
  cached: boolean;
  // Holds the app's own toolchain, not only what it compiled to
  builderTag: string;
};

export type Built = Prepared & {
  apps: BuiltApp[];
};

export type Released = Built & {
  // False when health put every app back, or a verify check failed
  ok: boolean;
  released: string[];
  reverted: string[];
  // Only a verify fills this, but both runs answer with one shape
  checked: string[];
};

export type Finished = Released & {
  removed: string[];
  reclaimed: string[];
};

// What a step gets besides the value: the config, and the host
export type Context = {
  config: Deployment;
  environment: string;
  // The service set differs: nothing serves in a verify, so it has no proxy
  run: Run;
  topology: Topology;
  host: Host;
  docker: Docker;
  secrets: SecretStores;
  log: Log;
  // The row this step already has, rather than a second one beside it
  task: Task;
};

// Together these are what lets a step be typed by where it runs
type PhaseInput = {
  setup: Start;
  build: Prepared;
  verify: Built;
  swap: Built;
  cleanup: Released;
};

type PhaseOutput = {
  setup: Prepared;
  build: Built;
  verify: Released;
  swap: Released;
  cleanup: Finished;
};

type PhaseOf<P extends Point> = P extends Phase
  ? P
  : P extends `${infer F extends Phase}:${string}`
    ? F
    : never;

// Everything hung around a phase's step is handed what that side produced
export type InputAt<P extends Point> = P extends Phase
  ? PhaseInput[P]
  : P extends `${string}:before:${string}`
    ? PhaseInput[PhaseOf<P>]
    : PhaseOutput[PhaseOf<P>];

export type OutputAt<P extends Point> = P extends Phase
  ? PhaseOutput[P]
  : P extends `${string}:before:${string}`
    ? PhaseInput[PhaseOf<P>]
    : PhaseOutput[PhaseOf<P>];

// Before a run starts: the config as written and the environment asked for
export type Plan = {
  config: Deployment;
  environment: string;
};

// A property, since a method's parameter is bivariant and could narrow its input
export type Step<P extends Point = Point> = {
  point: P;
  // Run before the first step, while the host is still untouched
  check?: (plan: Plan) => void;
  run: (input: InputAt<P>, context: Context) => OutputAt<P> | Promise<OutputAt<P>>;
};

// Erased for storage: `never` is what every step's input accepts
export type AnyStep = {
  point: Point;
  check?: (plan: Plan) => void;
  run: (input: never, context: Context) => unknown;
};

// Pins the point, so a typo fails to compile and the input is inferred
export function defineStep<const P extends Point>(
  point: P,
  run: Step<P>["run"],
  check?: Step<P>["check"],
): Step<P> {
  return { point, run, check };
}

// A step at redkite's own point replaces it there, which is how one is turned off
export function merge(supplied: AnyStep[], added: AnyStep[]): AnyStep[] {
  const overrides = new Map(added.map((step) => [step.point, step]));
  const claimed = new Set(supplied.map((step) => step.point));

  return [
    ...supplied.map((step) => overrides.get(step.point) ?? step),
    ...added.filter((step) => !claimed.has(step.point)),
  ];
}

// Stops between steps, the unit that leaves a state the next deploy can read
export class Aborted extends Error {
  constructor(point: string) {
    super(`Stopped before ${point}`);
    this.name = "Aborted";
  }
}

export async function runPipeline(
  run: Run,
  steps: AnyStep[],
  setting: Omit<Context, "task">,
  signal?: AbortSignal,
): Promise<Finished> {
  const ordered = sequence(steps, RUNS[run]);
  const plan: Plan = { config: setting.config, environment: setting.environment };

  // Said before any of it runs; nothing depends on it being heard
  setting.log.plan?.(ordered.map((step) => step.point));

  // Every check before any step, so a config mistake creates nothing first
  for (const step of ordered) step.check?.(plan);

  // The whole run is a fold over one list
  let value: unknown = { environment: setting.environment } satisfies Start;

  for (const step of ordered) {
    if (signal?.aborted) throw new Aborted(step.point);

    const task = setting.log.step(step.point);

    // The declared types are the contract, and this is where they are trusted
    const run = step.run as (input: unknown, context: Context) => unknown;

    try {
      value = await run(value, { ...setting, task });
      task.done();
    } catch (error) {
      // One step throwing ends the run; everything after assumed it worked
      task.fail(`${step.point} failed`);
      throw new Error(`Step ${step.point} failed`, { cause: error });
    }
  }

  // Every run ends at cleanup, whose step answers with a Finished or will not compile
  return value as Finished;
}

// Redkite's own step leads its slot, because merge keeps the supplied list first
export function sequence(
  steps: AnyStep[],
  phases: readonly Phase[] = RUNS.deploy,
): AnyStep[] {
  const ordered: AnyStep[] = [];

  for (const phase of phases) {
    for (const slot of SLOTS) {
      ordered.push(...steps.filter((step) => runsAt(step, phase, slot)));
    }
  }

  return ordered;
}

function runsAt(step: AnyStep, phase: Phase, slot: Slot) {
  const address = addressOf(step.point);
  return address.phase === phase && address.slot === slot;
}

export type Address = { phase: Phase; slot: Slot; name: string };

// The names everything else derives, so a step reads like the keys beside it
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Points a config may still be written against, and what they became
const RENAMED: Record<string, Phase> = { deploy: "swap" };

export function addressOf(point: string): Address {
  const parts = point.split(":");
  const phase = parts[0];

  const renamed = phase ? RENAMED[phase] : undefined;
  if (renamed) {
    throw new Error(`${point} names the phase ${phase}, which is now ${renamed}`);
  }

  if (!phase || !isPhase(phase)) {
    throw new Error(`${point} names no phase, expected one of ${PHASES.join(", ")}`);
  }

  // The point redkite's own step sits at, and the one a deployment replaces
  if (parts.length === 1) return { phase, slot: "main", name: phase };

  if (parts.length === 2) return { phase, slot: "main", name: named(point, parts[1]) };

  if (parts.length !== 3) {
    throw new Error(
      `${point} is not a point, expected ${phase}, ${phase}:… or ${phase}:before|after:…`,
    );
  }

  const slot = parts[1];
  if (slot !== "before" && slot !== "after") {
    throw new Error(`${point} names no slot, expected ${phase}:before:… or ${phase}:after:…`);
  }

  return { phase, slot, name: named(point, parts[2]) };
}

// Checked where the config is defined, so a typo fails to load
export function assertSteps(steps: AnyStep[]) {
  const seen = new Set<string>();

  for (const step of steps) {
    addressOf(step.point);

    if (seen.has(step.point)) {
      throw new Error(`Two steps share the point ${step.point}`);
    }

    seen.add(step.point);
  }
}

function named(point: string, name: string | undefined) {
  if (name && NAME.test(name)) return name;
  throw new Error(`${point} needs a kebab-case name`);
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}
