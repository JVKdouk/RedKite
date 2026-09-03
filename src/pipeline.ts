import type { Docker } from "./docker.js";
import type { Host } from "./host.js";
import type { Log, Task } from "./log.js";
import type { SecretStores } from "./secrets/refs.js";
import type { Topology } from "./topology.js";
import type { Deployment } from "./types.js";

// Capistrano's shape: work addressed by where it runs rather than by who calls
// it, so a plugin or a config adds a step without any file here knowing it
// exists. A run is a list of steps, each handed what the one before it answered
// with. Redkite's own four are ordinary members of that list.

// The phases a run walks, in the order it walks them. Each is a step redkite
// supplies, and the name of the point that step sits at
export const PHASES = ["setup", "build", "swap", "cleanup"] as const;
export type Phase = (typeof PHASES)[number];

// Everything before the phase's own step, the phase's own slot, everything after
export const SLOTS = ["before", "main", "after"] as const;
export type Slot = (typeof SLOTS)[number];

// Where a step runs. The bare phase is the point redkite's own step sits at, and a
// deployment that puts its own step there replaces it: nothing about redkite's
// four makes them harder to displace than any other step
export type Point = Phase | `${Phase}:${string}`;

// Every point but the four redkite's own steps sit at. A hook is handed and
// answers with one value, which is what lets a helper be written over all of
// them at once
export type Hook = Exclude<Point, Phase>;

// What a run has done so far. Each phase adds to what it was handed rather than
// replacing it, so a step late in the pipeline reads everything above it

export type Start = {
  environment: string;
};

export type Prepared = Start & {
  network: string;
  // Every service's container, whether this run created it or adopted one
  services: string[];
};

export type BuiltApp = {
  name: string;
  container: string;
  release: string;
  fingerprint: string;
  // The host already held this image, and nothing was rebuilt
  cached: boolean;
  // The image a step hung before the swap runs in, for an app that kept one
  builderTag?: string;
};

export type Built = Prepared & {
  apps: BuiltApp[];
};

export type Released = Built & {
  // False when an app failed its health check and every app was put back
  ok: boolean;
  released: string[];
  reverted: string[];
};

export type Finished = Released & {
  removed: string[];
  reclaimed: string[];
};

// Everything a step is given besides the value: what is being deployed, and the
// machine it is being deployed to
export type Context = {
  config: Deployment;
  environment: string;
  topology: Topology;
  host: Host;
  docker: Docker;
  secrets: SecretStores;
  log: Log;
  // The progress row this step already has. A step says what it is doing
  // through this rather than opening a second one beside it
  task: Task;
};

// What a phase's step is handed, and what it answers with. The two together are
// the only reason a step can be typed by where it runs
type PhaseInput = {
  setup: Start;
  build: Prepared;
  swap: Built;
  cleanup: Released;
};

type PhaseOutput = {
  setup: Prepared;
  build: Built;
  swap: Released;
  cleanup: Finished;
};

type PhaseOf<P extends Point> = P extends Phase
  ? P
  : P extends `${infer F extends Phase}:${string}`
    ? F
    : never;

// A phase's own step is what moves a run from one value to the next. Everything
// hung around it is handed what that side of it produced, so a step is typed by
// where it runs and never has to say what it takes
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

// What a step can know before a run starts: nothing has happened yet, so this
// is the config as written and the environment it was asked for
export type Plan = {
  config: Deployment;
  environment: string;
};

// A property rather than a method, because a method's parameter is checked
// bivariantly: declared as one, a step could narrow its input to a value the
// slot it runs in has not produced yet
export type Step<P extends Point = Point> = {
  point: P;
  // Run before the first step, so a step that cannot possibly work says so
  // while the host is still untouched rather than half way through a swap
  check?: (plan: Plan) => void;
  run: (input: InputAt<P>, context: Context) => OutputAt<P> | Promise<OutputAt<P>>;
};

// Erased for storage. A list assembled from a config cannot carry each step's
// own input type, and `never` is what every one of them accepts
export type AnyStep = {
  point: Point;
  check?: (plan: Plan) => void;
  run: (input: never, context: Context) => unknown;
};

// Identity, but it pins the point so a typo fails to compile and the input is
// inferred from where the step runs rather than annotated
export function defineStep<const P extends Point>(
  point: P,
  run: Step<P>["run"],
): Step<P> {
  return { point, run };
}

// A step at the same point as one redkite supplies replaces it, in the place redkite
// had it. That is the whole of turning one of redkite's four off: put something
// there that does less, or nothing
export function merge(supplied: AnyStep[], added: AnyStep[]): AnyStep[] {
  const overrides = new Map(added.map((step) => [step.point, step]));
  const claimed = new Set(supplied.map((step) => step.point));

  return [
    ...supplied.map((step) => overrides.get(step.point) ?? step),
    ...added.filter((step) => !claimed.has(step.point)),
  ];
}

export async function runPipeline(
  steps: AnyStep[],
  setting: Omit<Context, "task">,
): Promise<Finished> {
  const ordered = sequence(steps);
  const plan: Plan = { config: setting.config, environment: setting.environment };

  // Every check before any step, so a run that is going to fail on a config
  // mistake fails before it has created a network or built an image. Nothing
  // wraps what a check throws: it is about the config, and the config is what
  // the reader has in front of them
  for (const step of ordered) step.check?.(plan);

  // Every step is handed what the one before it answered with, so the whole run
  // is a fold over one list. Running part of it at once is a change here alone
  let value: unknown = { environment: setting.environment } satisfies Start;

  for (const step of ordered) {
    const task = setting.log.step(step.point);

    // A step declares what it takes and answers with through its point, and a
    // list assembled from a config cannot carry that through. The declared
    // types are the contract, and this is the one place they are taken on trust
    const run = step.run as (input: unknown, context: Context) => unknown;

    try {
      value = await run(value, { ...setting, task });
      task.done();
    } catch (error) {
      // One step throwing ends the run. Everything after it was written
      // assuming the steps before did what they said they would
      task.fail(`${step.point} failed`);
      throw new Error(`Step ${step.point} failed`, { cause: error });
    }
  }

  // The last step in the sequence is cleanup's, and a step there answers with a
  // Finished or does not compile
  return value as Finished;
}

// The order a run walks: for each phase, everything before it, the phase's own
// slot, then everything after. Redkite's own step leads its slot because merge
// keeps the supplied list first
export function sequence(steps: AnyStep[]): AnyStep[] {
  const ordered: AnyStep[] = [];

  for (const phase of PHASES) {
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

// The names everything else in redkite derives, so a step reads like the container
// and cache keys beside it
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

  // The point redkite's own step sits at, and the one a deployment claims to
  // replace it
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

// Checked where the config is defined rather than where it runs, so a typo or a
// collision is a config that fails to load rather than a deploy that stops half
// way through with the host already changed
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
