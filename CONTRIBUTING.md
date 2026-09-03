# Contributing

## Getting set up

```sh
npm install
npm run build              # dist, what actually ships
npm test                   # 123 assertions, no host required
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

The package name is `redkite-cd` for now. `redkite` was published on
2026-09-03 at 19:00 UTC and unpublished a minute later, and npm blocks a name
for 24 hours after its last version is removed, so `redkite` is claimable again
from about 19:01 UTC on 2026-09-04.

**Version 0.1.0 is permanently burned on `redkite`.** npm never lets a version
number be republished under a name that once had it, unpublish or not. Moving
back therefore means `0.1.1` or higher, not `0.1.0`, and the move itself is:

1. `name` in `package.json`
2. the three badge URLs, the install line, and the two import specifiers in
   `README.md`
3. this section

Everything a user writes stays put: the command is `redkite`, the config is
`redkite.config.ts`. Only the install line and the import specifier move.

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
| `services/ensure.ts` | One primitive for redis and nginx |
| `secrets/` | `bitwarden(id)` refs, merge order, the CLI as a process |
| `health.ts` | One loop, `expect` supplied per app |
| `presets/` | `nextApp`, `nodeApp` |

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

`test/pipeline.test.ts` asserts redkite's four steps are ordinary members of the
list, and that a config replacing one takes its place.

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

**Services are adopted, never recreated.** `ensureService` returns early for a
container that already exists, so a rendered config only lands when the
container is created. Changing `maxBodySize` or adding an app writes an nginx
configuration the running proxy never sees.

**A deploy builds `origin/<branch>`, not your working tree.** Local commits that
are not pushed are not deployed.

**Health checks pass on containers that serve broken pages.** Verify a deploy
through the proxy on the published port, not just by the probe. A frontend once
served 404s for every one of its own JavaScript chunks while every health check
stayed green, because a carried directory had been flattened to its basename.
