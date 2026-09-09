<h1 align="center">
  <img src="media/redkite.png" alt="redkite" width="200">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/redkite"><img alt="npm version" src="https://img.shields.io/npm/v/redkite.svg"></a>
  <a href="https://www.npmjs.com/package/redkite"><img alt="npm downloads" src="https://img.shields.io/npm/dm/redkite.svg"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/redkite.svg"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/redkite.svg"></a>
</p>

<p align="center">
  Blue-green Docker deployment from one config file, over ssh.<br>
  No engine, no agent, no dependencies.
</p>

Describe a deployment once. Redkite derives every container name, IP address,
volume, cache key, nginx upstream and location block from it, then builds your
images on the machine that runs them and swaps traffic over with a health check
and an automatic revert.

A deploy is git, a Dockerfile and the docker CLI, driven over one ssh
connection. There is nothing to install on the server and nothing running
between deploys.

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Hooks](#hooks)
- [Plugins](#plugins)
- [Verifying a build](#verifying-a-build)
- [CLI](#cli)
- [GitHub Actions](#github-actions)
- [How a deploy runs](#how-a-deploy-runs)
- [Design](#design)
- [Contributing](#contributing)
- [License](#license)

## Quick start

```sh
npm install redkite
```

Add `redkite.config.ts` at the root of your project:

```ts
import { defineDeployment, nextApp, nodeApp, redis } from "redkite";

export default defineDeployment({
  project: "acme",

  services: [redis()],

  apps: [
    {
      name: "web",
      repo: "git@github.com:acme/web.git",
      route: "/",
      port: 3000,
      build: nextApp(),
      health: { path: "/api/health", expect: (body) => body.status === "ok" },
    },
    {
      name: "api",
      repo: "git@github.com:acme/api.git",
      route: "/api/",
      port: 3001,
      build: nodeApp({
        steps: ["yarn build"],
        output: "/app/dist",
        entrypoint: ["node", "/app/index.js"],
      }),
      health: { path: "/health", expect: (body) => body.status === "up" },
    },
  ],
});
```

Then:

```sh
npx redkite plan production     # what it will do, no host needed
npx redkite deploy production   # build, swap, health check, revert on failure
```

Nothing in that config names an IP address, a container, a network, a cache key,
a `retired-` prefix, or an nginx directive. Adding a third app is six lines.

## Features

- **Blue-green by default.** The running container moves to a retired address
  without being stopped, so it keeps answering while the new one starts. One
  unhealthy app reverts all of them.
- **Derived topology.** Container names, addresses, volumes, cache keys, nginx
  upstreams and location blocks are functions of the app list, so two of them
  cannot collide and adding an app cannot renumber another.
- **Builds on the deploy host.** The image is created inside the daemon that
  will run it, so there is no export, no tarball and no transfer.
- **Nothing crosses the wire.** The host clones your repositories itself over a
  forwarded agent. A warm deploy sends commands and secrets, nothing else.
- **Secrets stay out of the image.** The environment file and every credential
  arrive as BuildKit `--secret` mounts, so they are in neither a layer nor
  `docker history`.
- **An extensible pipeline.** Redkite's own four steps sit at ordinary points that
  your config can hook around or replace outright.
- **Zero dependencies.** One package. Node reads the TypeScript config itself.

## Requirements

| Where | Needs |
| --- | --- |
| Your machine | Node 22.18 or newer, git, ssh, an ssh agent with a key that can reach your repositories |
| The deploy host | docker with BuildKit, git, ssh access |

Node 22.18 is the version that reads TypeScript without a loader, which is what
lets redkite ship with nothing in `dependencies`. If your config needs more than
Node resolves on its own, a `tsconfig` path or a `./thing.js` specifier pointing
at a `./thing.ts` file, redkite uses your project's own `tsx` when you have one.

Name the config `redkite.config.mts` if your `package.json` has no
`"type": "module"`: a `.ts` file in a CommonJS package is CommonJS, where
`import` is not legal. Redkite says so if you get it wrong. `.js` and `.mjs` work
too, and `--config` overrides the search, which otherwise walks up from where
you ran it to the root of the project.

## Configuration

`defineDeployment` validates at load, so a duplicate name, two apps on one
route, or a malformed hook point is a config that fails rather than a deploy
that stops half way through.

### Environments

One file each, beside the deployment, named `redkite.<environment>.config.ts`:

```ts
// redkite.production.config.ts
import { defineEnvironment } from "redkite";

export default defineEnvironment({
  branch: "main",
  subnet: "10.20.0",
  publicPort: 80,
  host: { bastion: "deploy@acme.example" },
});
```

Redkite finds them by name, so there is no list to keep in step, and anything
beside the deployment whose name starts with `redkite` and is a module counts:
`redkite.staging.ts` and `redkite-staging.ts` name the same environment as
`redkite.staging.config.ts` does. One that was meant to be an environment and
is named slightly differently is refused rather than passed over as though it
were not there. The name has to be lower case, because it becomes part of an
image tag and a tag cannot hold a capital.

`redkite.config.ts` has no `environments` key at all: a second place to put a
set of them is a second place for them to disagree. A config that declares one
does not compile.

A deployment with only one environment can carry it instead, as `environment`:

```ts
export default defineDeployment({
  project: "acme",
  environment: { branch: "main", subnet: "10.20.0", publicPort: 80 },
  // ...
});
```

That is an override, not a default: it answers for whatever name the command
line asks for, and wins over any file that disagrees. Two environments means two
files.

Selected on the command line and threaded into every derived name.

| Field | Meaning |
| --- | --- |
| `branch` | The git ref each app is built from |
| `subnet` | First three octets. Redkite allocates the fourth |
| `publicPort` | The only port anybody outside ever types |
| `host.bastion` | `user@address` of the deploy host. Absent means this machine |
| `extraHosts` | Hostname to address, added to every container beside the derived ones |
| `buildOn` | `"host"` by default. `"local"` compiles here and ships the image |

Images are built on the deploy host, which is where they are needed and costs
nothing to move them. A host too small to compile on can be told otherwise:

```ts
production: { buildOn: "local", branch: "main", subnet: "10.0.0", publicPort: 80 }
```

The checkout, the Dockerfile and the build then happen on this machine, and the
finished image is streamed into `docker load` on the host down the connection
that is already open. Nothing is written to a disk at either end. The skip check
asks the host rather than this machine, so an image compiled here before but
never sent is still sent. It is ignored when the deploy host is this machine,
since there would be nothing to move.

`extraHosts` is for something the apps must resolve that redkite does not run:
a managed database, a legacy service, anything whose address is the thing that
differs between staging and production.

```ts
extraHosts: { "db.internal": "10.55.0.250" },
```

A name the deployment already resolves, an app's container or a service alias,
is refused rather than silently overridden. Redirecting one of those would send
its traffic somewhere else and the deploy would still look like it worked.

### Where the files live

By default `redkite.config.ts` sits at the root of the project with the
environment files beside it, and a deploy run from anywhere inside walks up to
find them. `package.json` is where a repository says otherwise:

```json
{
  "redkite": { "directory": "deploy" }
}
```

Then `deploy/redkite.config.ts` and `deploy/redkite.production.config.ts`. If
that directory holds no config, redkite stops and says so rather than carrying
on up the tree: naming a directory and not putting the files there is a mistake,
not a hint.

An environment that lives somewhere the naming convention would not find it can
be named outright, at whatever path it is at:

```json
{
  "redkite": {
    "environments": {
      "production": "./infra/live.ts",
      "staging": "./infra/staging.ts"
    }
  }
}
```

Paths are read against the `package.json` that names them. One that is not there
is refused rather than silently skipped, and an environment named here that also
sits beside the deployment is refused too: it comes from one place or the other.

### Apps

| Field | Meaning |
| --- | --- |
| `name` | Becomes the container name, cache keys, volumes and nginx upstream |
| `repo` | Clone URL, fetched over the forwarded agent rather than with a token |
| `route` | The nginx location. `/` is the catch-all; `/api/` has its prefix stripped |
| `port` | The port the app listens on inside its container |
| `build` | How the repository becomes an image. See presets below |
| `dir` | Where the app sits in the repository, when it is not the whole of it |
| `health` | Probed on the container itself, not through the proxy |
| `secrets` | One ref or several, merged in order, written to `.env` in the image |
| `files` | Container path to the item whose contents land there |
| `volumes` | Volume name to container path, for state that outlives a deploy |

### What an app is built from

Every cloned app takes the environment's `branch` unless it says otherwise. An
app can name its own, and can pin instead of tracking:

```ts
{ name: "backend", repo: "…", branch: "release" }   // tracks that branch
{ name: "worker",  repo: "…", tag: "v1.2.3" }       // pinned
{ name: "legacy",  repo: "…", commit: "9f2b4c1" }   // pinned
```

At most one of the three, and a config naming two is refused: they are
different commits and picking one is not redkite's to do.

`branch` is looked up under `refs/heads`, `tag` under `refs/tags` and peeled,
so an annotated tag answers with the commit it points at rather than with the
tag object. A `commit` is taken as it is and checked that it is one. The
failure says which kind was missing: *"acme/backend has no tag v9"*.

An environment can only say `branch`. A tag or a commit is a claim about one
repository, and an environment spans every app in the deployment.

### Building from a directory

An app names either a repository to clone or a directory already on this
machine. A CI job that has already checked the code out is one; so is the copy
you are editing.

```ts
{
  name: "backend",
  path: "./services/backend",   // instead of repo
  route: "/api/",
  port: 3001,
  // ...
}
```

The path is read against the deployment file, not against wherever the command
was run, so a deploy from a workspace and one from the root build the same tree.
Nothing is cloned, checked out or cleaned: what is on disk is what ships, and
the `branch` an environment names is not consulted at all.

The release is the content of the working tree, taken with git's own addressing
over a scratch index. It covers what is committed, what is modified and what is
untracked, and honours `.gitignore`, which is the same set the build reads. So
an edit you never committed is a new release and gets built, and a change under
an ignored `node_modules` is not and does not:

```
unchanged            already built at 7797c4c, nothing rebuilt
uncommitted edit     built from 9bba792, rebuilt
untracked file       built from 587974b, rebuilt
ignored file         already built at 9bba792, nothing rebuilt
```

Somewhere outside git there is nothing to say any of that, so the deployment
says it instead:

```ts
{
  name: "backend",
  path: "../checkout",
  include: ["src", "package.json", "yarn.lock"],
}
```

`include` names what ships, relative to `path`. It decides the release and the
build context together: BuildKit is handed a `.dockerignore` that holds
everything back and lets exactly these through, so a `node_modules` the release
says nothing about is not uploaded either. Asked to build a directory git knows
nothing about without one, redkite says so and shows the line to add rather than
guessing or refusing outright.

An `include` on a work tree is allowed too, and wins over `.gitignore`. That is
how a repository holding several things is narrowed to the one being built.

When the deploy host is another machine, an app built from a path forces the
build to happen here and the image to be shipped, the same as `--local`. The
source is on this machine, so the builder is too.

### Build presets

`nodeApp` and `nextApp` describe a two-stage build: a fat builder image with
caches mounted, and a slim runtime image the compiled output is copied into.

```ts
nodeApp({
  builder: "22-alpine",
  runtime: "24-alpine",
  submodules: true,
  steps: ["yarn db:generate", "yarn build"],
  output: "/app/dist",
  carry: ["/app/.generated"],
  entrypoint: ["node", "/app/index.js"],
});
```

The dependency install is not one of the `steps`. The preset copies
`package.json` and `yarn.lock` ahead of the source and installs against those
alone, so a commit that changes only source code reuses the layer. That is the
difference between a deploy and a cold build.

#### What a build is allowed not to produce

A `COPY` whose source is missing fails the build. That is right for the output,
which is the app itself, and wrong for a directory the repository may simply not
have. A `carry` entry says which it is:

```ts
carry: [
  "/app/.generated",                          // must exist, or the build failed
  { path: "/app/public", optional: true },    // skipped when it is not there
]
```

`nextApp` marks `public` optional and `.next/static` required, because static is
what the server answers with for every chunk it built. A lockfile named in
`dependencies.files` is optional too: whether one is missing is the package
manager's to say, in its own words.

`nextApp` takes `standalone`, which says whether `next.config` sets
`output: "standalone"`. It defaults to `true`. A standalone build ships the
tree Next produced and runs it on node alone; without it the whole repository
ships and `next start` resolves its own dependencies, which is a much larger
image.

```ts
nextApp({ standalone: false })
```

### An app in a directory of its own

A repository holding several apps names each one's directory:

```ts
{ name: "web", dir: "apps/web", build: nextApp(), /* ... */ }
```

The whole repository is copied into the image, and `dir` is where the build
steps and the shipped command run. Every `/app` path the build spec names is
read against it, so a preset needs no change: `output: "/app/dist"` becomes
`/app/apps/web/dist`.

A Next standalone build traces from the workspace root, so the tree it emits
holds `apps/web/server.js` rather than `server.js`. `nextApp` declares that with
`keepsLayout`, and the runtime stage then starts the command at
`/app/apps/web` and lands `.next/static` and `public` beside it. A build whose
output flattens the app to the top of the tree, which is every `nodeApp`, leaves
`keepsLayout` unset and nothing moves.

**The dependency install stays at the repository root.** A workspace resolves
one lockfile for every package in it, so the install has to see all of them,
and `node_modules` is where that put it. An app with its own lockfile in a
subdirectory is not covered by `dir` alone.

### Reaching the deploy host

```ts
host: { bastion: "deploy@acme.example", hostKeys: "accept-new" }
```

The host's key is checked before anything is handed to it. `accept-new`, the
default, trusts it the first time and refuses it if the key ever changes after
that: no setup, and nothing to intercept once the first deploy has happened.
`strict` refuses any host not already in `known_hosts`, which is stronger and
means putting the key there yourself. `off` checks nothing, for a host whose
address is handed out again and again and only where nothing on the way to it
can listen.

ssh is never left able to ask a question, whichever of the three it is under: a
prompt nobody is there to answer is a deploy that hangs rather than one that
fails. Cloning is separate and always `accept-new`, because the deploy host
reaches GitHub rather than reaching you.

### Services

Long-lived containers shared by the apps. The proxy is not one of them: apps
carry routes, routes imply exactly one proxy, so it is derived rather than
listed.

A service is adopted when it is the one the config describes, and recreated when
it is not. Each is created carrying a fingerprint of everything a recreate would
change, the rendered nginx configuration included, so changing the published
port or `maxBodySize` reaches the running container instead of sitting in a file
it was never created from. `redkite plan` reports the comparison without
changing anything:

```
services on the host
  acme-staging-nginx                created from an earlier version of this file
  acme-staging-redis                not there, will be created

  a deploy converges these
```

```ts
services: [
  redis({ address: 26, volumes: { data: "/data" } }),
  postgres({ secrets: bitwarden("..."), environment: { POSTGRES_DB: "acme" } }),
];
```

`postgres` requires `secrets` because the image will not start without
`POSTGRES_PASSWORD`, and a service that cannot come up is not a useful default.
Whatever the ref resolves to is written to a file on the deploy host and handed
over with `--env-file`, so the password is never an argument in a command line
or a shell history. Settings that are not credentials, `POSTGRES_DB` and
`POSTGRES_USER`, go in `environment` instead.

### Secrets

An id is a pointer, not a credential, so it belongs in the config while the
credentials arrive at deploy time.

```ts
plugins: [bitwarden()],
// ...
secrets: bitwarden.item("00000000-0000-4000-8000-000000000001"),
files: { "/app/service-account.json": bitwarden.item("...") },
```

The vault is a [plugin](#plugins) like any other, so `bitwarden()` has to be
registered before `bitwarden.item()` resolves to anything. A deployment that
names a provider nothing registers is refused before it builds, rather than
reaching for a vault by name.

It unlocks with `BW_KEY`, a session obtained elsewhere, and falls back to
`BW_CLIENT_ID`, `BW_CLIENT_SECRET` and `BW_PASSWORD` when that is not set. A
config that would rather name its own variable passes the session in:
`bitwarden({ secrets: process.env.MY_VAULT_SESSION })`. One that reads no
secrets at all needs none of them: redkite only opens the stores your config
actually names.

#### Where a secret is, and where it is not

**Nothing a vault resolves is ever written into an image.** During the build it
is mounted as `.env` at the app's root for the length of each step and gone
after it, so a build can read a credential without shipping one, and no layer
ever holds it. Copying it in and deleting it later would not do: a deleted file
is still readable in the layer underneath.

At runtime it arrives as the container's own environment, written to the host
and handed to `docker create --env-file`, so no value appears in an argument
list and the file goes with the rest of the deploy's scratch. Read it from
`process.env`; there is no `.env` to read.

The same is true of the migrations and checks that run in the builder image:
they are given `--env-file` too, rather than finding a file the build left
behind.

If you do want one in the image, say so, in a build step where the mount is
still there:

```ts
steps: ["yarn build", "cp .env dist/.env"],
```

`files` is the other way to put a credential in an image on purpose, for the
ones that have to be a file rather than a variable:

```ts
files: { "/app/service-account.json": bitwarden.item("...") },
```

## Hooks

A run is one list of steps, each handed what the one before it answered with.
Redkite puts four in it. A step says where it runs, and nothing has to call it.

```
setup:before:<name>
setup                   redkite: creates the network, brings the services up
setup:<name>
setup:after:<name>

build:before:<name>
build                   redkite: resolves, checks out and builds every image
build:<name>
build:after:<name>

swap:before:<name>
swap                    redkite: moves the addresses, health checks, reverts
swap:<name>
swap:after:<name>

cleanup:before:<name>
cleanup                 redkite: removes the retired containers and old images
cleanup:<name>
cleanup:after:<name>
```

**Nothing about redkite's four is privileged.** They sit at ordinary points, and a
config that registers a step at the same point replaces it. That is how one is
turned off: put something there that does less.

```ts
import { defineStep } from "redkite";

export default defineDeployment({
  // ...
  steps: [
    defineStep("build:after:report", async (built, context) => {
      for (const app of built.apps) {
        context.task.detail(`${app.name} at ${app.release.slice(0, 7)}`);
      }

      return built;
    }),

    // A host somebody else prunes: redkite's cleanup never runs
    defineStep("cleanup", (released) => ({
      ...released,
      removed: [],
      reclaimed: [],
    })),
  ],
});
```

A step is handed the previous step's answer and the context: the config, the
topology, the host, the docker client, the secret stores, the log, and its own
progress row. **If a step throws, the run stops**, because everything after it
was written assuming the steps before did what they said.

The value grows as the run goes, so a late step reads everything above it:
`environment` from the start, `network` and `services` after setup, `apps` after
build, `ok` and `released` and `reverted` after swap, `removed` and
`reclaimed` after cleanup.

What a step is handed is decided by where it runs, so the example above compiles
with no annotation and `built.apps` is known to exist. A step at a point in a
phase nobody defined does not compile, and a replacement for one of redkite's four
has to answer with what the rest of the run expects.

### Migrations

A migration is a step like any other. `migrate()` answers with one at
`swap:before:migrate-<app>`, so it runs in the image that was just built, while
the old containers are still serving, and throws before anything retires.

```ts
import { migrate } from "redkite";

export default defineDeployment({
  steps: [migrate({ app: "backend", command: "yarn db:migrate" })],
});
```

The runtime image holds only what the app compiled to, so the command runs in
the builder stage instead. Every app keeps that stage as an image of its own,
which costs the export of layers the runtime build produced anyway and means
there is nothing to set before a step can use it.

A step naming an app the deployment does not have fails before the run starts
rather than half way through it.

#### The network a step runs on

A migration defaults to `host`: the deploy host's own network stack, which is
what reaches a database that machine already reaches. A database this deployment
runs as a service is somewhere else, so say so:

```ts
migrate({ app: "backend", command: "yarn db:migrate", network: "deployment" })
```

| `network` | Where the container is attached |
| --- | --- |
| `"host"` | The deploy host's own stack. The default |
| `"deployment"` | The network the apps and services run on, with every alias they resolve, so `postgres:5432` works |
| `"none"` | Nothing at all |
| `{ named: "..." }` | A network somebody else made |

`attachment()` answers with the same flags for a step of your own:

```ts
import { attachment, defineStep } from "redkite";

defineStep("swap:before:seed", async (built, context) => {
  const image = built.apps.find((app) => app.name === "backend")?.builderTag;
  if (!image) throw new Error("backend did not keep its builder");

  await context.docker.runOrThrow(
    ["run --rm", ...attachment("deployment", context.topology), image, "yarn db:seed"].join(" "),
    "seeding failed",
  );

  return built;
});
```

### Snapshotting a database before a swap

A migration that goes wrong is the one thing a blue-green swap cannot undo:
putting the container back does not put the rows back. These take a snapshot
first, and they sit at `swap:before` so they run while the old containers are
still serving.

```ts
steps: [
  // Above the migrate, because steps run in the order they are listed
  rdsSnapshot({ instance: "acme-production", region: "eu-west-1" }),
  migrate({ app: "backend", command: "yarn db:migrate" }),
]
```

`rdsSnapshot` goes through the AWS CLI, which every runner already has with the
credentials the job was given; signing a request by hand is a page of crypto
that nothing here could check. It takes an `instance`, or a `cluster` for
Aurora, and refuses a config naming both. RDS captures the data when the
snapshot begins rather than when it finishes, so it does not wait by default:
`wait: true` turns a snapshot that silently failed into a deploy that stops
before the migration, at the cost of however long the snapshot takes.

```ts
digitalOceanSnapshot({ volume: "e7f8...", tokenFrom: "DIGITALOCEAN_TOKEN" })
```

DigitalOcean's managed databases have no endpoint that takes a snapshot on
demand: their backups are automatic and the API only lists them. So what this
snapshots is the block storage `volume` the data sits on, which for redkite's
own postgres service is the disk under the container, or the `droplet` when the
database is the whole machine. A volume snapshot of a running Postgres is crash
consistent rather than clean, which Postgres is built to survive.

The token is named rather than given: a config is committed and a token is not.
Both plugins check what they can before the run starts, so a missing token or a
config naming two databases fails while the host is still untouched.

## Plugins

A plugin is what a deployment opts into. It adds steps to the run, or teaches
it to resolve a kind of secret, and **nothing it carries happens until the
config lists it** in `plugins`. Redkite's own vault is one of these rather than
something wired in behind them, so the rule has no exceptions to remember.

```ts
import { bitwarden, defineDeployment, digitalOceanSnapshot, rdsSnapshot } from "redkite";

export default defineDeployment({
  project: "acme",
  plugins: [
    bitwarden(),
    rdsSnapshot({ instance: "acme-production", region: "eu-west-1" }),
  ],
  // ...
});
```

`plan` prints what a deployment opted into and where each plugin's steps land,
so what a run will do is readable without running it:

```
plugins
  bitwarden                 0 steps  resolves bitwarden
  rds-snapshot-acme-db      1 step

pipeline (deploy)
  setup                     redkite
  build                     redkite
  swap:before:snapshot-acme-db  rds-snapshot-acme-db
  swap:before:migrate-backend
  swap                      redkite
  cleanup                   redkite
```

A plugin's steps run above the deployment's own, which is why the snapshot
lands before the migration written under `steps`. Registering the same plugin
twice is refused, and so is a second plugin claiming a provider another already
resolves.

The ones redkite ships are `bitwarden()`, [`rdsSnapshot()` and
`digitalOceanSnapshot()`](#snapshotting-a-database-before-a-swap). None of them
is on unless you say so.

### Writing plugins

A plugin is an object with a name, and steps or stores. `definePlugin` is
identity, but it checks the points where the plugin is written rather than
where it is registered, so a typo is the plugin's own failure:

```ts
import { definePlugin, defineStep, type Plugin } from "redkite";

export function announce(options: { url: string }): Plugin {
  return definePlugin({
    name: "announce",
    steps: [
      defineStep("swap:after:announce", async (input, context) => {
        if (!input.ok) return input;

        context.task.detail(`announcing ${input.released.join(", ")}`);
        await fetch(options.url, { method: "POST", body: input.released.join(",") });

        return input;
      }),
    ],
  });
}
```

The input and output types come from the point: a step at `swap:after` is
handed what the swap answered with, and must answer with the same, which is
what makes `input.released` typed without annotating anything.

A plugin resolving secrets registers a store per provider tag instead. It is
opened once, and only when a ref actually names that provider:

```ts
definePlugin({
  name: "onepassword",
  stores: {
    onepassword: async ({ detail }) => {
      detail("unlocking");
      return { read: async (id: string) => await read(id) };
    },
  },
});
```

Then a ref pointing at it is `{ provider: "onepassword", id }`, which is what a
helper like `bitwarden.item()` answers with.

### As a separate package

There is nothing to register: a package exports a function, a config imports it
and lists what it answers with. The one thing to know is that **a plugin has to
ship JavaScript**. Node strips types from a config file, but it refuses to do
so for anything under `node_modules`, so a package shipping `.ts` fails to load
with `Stripping types is currently unsupported for files under node_modules`.
Compile it and ship `dist`, the way redkite itself does:

```json
{
  "name": "redkite-plugin-announce",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc index.ts --outDir dist --declaration" },
  "peerDependencies": { "redkite": ">=0.1.7" }
}
```

`redkite` belongs in `peerDependencies` rather than `dependencies`: a plugin
extends the redkite the deployment is already running, and a second copy of it
would be a second set of types that do not match.

```sh
npm install redkite-plugin-announce
```

```ts
import { announce } from "redkite-plugin-announce";

plugins: [announce({ url: process.env.SLACK_WEBHOOK ?? "" })],
```

A complete one is in [examples/plugin](examples/plugin). Two things worth
copying from it: take what the plugin needs as options rather than reading the
environment at import time, and name the variable a token comes from rather
than the token itself, so a config stays committable. Anything a plugin can
check about its own configuration it should check when it is constructed, so a
mistake is a config that fails to load rather than a deploy that stops with the
swap ahead of it.

## Verifying a build

`redkite verify` is the same host, the same services and the same images as a
deploy, stopping where one would start moving addresses. It brings the network
and the services up, builds every app, and runs what each app declares instead
of swapping.

An app declares its checks. Nothing else is needed:

```ts
{
  name: "backend",
  // ...
  verify: {
    steps: ["yarn db:migrate", "yarn test:integration"],
    environment: { NODE_ENV: "test" },
  },
}
```

The commands run in the **builder** image, which is the one holding the test
runner and the dev dependencies. The runtime image has neither, and installing
them at check time would test a different tree. They run on the deployment
network, so a check reaches postgres at `postgres`, by the same alias the app
itself uses. They run in order and one at a time: the first is usually what
brings the test database to the schema the rest expect.

A test environment is a file like any other, and it publishes nothing:

```ts
// redkite.test.config.ts
export default defineEnvironment({
  branch: "pull-request",
  subnet: "172.254.0",
});
```

`publicPort` is absent because nothing in a verify run serves. That absence is
the whole declaration: an environment without one cannot deploy, so `plan` shows
it only the verify pipeline, leaves the proxy out of its service list, and
prints no nginx.

```
pipeline (verify)
  setup                     redkite
  build                     redkite
  verify                    redkite  backend
  cleanup                   redkite

services on the host (verify)
  acme-test-redis                   not there, will be created
```

Two things are refused before anything is built: a `verify` where no app
declares checks, and a `deploy` to an environment that names no `publicPort`.

Cleanup still runs, which is what keeps a CI host's disk from filling: it
reclaims every image of these apps except the ones this run built.

`verify:before:` and `verify:after:` are ordinary hook points, and `--local`,
`--full` and `--verbose` work the same as for a deploy.

## CLI

```
redkite <command> [environment]

  plan [environment]     Print the derived topology, the pipeline and the nginx
  deploy [environment]   Build, swap, health check, and revert on failure
  verify [environment]   Bring the services up, build, and run each app's checks
  rollback [environment] Put back any app a run moved and did not finish
  down [environment]     Stop everything this environment named

  --config <path>        Defaults to redkite.config.ts at the root of the project
  --local                Build the images here and ship them to the host
  --full                 No step view: every line of every step, in full
  --verbose              Every host command, and every line a build printed
  --version              Print the version and exit
```

The environment defaults to `staging`. `plan` reads the host to report drift and
changes nothing, so it is safe to run against production.

### Watching a deploy

On a terminal, `deploy` draws the run as a list of steps. The one running is
open and its output rolls under a title that stays put; a step that finishes
shuts to a single line carrying what it cost.

```
[01:18]   ✔ setup                                                             4s
[01:18]   ✔ build                                                             9s
[01:18] ❯ ▾ Building web  yarn build                                       1m09s
        │ #15 [builder 10/10] RUN yarn build
        │    ▲ Next.js 15.1.6
        │    Creating an optimized production build ...

↑↓ move · enter open · shift+↑ latest · + open · - collapse all · q quit
```

| Key | What it does |
| --- | --- |
| `↑` `↓` | Scroll the open step's output, then move between steps once it runs out |
| `enter` | Open or shut the step under the cursor. One opened by hand stays open when it finishes |
| `shift+↑` | Jump to the step running now, and follow it again |
| `shift+↓` | Jump to the first step |
| `+` | Open the step running now, from anywhere, and keep opening the ones after it |
| `-` | Shut everything, and stop opening what comes next |
| `q` | Stop the deploy. Press again to kill it |

The gutter counts the whole run; the number on the right counts the step, and
freezes at what it cost the moment it finishes. Nothing drawn on the alternate
screen survives it, so the run is written out again on the way out.

Colour separates where you are from what is happening. The step under the
cursor is cyan, the step running now is yellow, and a failed one is red and
outranks both, because that is the row you are looking for. The tick, the cross
and the arrow carry the step's own state, and the gutter, the timers and the
rule down the side of a log stay dim so the output reads above them. `NO_COLOR`
turns all of it off.

Every measurement happens before a colour is added: an escape is zero columns
wide, and a row measured with one in it is a row that wraps.

Every row is one terminal line. A line too long for the width is cut with an
ellipsis rather than wrapped, because a wrapped row pushes everything under it
out of a frame counted in rows. `--full` is the way to read the untrimmed thing:
no view, no collapsing, every line of every step streamed in full as it arrives.

A pipe, a CI log or `REDKITE_PLAIN=1` gets that same streamed form, with
`--verbose` adding every host command beside it.

Messages said outside a step show the most recent few. They used to all stay on
screen, which on a long run left no room for any step's output at all. All of
them are written out again when the view closes.

### Stopping a deploy

`q`, or ctrl+C without the view, asks the run to stop. Whatever command is in
flight is killed and the pipeline unwinds through its own failure path, so the
scratch directory on the host is removed and the connection is closed. The run
stops **between steps**, which is the unit that leaves the host in a state the
next deploy can read: a build that has not finished leaves the running
deployment exactly as it was.

**The deploy does not exit while the build is still running.** Every command runs
in a process group of its own, so one signal reaches the shell, the docker client
and the build behind it. Over ssh that group is on the other machine: killing the
local client there would only lose the reach, so each command records its group
as it starts and the signal is sent down the connection to it.

The first press sends `SIGTERM`. Every press after it sends `SIGKILL`. Each says
which, and the run keeps asking the host how many are still there until the
answer is none:

```
Stopping the build (SIGTERM). Press again to kill it
Waiting for 1 still running
Killing the build (SIGKILL). Nothing exits until it is gone
Stopped
```

A process that has taken `SIGKILL` and is still there is one redkite cannot end.
The fifth press says so and offers the way out rather than taking it, because
taking it leaves work running with nothing watching it:

```
This is not stopping. It has had SIGKILL and is still there.
Press again to leave redkite. That does not stop it: the build keeps running
on the host, may finish and tag an image no deploy is waiting for, and holds
the CPU and disk it is using. Nothing will clean up after it but you.
```

The sixth press leaves.

## GitHub Actions

There is a composite action in this repository. `verify` on a pull request,
`deploy` on merge:

```yaml
- uses: actions/checkout@v4
- uses: JVKdouk/redkite@v1
  with:
    command: deploy
    environment: production
    ssh-key: ${{ secrets.DEPLOY_KEY }}
  env:
    BW_CLIENT_ID: ${{ secrets.BW_CLIENT_ID }}
    BW_CLIENT_SECRET: ${{ secrets.BW_CLIENT_SECRET }}
    BW_PASSWORD: ${{ secrets.BW_PASSWORD }}
```

Whole workflows are in [examples/actions](examples/actions). The action sets
Node up, caches `~/.cache/redkite` so the pinned Bitwarden CLI is installed once
rather than every run, loads the key into an agent for the job, and runs a
pinned `redkite`.

The view stands down on its own: it wants a terminal on both stdout and stdin,
and a runner has neither, so what a job logs is one line per event.

A runner's `known_hosts` is empty every time, so the default `accept-new`
trusts the deploy host on first sight each run. `hostKeys: "strict"` there means
writing the key into `~/.ssh/known_hosts` before the deploy step.

**The key is only needed where something uses it.** A run that reaches a deploy
host, or clones over ssh, wants an agent holding one. A `verify` that builds
what the checkout already holds wants nothing: no host to reach, no clone. That
is what makes a pull request from a fork's branch testable without handing the
job a deploy key.

**Build on the host, not on the runner.** The obvious move is to point an app at
the checkout the job already has, and it is usually the wrong one: a runner is
thrown away, so BuildKit starts cold every time and the finished image has to be
shipped over ssh. An app that names a `repo` is cloned by the deploy host into a
mirror that is already warm, and nothing crosses the wire. Keep `path` for
`verify`, where the point is to test the tree in the pull request including what
was never pushed.

**Two runs would race.** Redkite holds no lock, so give the deploy job a
`concurrency` group. Leave `cancel-in-progress` false on that one: a deploy
interrupted between retiring the old container and starting the new one is the
one state nothing downstream can reason about.

### Cancelling a run

A run that is **asked** to stop puts back whatever it moved. Everything from
retiring the old container to the health check is one guarded stretch, and an
abort anywhere in it reverts the apps that had already moved, on a connection
the stop cannot refuse.

A run that is **killed** never gets that far, which is what a cancelled job is:
SIGINT, then the job is torn down after a grace period. So the recovery has to
be something a different process can do, reading what the host is in rather
than what the dead run remembered. A retired container is the whole signal, and
that is what `rollback` looks for:

```yaml
- if: cancelled()
  uses: JVKdouk/redkite@v1
  with:
    command: rollback
    environment: production
    ssh-key: ${{ secrets.DEPLOY_KEY }}
```

It does nothing when nothing was interrupted, so it is safe to leave in the
workflow. `down` is its counterpart for an environment that exists to be built
against rather than served from: it stops that environment's containers, the
derived proxy included, and stops rather than removes them so the next run
adopts them where it left off.

The build itself is still the one thing a killed job cannot take back with it:
it keeps going on the deploy host. Nothing inside the job can change that.

## How a deploy runs

Everything happens on the deploy host, over a single multiplexed ssh connection
with the agent forwarded.

1. **Setup.** Creates the network, then adopts or builds each service.
2. **Resolve.** `git remote update` into a mirror under `~/.cache/redkite`, then
   `rev-parse` the branch. That commit is what the image is tagged by.
3. **Check out.** A working tree sharing the mirror's object store, submodules
   followed to the branch `.gitmodules` names.
4. **Build.** The pipeline is rendered as a Dockerfile beside the checkout and
   handed to the BuildKit already inside the daemon. Skipped entirely when the
   host is already holding this exact image.
5. **`swap:before`.** Anything hung here runs while the old containers are still
   serving. A migration is the usual one, and it throws, so a failure retires
   nothing.
6. **Swap.** The running container moves to the retired address without being
   stopped and is renamed, and only then does the live address belong to the new
   one. Nginx keeps the retired container as a backup upstream.
7. **Check.** Each app is probed on itself. One failure reverts all of them.
8. **Cleanup.** Retired containers removed, superseded images reclaimed.

A `verify` run walks the same list without steps 5 to 7. In their place it runs
each app's declared checks, so nothing it does touches what is serving.

An image the host already holds is not rebuilt. The tag covers the commit, the
pipeline, the build spec, the environment file and every credential file, so a
change to any of them is a new image and a change to none of them is a swap with
no build at all.

## Design

Everything is derived from the app list, which is what makes the constants block
and the hand-written nginx template stop existing.

Redkite talks to a machine through one small port: run a shell command, write a
file. `sshHost` implements it over a multiplexed ssh connection, `localHost`
over child processes, and nothing else in the library knows which is in use.
That is why the whole orchestration is asserted against a recorder rather than a
server, and why deploying to another machine and deploying to this one differ in
nothing but which of the two the CLI constructs.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the layout of the source, how the
tests are organised, and what to run before opening a pull request.

## License

[MIT](./LICENSE) © Joao Kdouk
