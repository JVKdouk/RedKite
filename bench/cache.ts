// A layer cache model. BuildKit keys an instruction on the chain above it plus
// its own inputs, so the first one whose input changed re-runs, and so does
// everything below it. Counting that is not a wall clock measurement, but it is
// exactly what decides one.

export type Input = "stable" | "commit" | "source" | "lockfile" | "manifest" | "clock";

export type Op = { label: string; input: Input };

export type Scenario = {
  name: string;
  // What differs from the previous deploy
  changed: Set<Input>;
};

export function reExecuted(chain: Op[], scenario: Scenario) {
  const first = chain.findIndex((op) => scenario.changed.has(op.input));
  if (first === -1) return 0;

  return chain.length - first;
}

// The hand-written pipeline this replaced, transcribed operation by operation
export const ORIGINAL: Op[] = [
  { label: 'from("node:22-alpine")', input: "stable" },
  { label: "withMountedCache(yarn)", input: "stable" },
  { label: "withMountedCache(modules)", input: "stable" },
  { label: "withEnvVariable(CACHE_BUST, Date.now())", input: "clock" },
  { label: 'withWorkdir("/app")', input: "stable" },
  { label: "withEnvVariable(CACHE_BUST, Date.now())", input: "clock" },
  { label: 'withNewFile("/app/.env")', input: "stable" },
  { label: 'withDirectory("/app", repo)', input: "source" },
  { label: "apk add git openssh-client openssh", input: "stable" },
  { label: "withUnixSocket(ssh)", input: "stable" },
  { label: "withEnvVariable(SSH_AUTH_SOCK)", input: "stable" },
  { label: "mkdir /root/.ssh", input: "stable" },
  { label: "ssh-keyscan github.com", input: "stable" },
  { label: "withEnvVariable(GIT_SSH_COMMAND)", input: "stable" },
  { label: "git config safe.directory", input: "stable" },
  { label: "git submodule update --init --remote", input: "commit" },
  { label: "withEnvVariable(NODE_ENV)", input: "stable" },
  { label: "withEnvVariable(SENTRY_RELEASE)", input: "commit" },
  { label: "yarn install --frozen-lockfile", input: "stable" },
  { label: "sh scripts/install-plugins.sh", input: "stable" },
  { label: "yarn db:generate", input: "stable" },
  { label: "yarn build", input: "stable" },
  { label: "sed -i SENTRY_AUTH_TOKEN", input: "stable" },
];

// Read off the rendered Dockerfile rather than transcribed, see bench/index.ts
export function classify(instruction: string): Input {
  if (instruction.startsWith("COPY package.json")) return "manifest";
  if (instruction.startsWith("COPY yarn.lock")) return "lockfile";
  if (instruction.startsWith("COPY . /app")) return "source";
  if (instruction.includes("SENTRY_RELEASE")) return "commit";
  return "stable";
}
