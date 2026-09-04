import type { AnyStep } from "./pipeline.js";

// The shapes a deploy config is written against. Nothing here knows about
// Docker or git, so a config can be planned and asserted on without a host to
// deploy to.

export type Environment = {
  // Where the images are built. "host" is the deploy host, which is where they
  // are needed and costs nothing to move them. "local" builds on this machine
  // and ships the result, for a host too small to compile on. Ignored when the
  // deploy host is already this machine
  buildOn?: "host" | "local";
  // Git ref the apps are built from, the only per-environment source difference
  branch: string;
  // First three octets, the allocator owns the fourth. One /16 per environment
  subnet: string;
  // Port published on the host, the only port a person outside ever types.
  // A verify environment has none: nothing serves in one, so there is no proxy
  // to publish and no traffic to publish it for
  publicPort?: number;
  // The machine the containers run on, and which builds the images. Absent
  // means this one
  host?: DeployHost;
  // Hostname to address, added to every container beside the ones the topology
  // derives. For a database or a legacy service that has no DNS the apps can
  // use, and whose address is what differs between environments
  extraHosts?: Record<string, string>;
};

// Where a step's container is attached. "host" is the deploy host's own stack,
// which reaches whatever that machine already reaches. "deployment" is the
// network the apps and services run on, which is what resolves a service by
// the alias the apps know it by
export type StepNetwork = "host" | "deployment" | "none" | { named: string };

export type DeployHost = {
  // SSH destination, user@address
  bastion: string;
  // Socket path on that machine. Local when absent, deploying to this one
  socket?: string;
};

// One item in a store, named at the point of use rather than through a lookup
// table. The provider tag is what routes it to a store at deploy time
export type SecretRef = {
  // Which store resolves this, and the primitive that produced it
  provider: string;
  // The store's own identifier for the item
  id: string;
};

// One entry, or several merged in order. A key set by a later ref wins
export type SecretRefs = SecretRef | SecretRef[];

export type ServiceSpec = {
  // Identifies the service, and becomes part of its container name
  name: string;
  // Image pulled and re-tagged onto the host, pinned rather than floating
  image: string;
  // Hostname other containers reach this service by, added as an extra host
  alias?: string;
  // Whether the host brings it back after a reboot or a crash
  restart?: "always" | "unless-stopped";
  // Container path to the file contents baked into the image at build time
  files?: Record<string, string>;
  // Settings the image reads on start. These are baked into the container, so
  // a credential belongs in secrets rather than here
  environment?: Record<string, string>;
  // Resolved at deploy time and handed over as an env file, so a password
  // reaches the container without being written down in this repository
  secrets?: SecretRefs;
  // Pins the last octet, for a service already running at an address it was
  // given by hand. Drop the pin once the container has been recreated
  address?: number;
  // Volume name to container path. Without one, an image that declares a
  // VOLUME gets an anonymous volume nothing in this file can name again
  volumes?: Record<string, string>;
};

// A directory carried into the runtime image. Optional means the build is
// allowed not to have produced it, which is a claim about that directory alone
export type CarryPath = string | { path: string; optional: true };

export type BuildSpec = {
  // Which preset produced this, carried for diagnostics rather than dispatch
  preset: string;
  // Fat image the repository is compiled in, with caches mounted
  builderImage: string;
  // Slim image the compiled output is copied into, and which actually ships
  runtimeImage: string;
  // Copied and run before the rest of the source. A commit that does not touch
  // these files reuses the installed dependencies instead of resolving them
  // again, which is the difference between a deploy and a cold build
  dependencies?: {
    files: string[];
    step: string;
    // Root lifecycle scripts removed from the manifest before installing. This
    // layer holds the manifest and the lockfile alone, so a prepare that wants
    // the repository, its hooks or its scripts directory cannot run here
    stripScripts?: string[];
  };
  // Shell commands run in order in the builder. A non-zero exit fails the deploy
  steps: string[];
  // Directory in the builder that becomes the root of the runtime image
  output: string;
  // Extra builder directories copied into the runtime image beside the output.
  // A bare path has to exist, and a build whose output is missing one of these
  // is a build that failed without saying so
  carry: CarryPath[];
  // Whether the output tree keeps the repository's own directory structure.
  // Next's standalone build does: it traces from the workspace root, so an app
  // in a subdirectory arrives under that subdirectory rather than at the top
  keepsLayout?: boolean;
  // Process the runtime image starts, as argv rather than a shell string. It
  // runs at the app's root, so a path relative to that survives dir
  entrypoint: string[];
  // Cache names mounted into the builder, keyed per app and environment so two
  // apps or two environments never share one
  caches: string[];
  // Whether the checkout follows the submodules named in .gitmodules. An empty
  // submodule directory builds a working image with the contents missing
  submodules: boolean;
  // Packages the builder needs before any step runs, typically an SSH client
  aptPackages: string[];
  // Packages the runtime image needs, typically curl for the health probe
  runtimePackages: string[];
  // Shell commands run in the runtime image, for what a package manager cannot
  // install. Above the output copy, so a new commit does not repeat them
  runtimeSteps: string[];
  // Uploads source maps during the build, then deletes them from the image
  sourcemaps?: SourcemapSpec;
};

export type SourcemapSpec = {
  // Which service receives the maps, "sentry" is the only one today
  provider: "sentry";
  // Env var stripped from the shipped file, it is a build-time credential and
  // has no reason to travel inside the image
  stripFromImage: string;
};

// How a build is decided to work. The commands run in the builder image, which
// is the one holding the test runner and the dev dependencies, so nothing has
// to be installed to check a release that is already compiled
export type VerifySpec = {
  // Shell commands run in order. A non-zero exit fails the run, and the first
  // is usually whatever brings the test database to the schema the tests want
  steps: string[];
  // Defaults to the deployment network, which is what resolves a service by
  // the alias the app already uses: postgres answers at postgres
  network?: StepNetwork;
  // Settings the checks need beside the ones the image was built with, a test
  // database url among them
  environment?: Record<string, string>;
};

export type HealthSpec = {
  // Path probed on the container itself, not through the proxy
  path: string;
  // Decides whether the parsed body means healthy. A body that answers but
  // fails this is a retry, not a verdict, the container may still be starting
  expect: (body: Record<string, unknown>) => boolean;
  // Attempts before the deploy reverts. Defaults to 5
  retries?: number;
  // Wait between attempts in milliseconds. Defaults to 5000
  intervalMs?: number;
  // Wait before the first attempt, covering ordinary start-up. Defaults to 10000
  delayMs?: number;
};

export type AppSpec = {
  // Identifies the app. Becomes its container name, cache keys, volume names
  // and nginx upstream, so changing it orphans everything named after it
  name: string;
  // Clone URL, fetched over the forwarded SSH agent rather than with a token.
  // Exactly one of this and path: the source is either cloned or already here
  repo?: string;
  // A directory on this machine, built as it stands rather than cloned. What a
  // CI job already checked out is one, and so is the copy you are editing.
  // Relative to the deployment file. The branch an environment names is not
  // read for one of these: what is on disk is what ships
  path?: string;
  // What of that directory goes into the build, relative to it. Only for a
  // path, and only needed where git cannot answer: a work tree's .gitignore
  // already says it. Given here it wins, which is how a repository is narrowed
  // to the one app inside it
  include?: string[];
  // Nginx location this app answers. "/" is the catch-all, and a mounted route
  // such as "/api/" has its prefix stripped before the request is proxied
  route: string;
  // Port the app listens on inside its container, and which nginx proxies to
  port: number;
  // Environment for the app. Several are merged in the order written, so a
  // shared ref can come first and a per-app one override it
  secrets?: SecretRefs;
  // Where the app sits in the repository, for a monorepo whose root is not it.
  // Build steps and the shipped command run there. The dependency install does
  // not: a workspace lockfile is resolved at the root for every package at once
  dir?: string;
  // How the repository becomes a runnable image
  build: BuildSpec;
  // What has to be true before traffic is allowed to move to the new container
  health: HealthSpec;
  // What has to be true for the build to be worth deploying at all. Only
  // `redkite verify` runs these, so a deploy never pays for them
  verify?: VerifySpec;
  // Volume name to container path, for state that outlives a deploy
  volumes?: Record<string, string>;
  // Plain environment for the running container, for what is configuration
  // rather than a credential. Secrets come from the vault instead
  environment?: Record<string, string>;
  // Container path to the item whose contents land there, for credentials that
  // have to be a file rather than an environment variable
  files?: Record<string, SecretRef>;
};

export type Deployment = {
  // Prefixes every container, network and volume, and separates one project's
  // objects from another's on a shared host
  project: string;
  // Overrides whichever one was selected, for a deployment that has only one
  // and no reason to keep it in a file. Two of them is two files
  environment?: Environment;
  // Filled by the loader from the redkite.<name>.config.ts files beside this
  // one, and from anything package.json names. A deployment does not declare
  // them: the thing that differs between staging and production is a file, not
  // a key several levels down a literal
  environments?: Record<string, Environment>;
  // Largest request body the proxy accepts before answering 413
  maxBodySize?: string;
  // Image the derived proxy runs, pinned rather than floating
  proxyImage?: string;
  // Long-lived containers shared by the apps, not rebuilt on every deploy.
  // The proxy is not one of them: apps with routes imply exactly one, so it is
  // derived rather than listed
  services: ServiceSpec[];
  // The applications. Everything derived, addresses, container names, nginx
  // upstreams and location blocks, is a function of this list
  apps: AppSpec[];
  // Work injected into the run, from this file or from a plugin that answers
  // with some. Addressed by where it runs, so nothing here has to be called
  steps?: AnyStep[];
};
