import type { AnyStep } from "./pipeline.js";

// The shapes a deploy config is written against. Nothing here knows about
// Docker or git, so a config can be planned and asserted on without a host to
// deploy to.

export type Environment = {
  // Git ref the apps are built from, the only per-environment source difference
  branch: string;
  // First three octets, the allocator owns the fourth. One /16 per environment
  subnet: string;
  // Port published on the host, the only port a person outside ever types
  publicPort: number;
  // The machine the containers run on, and which builds the images. Absent
  // means this one
  host?: DeployHost;
  // Hostname to address, added to every container beside the ones the topology
  // derives. For a database or a legacy service that has no DNS the apps can
  // use, and whose address is what differs between environments
  extraHosts?: Record<string, string>;
};

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
  // Extra builder directories copied into the runtime image beside the output
  carry: string[];
  // Process the runtime image starts, as argv rather than a shell string
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
  // Clone URL, fetched over the forwarded SSH agent rather than with a token
  repo: string;
  // Nginx location this app answers. "/" is the catch-all, and a mounted route
  // such as "/api/" has its prefix stripped before the request is proxied
  route: string;
  // Port the app listens on inside its container, and which nginx proxies to
  port: number;
  // Environment for the app. Several are merged in the order written, so a
  // shared ref can come first and a per-app one override it
  secrets?: SecretRefs;
  // How the repository becomes a runnable image
  build: BuildSpec;
  // What has to be true before traffic is allowed to move to the new container
  health: HealthSpec;
  // Volume name to container path, for state that outlives a deploy
  volumes?: Record<string, string>;
  // Container path to the item whose contents land there, for credentials that
  // have to be a file rather than an environment variable
  files?: Record<string, SecretRef>;
  // Keeps the builder stage as an image of its own. The runtime image holds
  // only the output, so this is what a step running the app's own toolchain,
  // a migration among them, has to run in
  keepBuilder?: boolean;
};

export type Deployment = {
  // Prefixes every container, network and volume, and separates one project's
  // objects from another's on a shared host
  project: string;
  // Selected on the command line. The key is threaded into every derived name,
  // so there is exactly one place the environment can be wrong. Optional
  // because an environment may live in redkite.<name>.config.ts instead
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
