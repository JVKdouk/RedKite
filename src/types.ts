import type { AnyStep } from "./pipeline.js";
import type { Plugin } from "./plugin.js";

export type Environment = {
  // "host" builds on the deploy host, "local" here and ships the image
  buildOn?: "host" | "local";
  branch: string;
  // First three octets; the allocator owns the fourth
  subnet: string;
  // Absent for a verify environment, which serves nothing and runs no proxy
  publicPort?: number;
  host?: DeployHost;
  extraHosts?: Record<string, string>;
  secrets?: Record<string, SecretRefs>;
  files?: Record<string, Record<string, SecretRef>>;
  // One at a point the deployment already fills replaces it, in place
  steps?: AnyStep[];
  // App name to published port, for a deployment that runs no proxy
  ports?: Record<string, number>;
};

export type StepNetwork = "host" | "deployment" | "none" | { named: string };

export type HostKeys =
  | "accept-new"
  | "strict"
  | "off";

export type DeployHost = {
  bastion: string;
  // Socket path on that machine. Local when absent, deploying to this one
  socket?: string;
  hostKeys?: HostKeys;
};

export type SecretRef = {
  provider: string;
  id: string;
};

// One entry, or several merged in order: a key set by a later ref wins
export type SecretRefs = SecretRef | SecretRef[];

export type ProxySpec = {
  image?: string;
  maxBodySize?: string;
  server?: string[];
  // Added below redkite's own lines, so these override them; locations is per app
  location?: string[];
  locations?: Record<string, string[]>;
  logs?: false | ProxyLogs;
};

export type ProxyLogs = {
  directory?: string;
  access?: boolean | string;
  error?: string;
  level?: "debug" | "info" | "notice" | "warn" | "error" | "crit" | "alert" | "emerg";
  docker?: boolean;
};

export type ServiceSpec = {
  name: string;
  image: string;
  alias?: string;
  restart?: "always" | "unless-stopped";
  files?: Record<string, string>;
  // Baked into the container, so a credential belongs in secrets instead
  environment?: Record<string, string>;
  secrets?: SecretRefs;
  address?: number;
  volumes?: Record<string, string>;
};

export type CarryPath = string | { path: string; optional: true };

export type BuildSpec = {
  preset: string;
  builderImage: string;
  runtimeImage: string;
  // Installed before the rest of the source, so an untouched lockfile reuses it
  dependencies?: {
    files: string[];
    step: string;
    // This layer holds the manifest and lockfile alone, so these cannot run
    stripScripts?: string[];
  };
  steps: string[];
  output: string;
  carry: CarryPath[];
  // Next's standalone build traces from the workspace root and keeps subdirectories
  keepsLayout?: boolean;
  entrypoint: string[];
  caches: string[];
  submodules: boolean;
  aptPackages: string[];
  runtimePackages: string[];
  runtimeSteps: string[];
};

export type VerifySpec = {
  steps: string[];
  network?: StepNetwork;
  environment?: Record<string, string>;
};

export type HealthSpec = {
  path: string;
  // A body that answers but fails this is a retry, not a verdict
  expect: (body: Record<string, unknown>) => boolean;
  // Defaults to 5 attempts, 5000ms apart, after a 10000ms delay
  retries?: number;
  intervalMs?: number;
  delayMs?: number;
};

export type AppSpec = {
  // Names its container, caches, volumes and upstream; renaming orphans them
  name: string;
  // Exactly one of repo and path. A path builds as it stands, ignoring branch
  repo?: string;
  path?: string;
  include?: string[];
  // "/" is the catch-all; a mounted prefix is stripped. Required with a proxy
  route?: string;
  port: number;
  secrets?: SecretRefs;
  // At most one. A branch tracks its head, a tag or commit pins it
  branch?: string;
  tag?: string;
  commit?: string;
  // Build steps run here; the dependency install stays at the repository root
  dir?: string;
  build: BuildSpec;
  health: HealthSpec;
  verify?: VerifySpec;
  volumes?: Record<string, string>;
  environment?: Record<string, string>;
  files?: Record<string, SecretRef>;
};

export type Deployment = {
  project: string;
  environment?: Environment;
  environments?: Record<string, Environment>;
  // Derived from the apps' routes. false runs none, publishing per-app ports
  proxy?: ProxySpec | false;
  services: ServiceSpec[];
  apps: AppSpec[];
  steps?: AnyStep[];
  plugins?: Plugin[];
  options?: DeploymentOptions;
};

export type DeploymentOptions = {
  // Writes to /tmp/<project>/<environment>/crash-<time>/. On unless false
  crashLog?: boolean;
};
