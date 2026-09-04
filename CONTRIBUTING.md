# Contributing

## Getting set up

```sh
npm install
npm run build              # dist, what actually ships
npm test                   # 268 assertions, no host required
npm run check              # tsc --noEmit, including the type-level assertions
npm run bench              # re-executed instructions, round trips, health wall clock
npm run plan               # against the bundled example config
```

Run `npm run check && npm test` before opening a pull request. `prepublishOnly`
runs both plus `scripts/verifyRelease.mjs`, so a publish cannot go out with a
failing test or an unfilled licence.

## Releasing

`prepublishOnly` runs `check`, `test` and `scripts/verifyRelease.mjs`, so a
publish cannot go out with a failing test or an unfilled licence.

## Layout

| Module | Does |
| --- | --- |
| `types.ts` | The config surface, every field commented |
| `config.ts` | `defineDeployment`, duplicate name and route validation |
| `topology.ts` | Every name and address, derived from the app list |
| `nginx.ts` | Renders upstreams and locations, uniform header policy |
| `pipeline.ts` | The points, what a step is handed, the runner |
| `host.ts` | The one port: a shell command, and a file written |
| `sshHost.ts` / `localHost.ts` | The two implementations of it |
| `source.ts` | Mirror, checkout, submodules, on the host |
| `dockerfile.ts` | The pipeline, rendered for BuildKit |
| `build.ts` | Resolve, render, build, tag, and skip when held |
| `docker.ts` | One snapshot, then network, image, container, builder |
| `deploy.ts` | The four steps redkite puts in the pipeline |
| `steps.ts` | Steps a config hangs around them, and the network they run on |
| `services/index.ts` | `redis`, `postgres`, and the specs they answer with |
| `services/ensure.ts` | One primitive for every service and for nginx |
| `services/planned.ts` | What should be running, its fingerprint, and drift |
| `secrets/` | `bitwarden(id)` refs, merge order, the CLI as a process |
| `cli/config.ts` | Discovery: the upward walk, `redkite.<env>.config.ts` |
| `cli/screen.ts` | The step viewer as a pure model and a pure renderer |
| `cli/viewer.ts` | The terminal half of it: raw keys, frames, restoring |
| `shell.ts` | One child process runner, shared by both hosts |
| `health.ts` | One loop, `expect` supplied per app |
| `presets/` | `nextApp`, `nodeApp`, and the two Next output layouts |
| `layout.ts` | Where a cache mounts, and where `dir` moves a path to |

Everything above takes a `Host`, so the whole orchestration is exercised against
a recorder. Only `sshHost` and `localHost` touch a real machine, and they are
the only two files a test cannot cover offline.

## What the tests hold in place

`test/topology.test.ts` writes out every name and address a deployment runs on
and asserts the derivation still answers with them, because two of them
colliding is a deploy that takes an app down. `test/nginx.test.ts` diffs the
rendered configuration against a file a person can read as nginx, so a change to
the renderer has to be looked at rather than merely re-recorded.

`test/deploy.test.ts` runs the whole orchestration against a fake host that
records every command, and asserts the swap happens in the only order that keeps
something answering: the old container moves to the retired address and is
renamed *without being stopped*, and only then does the live address belong to
the new one. It also asserts that one unhealthy app reverts all of them, because
a half-swapped deployment is the state nothing downstream can reason about.

`test/build.test.ts` and `test/dockerfile.test.ts` pin the two things a
Dockerfile gets wrong quietly. Dependencies are installed before the source is
copied, or a new commit rebuilds the toolchain. And the fingerprint is part of
every secret's id, because a secret mount is not part of a layer's cache key:
without it, a changed environment file is answered with the image built from the
old one.

`test/planned.test.ts` writes out every config change that has to reach a
running service, so a fingerprint that stops covering one fails here rather than
on a host that keeps serving the previous configuration.

`test/pipeline.test.ts` asserts redkite's four steps are ordinary members of the
list, that a config replacing one takes its place, and that every step's `check`
runs before the first step does.

`test/points.check.ts` is not a test. It is a file that only compiles if the
wrong step is impossible to write, so every `@ts-expect-error` in it fails the
build if the compiler stops catching what it names. `npm run check` is the
assertion.

## Things worth knowing before changing them

**Bump `PIPELINE` in `build.ts`** when the build changes shape without any
config changing. It is part of the image tag, and a host that trusts the commit
alone will keep serving the previous pipeline's output.

**A secret mount is not part of a layer's cache key**, which is why the
fingerprint is baked into every `--secret id=`. Drop it and a changed
environment file is answered with the image built from the old one.

**A shell-form `RUN` must not be quoted.** Docker hands everything after `RUN`
to `sh -c` already, so wrapping the step makes the whole command one word.

**Never reclaim `<container>:latest`.** It is the moving name every
`container create` resolves, not a version. Reclaiming it leaves a host that
cannot start the app it has just released, and it self-heals on the next deploy,
which is why it takes a real run to notice.

**A service is adopted because it matches, not because it is there.** Every one
is created with a `redkite.spec` label holding a fingerprint of everything a
recreate would change, the rendered files included. `ensureService` compares it
and recreates on a difference, and `plan` reports the same comparison without
touching anything. Docker cannot change a label without recreating, which is
exactly when the fingerprint changes, so there is nothing to keep in step.

**The fingerprint names secrets, it does not read them.** Whether the running
service is the one the config describes is a question a plan should answer
without unlocking a vault, so a changed ref counts and a rotated value does not.

**A step on the deployment network needs the aliases too.** Attaching the
network alone is not enough: a service answers to the alias the apps know it by,
which is an `--add-host`, not a network alias. `attachment("deployment", ...)`
carries both, and that is the whole reason it exists rather than a flag.

**A build is not the process you spawned, it is its child.** Signalling the
shell that ran `docker build` kills the shell; docker stays connected to the
daemon and the build carries on. Every child is spawned `detached`, which makes
it a process group leader, and a stop signals the group.

**Over ssh the group is on the other machine.** Killing the local client leaves
the far side running and takes away the only thing that could reach it, so a
stop is sent *through* the connection, not to it. Each command is wrapped in
`set -m; { … } &` to get a process group there, and its pid is written into the
deploy's directory. `host.stop()` signals those groups and answers with how many
are still alive.

**The count is the contract.** `spawnCollect` settles on the child's `close` and
on nothing else, and `host.stop()` answers with survivors, so a caller can wait
for exactly one thing: nothing left. An abort no longer kills anything by
itself; it only stops the next command being issued.

**An abort is not a kill.** Aborting the signal stops new commands. What is
already running is stopped by signalling it, which is the host's to do.

**The way out is offered, never taken.** Five presses means a process that has
had SIGKILL and is still there, which nothing here can end. `stopper` says what
leaving costs and waits for one more press, because leaving is the only outcome
that abandons running work.

**An environment is a file, or the one the deployment carries.** `environmentOf`
is the only place that decides which: the singular `environment` key overrides
every file, and `defineDeployment` takes `environments?: never`, so a config that
declares a set of them does not compile and the loader is the only thing that
fills that key. `test/points.check.ts` is what holds that in place, and
`test/deployment.ts` is where the example's files are assembled for the tests
that need a loaded config.

**Nothing else may write to the terminal while the view is up.** A child that
inherits stdio draws into the frame. `ssh-add` has to be able to ask for a
passphrase, so the agent is opened before the view rather than muted.

**The viewer decides nothing.** `screen.ts` is a model, `apply`, and `render`;
`viewer.ts` only reads keys, draws frames and restores the terminal. Anything
you can assert on belongs in the first, and `test/screen.test.ts` is where the
whole view is checked without a terminal.

**A pty reports 0 rows, not nothing.** `stream.rows ?? 24` leaves a one-row view
that can only show the step under the cursor. The fallback has to test the value,
not its absence.

**A terminal delivers a chunk, not a key.** Two arrows pressed quickly arrive as
one read, so the input is parsed as a sequence. Matching the whole chunk matched
neither of them.

**A missing `COPY` source fails the build, and that is usually what you want.**
`copy` is the plain form; `copyOrSkip` brackets the last character so the source
becomes a pattern, and a pattern matching nothing is skipped. Reach for
`copyOrSkip` only where absence is a fact about the repository, never where it
would mean the build produced nothing and said nothing.

**A cache mount is not in the image.** `node_modules` is a cache mount, so a
runtime that resolves its own dependencies finds the directory empty. That is
why `nextApp({ standalone: false })` drops the modules cache: the install has to
land in a layer.

**There are two roots, not one.** `dir` is where the app was built; `keepsLayout`
says whether the output tree put it back under that path or flattened it to the
top. The carry sources are rooted by the first and their destinations by the
second, and a Next standalone monorepo build is the case where they differ.

**`dir` moves the app, not the install.** Build steps and the shipped command
run in `/app/<dir>`, and every `/app` path in a build spec is read against it.
The dependency layer stays at the repository root, where a workspace lockfile
resolves every package at once.

**A migration runs in the builder image, not the runtime one.** The runtime
image holds only what the app compiled to, so every build keeps its builder
stage as a second tag. It is unconditional on purpose: a flag that has to be set
before a step can run is a flag that will be missing.

**A deploy builds `origin/<branch>`, not your working tree.** Local commits that
are not pushed are not deployed.

**Health checks pass on containers that serve broken pages.** Verify a deploy
through the proxy on the published port, not just by the probe. A frontend once
served 404s for every one of its own JavaScript chunks while every health check
stayed green, because a carried directory had been flattened to its basename.
