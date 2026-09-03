<h1 align="center">
  <img src="media/redkite.png" alt="redkite" width="200">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/redkite-cd"><img alt="npm version" src="https://img.shields.io/npm/v/redkite-cd.svg"></a>
  <a href="https://www.npmjs.com/package/redkite-cd"><img alt="npm downloads" src="https://img.shields.io/npm/dm/redkite-cd.svg"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/node/v/redkite-cd.svg"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/redkite-cd.svg"></a>
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
- [CLI](#cli)
- [How a deploy runs](#how-a-deploy-runs)
- [Design](#design)
- [Contributing](#contributing)
- [License](#license)

## Quick start

```sh
npm install redkite-cd
```

Add `redkite.config.ts` at the root of your project:

```ts
import { defineDeployment, nextApp, nodeApp, redis } from "redkite-cd";

export default defineDeployment({
  project: "acme",

  environments: {
    production: {
      branch: "main",
      subnet: "10.20.0",
      publicPort: 80,
      host: { bastion: "deploy@acme.example" },
    },
  },

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

Selected on the command line and threaded into every derived name.

| Field | Meaning |
| --- | --- |
| `branch` | The git ref each app is built from |
| `subnet` | First three octets. Redkite allocates the fourth |
| `publicPort` | The only port anybody outside ever types |
| `host.bastion` | `user@address` of the deploy host. Absent means this machine |
| `extraHosts` | Hostname to address, added to every container beside the derived ones |

`extraHosts` is for something the apps must resolve that redkite does not run:
a managed database, a legacy service, anything whose address is the thing that
differs between staging and production.

```ts
extraHosts: { "db.internal": "10.55.0.250" },
```

A name the deployment already resolves, an app's container or a service alias,
is refused rather than silently overridden. Redirecting one of those would send
its traffic somewhere else and the deploy would still look like it worked.

### Environments in files of their own

An environment can live beside the deployment instead of inside it, one file per
environment, named `redkite.<environment>.config.ts`:

```ts
// redkite.production.config.ts
import { defineEnvironment } from "redkite-cd";

export default defineEnvironment({
  branch: "main",
  subnet: "10.55.0",
  publicPort: 80,
  host: { bastion: "deploy@acme.example" },
});
```

Redkite finds them by name, so there is no list to keep in step. Drop the
`environments` key from `redkite.config.ts` entirely, or keep some there and put
others in files. Defining the same environment in both places is refused, since
nothing could say which one wins.

### Where the files live

By default `redkite.config.ts` sits at the root of the project, and a deploy run
from anywhere inside walks up to find it. A repository that would rather keep
them together says so in `package.json`:

```json
{
  "redkite": { "directory": "deploy" }
}
```

Then `deploy/redkite.config.ts` and `deploy/redkite.production.config.ts`. If
that directory holds no config, redkite stops and says so rather than carrying
on up the tree: naming a directory and not putting the files there is a mistake,
not a hint.

### Apps

| Field | Meaning |
| --- | --- |
| `name` | Becomes the container name, cache keys, volumes and nginx upstream |
| `repo` | Clone URL, fetched over the forwarded agent rather than with a token |
| `route` | The nginx location. `/` is the catch-all; `/api/` has its prefix stripped |
| `port` | The port the app listens on inside its container |
| `build` | How the repository becomes an image. See presets below |
| `health` | Probed on the container itself, not through the proxy |
| `secrets` | One ref or several, merged in order, written to `.env` in the image |
| `files` | Container path to the item whose contents land there |
| `volumes` | Volume name to container path, for state that outlives a deploy |

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

### Services

Long-lived containers shared by the apps, brought up once and adopted after
that. The proxy is not one of them: apps carry routes, routes imply exactly one
proxy, so it is derived rather than listed.

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
secrets: bitwarden("00000000-0000-4000-8000-000000000001"),
files: { "/app/service-account.json": bitwarden("...") },
```

A deployment reading from Bitwarden wants `BW_CLIENT_ID`, `BW_CLIENT_SECRET` and
`BW_PASSWORD` in the environment. One that does not needs nothing: redkite only
opens the stores your config actually names.

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

deploy:before:<name>
deploy                  redkite: before-swap, swap, health check, revert
deploy:<name>
deploy:after:<name>

cleanup:before:<name>
cleanup                 redkite: removes the retired containers and old images
cleanup:<name>
cleanup:after:<name>
```

**Nothing about redkite's four is privileged.** They sit at ordinary points, and a
config that registers a step at the same point replaces it. That is how one is
turned off: put something there that does less.

```ts
import { defineStep } from "redkite-cd";

export default defineDeployment({
  // ...
  steps: [
    defineStep("build:after:sourcemaps", async (built, context) => {
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
build, `ok` and `released` and `reverted` after deploy, `removed` and
`reclaimed` after cleanup.

What a step is handed is decided by where it runs, so the example above compiles
with no annotation and `built.apps` is known to exist. A step at a point in a
phase nobody defined does not compile, and a replacement for one of redkite's four
has to answer with what the rest of the run expects.

A plugin is a function answering with steps, the way `redis()` answers with a
service spec:

```ts
const slack = (webhook: string) => [
  defineStep("deploy:before:announce", async (built) => {
    await fetch(webhook, { method: "POST", body: `deploying ${built.apps.length} apps` });
    return built;
  }),
  defineStep("cleanup:after:notify", async (finished) => {
    await fetch(webhook, { method: "POST", body: `released ${finished.released.join(", ")}` });
    return finished;
  }),
];
```

Read whatever it needs where the config is loaded, so a missing value is a
config that fails rather than a deploy that gets most of the way through:

```ts
const webhook = process.env.SLACK_WEBHOOK;
if (!webhook) throw new Error("SLACK_WEBHOOK is not set");

export default defineDeployment({
  // ...
  steps: [...slack(webhook)],
});
```

## CLI

```
redkite <command> [environment]

  plan [environment]     Print the derived topology, the pipeline and the nginx
  deploy [environment]   Build, swap, health check, and revert on failure

  --config <path>        Defaults to redkite.config.ts at the root of the project
  --verbose              Every host command, and every line a build printed
  --version              Print the version and exit
```

The environment defaults to `staging`. `plan` needs no host and changes nothing,
so it is safe to run against production.

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
5. **Before-swap.** Your migration runs in the builder image on the host's own
   network, while the old containers are still serving. It throws, so a failure
   retires nothing.
6. **Swap.** The running container moves to the retired address without being
   stopped and is renamed, and only then does the live address belong to the new
   one. Nginx keeps the retired container as a backup upstream.
7. **Check.** Each app is probed on itself. One failure reverts all of them.
8. **Cleanup.** Retired containers removed, superseded images reclaimed.

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
