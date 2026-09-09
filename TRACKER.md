# Tracker

Two changes. Nothing here is optional; the boxes are the order I work in.

## A. Building on this machine instead of on the host

- [x] A1 `src/shell.ts`: one process runner, since `localHost` and `sshHost` had
      near-identical copies and shipping an image needs a third caller
- [x] A2 `Host.pipe(local, remote)`: feed a local command's output into a command
      on the host. `sh` and `write` cannot express a 300MB stream
- [x] A3 `Environment.buildOn: "host" | "local"`, defaulting to `"host"`
- [x] A4 `BuildContext.deliver`: the daemon and host an image has to reach when
      it is not the one that built it. The skip check asks the runner, not the
      builder, or a locally cached image is never shipped
- [x] A5 `deploy.ts` opens one local host for the build step and closes it after
- [x] A6 Ignore `buildOn: "local"` when the deploy host is already this machine
- [x] A7 Tests: the skip check, the ship, and the argv that carries it

## B. The step viewer

- [x] B1 `Task.line(text)`: a line a step produced. `detail` replaces, this
      appends, and the build's own output is what has to land under a step
- [x] B2 `src/cli/screen.ts` model: steps, cursor, expansion, offsets, minimal
- [x] B3 Pure `render(model)` answering with rows, so the whole view is testable
      without a terminal
- [x] B4 Sticky title: the window starts at the focused step's title row, so
      logs roll under a header that does not move
- [x] B5 Keys: up, down, shift+up, enter, `+`, `-`, ctrl+c
- [x] B6 Rolling timer per step, frozen on completion; total elapsed in the gutter
- [x] B7 Help footer
- [x] B8 Terminal driver: alternate screen, raw mode, redraw timer, restore on exit
- [x] B9 `createLog()` uses it on a TTY, keeps the line writer otherwise
- [x] B10 Retire `src/cli/live.ts`
- [x] B11 Tests for the model and the renderer

## C. Verification

- [x] C1 A real Next.js app, deployed, with its build output visible under a step
- [x] C2 Local building end to end against a real daemon
- [x] C3 Full suite, typecheck, release gate

## Found while verifying, and fixed

- A pty whose size nobody set reports 0 rows, not nothing. The view fell back to
  one row and showed only the step under the cursor
- `log.close()` was never called, so the process drew frames forever after the
  deploy finished
- Two keys pressed quickly arrive as one read. Matching the whole chunk matched
  neither, so `up` then `enter` did nothing

## Not verified end to end

- Local building over a real ssh connection. There is no sshd on this machine,
  so the ssh half is asserted on the argv it builds and the pipe itself was
  proved against a real daemon

## Follow-up, done

- [x] Abort: `q` or SIGINT stops the run, kills what is in flight and unwinds
      through the normal failure path. A second press exits at once
- [x] `--local`, the flag form of `buildOn: "local"`
- [x] Log lines cut to the terminal with an ellipsis, one row each
- [x] `--full`: no view, no collapsing, every line in full

## Found while verifying that, and fixed

- A title row was one column too wide when the label filled the gap exactly
- Message rows were never cut at all
- `ssh-add` printed into the drawn frame. The agent now opens before the view
- `test/discover.test.ts` left a temp tree per run: 1212 of them had built up

## Nothing left running after a cancel

- [x] Every child spawned `detached`, so a stop signals its whole process group
- [x] `signalEverything()` signals every group and answers with the count
- [x] Remote commands wrapped in `set -m` to get a process group on the far
      side, with the pid recorded in the deploy's directory
- [x] `Host.stop(signal)` signals what that host started and answers with how
      many are left. `spawnCollect` settles on `close` and nothing else, so the
      promise is the proof the process has gone
- [x] The CLI waits on that count and never exits above zero. One press sends
      TERM, every press after it sends KILL, and each says which

Proved against a real daemon: aborted 20s into a cold `next build`, then watched
for 80 seconds. No image ever appeared, and no docker process survived. Each half
was removed in turn to check the tests fail without it.

## The way out, and environments as files

- [x] Five presses says what leaving costs and offers it; the sixth leaves
- [x] `environments` removed from the config surface. `defineDeployment` refuses
      it at compile time, and the loader is the only thing that fills it
- [x] The example split into redkite.config.ts and one file per environment

## Three ways to say where an environment is

- [x] `environment` on the define object: one environment, no file. It overrides
      whatever the files say, for whatever name was asked for
- [x] `package.json` `redkite.directory`: all of them in a directory of its own
- [x] `package.json` `redkite.environments`: each one at the path it lives at,
      read against the manifest that named it
- [x] Both refusals: a path that is not there, and an environment named in
      package.json that also sits beside the deployment

## The verify run

- [x] `verify` is a phase of its own, and a run is a named list of phases.
      `RUNS.deploy` walks setup, build, swap, cleanup; `RUNS.verify` walks
      setup, build, verify, cleanup. Nothing else in the pipeline changed shape
- [x] `AppSpec.verify` is the whole config surface: the commands, the network
      they attach to, and the environment they need
- [x] The commands run in the builder image, on the deployment network, in
      order, one at a time. A non-zero exit fails the run and says which command
- [x] No proxy in a verify run: nothing serves, so the derived nginx would
      resolve upstreams that were never created and publish a port for them
- [x] `Environment.publicPort` is optional. Its absence is what says an
      environment is verify-only, and `plan` derives the rest from that
- [x] Two refusals before anything is built: a verify where no app declares
      checks, and a deploy to an environment naming no publicPort
- [x] Cleanup runs in both, so a CI host reclaims the previous run's images
- [x] `plan` prints one pipeline per run the environment can be asked for, and
      reports drift against that run's service set

11 tests in test/verify.test.ts, plus the two refusals and the service set.
Each new behaviour was removed in turn to check its test fails without it.

## Colour in the step view

- [x] The step under the cursor is cyan, the step running is yellow, a failed
      one is red and outranks both
- [x] Tick, cross and arrow carry the step's state; gutter, timers and the log
      rule are dim; a warning is yellow
- [x] Every width is measured on the plain text and the escapes are added
      afterwards, so a painted row is exactly as wide as the plain one
- [x] `NO_COLOR` and a non-tty turn it off, and `render` paints only when asked

6 tests in test/screen.test.ts. Verified in a real pty: with the cursor moved
off the running step, both colours are on screen at once.

## Three things a real deploy showed

- [x] **The vault.** The CLI was reached through `npx --yes @bitwarden/cli@…`,
      which resolves the package again on every invocation, and unlocking is
      three commands plus one per secret. Measured here at 830ms of npx per
      call against 400ms for the binary. It is now installed once per machine
      per pinned version under `~/.cache/redkite/cli`, and called directly.
      Reaching "unlocking the vault" went from 4572ms to 4ms on the second run
- [x] **Messages crowded the logs out.** They only ever accumulated, and once
      `steps + messages` passed the terminal's height the view fell back to
      titles alone. On a 24-row terminal that was 15 messages, after which no
      step could show a log: the running one stopped streaming and opening an
      older one did nothing. The frame now carries the last 6, and the summary
      still writes out every one
- [x] **The focused step was served last.** `share` handed every other open
      step its glance first and gave the one being read the remainder, which on
      a build with several open steps was nothing. It is served first now, and
      a step that printed nothing no longer reserves a glance it cannot use

4 tests in test/screen.test.ts and 1 in test/secrets.test.ts. The rendering
fixes were each reverted to check their tests fail; the vault change is a
measurement rather than a test, because npx is not a seam the suite can drive.

## Building from a directory

- [x] `AppSpec.path` beside `repo`. Exactly one, refused at define time
- [x] `prepareSource` branches: a path is not cloned, checked out or cleaned,
      and the branch an environment names is never resolved for one
- [x] The release is `git write-tree` over a scratch index, so it covers
      committed, modified and untracked files and honours .gitignore. An
      uncommitted edit is a new release; an ignored file is not
- [x] A directory that is not a git work tree is refused, because without git
      nothing can say what is part of the release
- [x] The loader resolves a path against the deployment file, so a deploy from
      a workspace builds the same tree as one from the root
- [x] An app built from a path implies building here and shipping the image,
      because the source is on this machine
- [x] `plan` prints the source each app is built from

12 tests across source, topology and config. Proved end to end against a real
daemon: deployed a local tree, edited a file without committing it, redeployed
and the running container served the edit. An unchanged tree is cached, and a
change under an ignored node_modules is not a new release.

## Saying what ships

- [x] `AppSpec.include`, relative to `path`. Where git cannot answer, the
      deployment answers; where it can, an include still wins
- [x] One digest for both: a scratch bare repository whose work tree is the
      source. `git add -A` honours .gitignore, `git add -- <include>` takes the
      named paths, and neither writes an object into the source
- [x] The same list renders the .dockerignore, so the build context is exactly
      what the release was taken over. .git is excluded after the exemptions,
      because the last rule to match decides
- [x] Refusals: an include without a path, and an include naming nothing
- [x] A directory git knows nothing about is asked for an include rather than
      refused, and the message carries the line to add

Proved end to end against a real daemon, on a directory with no .git: refused
with the line to add, then built once given it. The 3MB node_modules and the
.env.local beside it reached neither the image nor the release, and editing
either left the deploy cached; editing an included file rebuilt it and the
container served the change.

## Deploying from GitHub Actions

- [x] The agent is asked for only where something uses it: a bastion to reach,
      or a repository cloned over ssh. A runner with no keys can deploy what it
      already holds, which it could not before
- [x] `ssh-add` failing says what to do about it rather than "Command failed"
- [x] `action.yml`, a composite action: node, the `~/.cache/redkite` cache, the
      key into an agent for the job, and a pinned `redkite`
- [x] `.github/workflows/check.yml` for this repository, and whole verify and
      deploy workflows in examples/actions for the one being deployed
- [x] README on what needs no key, why building on the host beats building on
      the runner, concurrency, and what a cancelled job leaves running

4 tests in test/config.test.ts, each reverted to check it fails. Proved with
stub ssh binaries: a keyless runner deploying what it holds now succeeds where
it used to throw, and one that does need a key says so usefully. The action's
script and its agent step were both run outside Actions, the second with a
throwaway key, to check the key reaches stdin rather than argv.

## Cancel safety

- [x] `Host.final`, a command the stop cannot refuse, and `finalHost` to hand a
      whole Docker that exemption. Putting a swap back is work the abort itself
      created, so the abort must not be what blocks it
- [x] The swap is one guarded stretch from retiring to the health check. An
      abort anywhere in it puts back the apps that had already moved, each on
      its own so one failing does not strand the rest
- [x] `revert` clears the failed slot first. An interrupted run leaves one, and
      rename refuses rather than clobbers, so without this the new container
      stayed live and the old one never got its name back
- [x] `revert` no longer starts what was never there, which is the first-deploy
      crash that has been open since the health check was written
- [x] `rollback`, for the run that was killed rather than asked. A retired
      container is the whole signal, and it reads that from the host
- [x] `down`, stopping an environment's containers including the derived proxy.
      Stopped rather than removed, so the next run adopts them
- [x] Both wired into the example workflows, on `if: cancelled()` and
      `if: always()`

Proved against a real daemon twice over. Asked to stop mid-swap: "Putting 1
back where they were", and the site went from the half-swapped release back to
the one that was serving. Killed with SIGKILL mid-swap so nothing in-process
ran: `rollback` from a fresh process put it back and parked the failed one.
Both commands are safe to repeat and say so when there is nothing to do.

## Snapshotting a database before a swap

- [x] `rdsSnapshot`, through the AWS CLI. Instance or cluster, never both, and
      waiting is opt-in because RDS captures the data when it begins
- [x] `digitalOceanSnapshot`, over the REST API. Volume or droplet, and the
      token is named rather than given
- [x] Both sit at `swap:before`, so they run while the old containers serve and
      above the migrate the config lists after them
- [x] Both check what they can before the run starts

13 tests through an injected provider, each reverted to check it fails. Run end
to end in a real deploy: the pipeline ordered snapshot, then migrate, then swap,
and the recorded argv was the one the AWS CLI would have received.

**Not verified against the real providers.** There are no AWS or DigitalOcean
credentials here, so what is tested is the request each plugin builds, not the
answer either service gives back. DigitalOcean's managed-database backups being
list-only is the reason the plugin snapshots a disk instead, and that is worth
confirming before anyone relies on it.

## Plugins, and the vault as one of them

- [x] `Plugin`: a name, steps, and a store per provider tag. `Deployment.plugins`
      is the only way any of it reaches a run
- [x] `definePlugin` checks the plugin's own points where it is written, so a
      typo is the plugin's failure rather than the deployment's
- [x] Registered twice is refused, and so is a second plugin claiming a
      provider another already resolves
- [x] A plugin's steps and the deployment's own are checked against one another,
      because they share one space of points
- [x] Plugin steps lead, so a snapshot listed as a plugin runs above the
      migration written under steps
- [x] `bitwarden()` is the plugin; `bitwarden.item()` is the pointer an app
      uses. A ref naming a provider nothing registers is refused before the
      build, rather than reaching for a vault by name
- [x] `secrets` defaults to true and unlocks with `BW_KEY`, falling back to the
      api credentials. A string is a session handed in directly; false
      registers the plugin without a store
- [x] Both snapshot plugins answer with a Plugin, and check their target when
      they are constructed rather than when the run starts
- [x] `plan` prints what was opted into, what each plugin resolves, and which
      plugin each step came from

23 tests across plugin, plugins and secrets, each reverted to check it fails.
Proved live: a deployment naming a bitwarden item without registering the vault
is refused with the line to add; BW_KEY skips login and unlock; and the example
plugin package, installed into node_modules, ran its step after a real swap and
posted what it released.

**Found while writing this.** Node refuses to strip types under node_modules,
so a plugin package cannot ship .ts the way a config can. It has to be compiled,
which the example package and the README now both say.

## The environment never enters an image

- [x] The build-time .env is mounted onto each step at the app's root rather
      than copied into the tree. A copied file is in that layer for good, and
      rm only hides it behind a later one
- [x] The app container is handed `--env-file` when it is created, the same way
      a service already was. `process.env`, not a file
- [x] Migrations and verify checks are handed one too: the builder image no
      longer carries a .env for them to find
- [x] `sourcemaps` and `sentry()` removed. Their whole job was to scrub a token
      out of a shipped .env, and nothing ships one now

Proved against a real daemon on `output: "/app"`, the one shape that used to
copy the whole tree and the .env with it. A build step asserting the file
exists passed, so the mount is there; the runtime image has no .env in any
layer and neither does the builder; the running container answered with the
secret, read from process.env; and the scratch file docker read went with the
deploy. An explicit `cp .env shipped.env` still ships one, which is the way in
if you want it.

**Two defects this closed.** The secrets never reached the runtime container at
all for any app with a nested output, which is every nodeApp and Next
standalone. And any app with `sourcemaps` and a nested output failed to build
outright, the bundled example's backend included.

## The name, and the host's key

- [x] `redkite` everywhere. The registry already had it under this repo, and
      the docs were the only thing still saying otherwise
- [x] `DeployHost.hostKeys`: accept-new by default, strict, or off. The deploy
      connection was checking nothing at all, which is the one connection a
      vault's contents travel over
- [x] `BatchMode=yes` under all three, so ssh can never ask a question that
      nobody is there to answer

4 tests in sshHost, each reverted to check it fails, and the argv proved with a
fake ssh on PATH: accept-new by default, no when told off, yes when told strict.
Cloning stays accept-new: that connection reaches GitHub rather than you, and
making it strict would mean managing github.com's key on every deploy host.

## What an app is built from, and which files are environments

- [x] `AppSpec.branch`, `tag` and `commit`, at most one, overriding the
      environment's branch. Two of them named at once is refused: they are
      different commits and picking one is not redkite's to do
- [x] A branch resolves under refs/heads, a tag under refs/tags and peeled, a
      commit as it stands and checked that it is one. The failure says which
      kind was missing rather than always saying "branch"
- [x] An environment still says only `branch`: a tag is a claim about one
      repository, and an environment spans every app
- [x] Any file beside the deployment starting with redkite and loadable by node
      is an environment. redkite.staging.ts, redkite-staging.ts and
      redkite_staging.config.ts all read as staging
- [x] A name that cannot be one is refused rather than skipped, which is what
      made a file look as though it was not there. The deployment itself is
      never read as an environment called config

15 tests across discover, source and topology, each reverted to check it fails.
Proved against a real bare repository with a tag two commits behind head: the
branch built a7eb50a6d300 and both the tag and the pinned commit built
dfc55e38768b, read off the image tags rather than the log.

**Not the bug that was reported.** redkite.staging.config.ts in a directory
package.json points at was already found; every shape that failed was a
different spelling. If it is still not found, the file is somewhere the
deployment is not, and nothing looks there.

## The proxy is configurable, and its name is reserved

- [x] `nginx()` and `ProxySpec`, replacing the loose `proxyImage` and
      `maxBodySize`: one place to say what the proxy is rather than three
- [x] `server` and `location` snippets, rendered into the server block and
      into every location
- [x] A hand written line replaces the derived one rather than repeating it.
      nginx refuses a duplicate proxy_read_timeout outright, so appending would
      have been a config that fails to start
- [x] A header's own name is part of what identifies a line, so several
      proxy_set_header are kept and only the one named twice is replaced
- [x] `listen` in a server block is refused: the published port maps onto it
- [x] A service called nginx is refused. It collided with the derived proxy
      silently, two containers planned on one name at two addresses

9 tests, each reverted to check it fails. The rendered file was put through
`nginx -t` in a real nginx:stable container, which is what found the duplicate
directive problem in the first version of this.

## Two silent phases, and a message in the wrong place

- [x] The git phase streams. prepareSource never passed onLine, so a clone, a
      fetch, a checkout and a submodule update said nothing at all
- [x] The vault reads say what they are doing. Every app read its secrets and
      its files before the first detail was emitted, so the step sat there
      looking dead for as long as the vault took
- [x] Messages sit where they were said rather than after every step. One from
      the first ten seconds used to sit below a build still running

Two apps building at once was proved in a real pty: both carry their detail and
their log. What could not be reproduced here is a build with no output at all,
which is what a remote deploy showed.

## Bitwarden is two services, and one of them was hanging

- [x] Neither CLI can be asked a question any more. Both ran with a pipe on
      stdin, so when bw decided the vault was locked it prompted for a master
      password and waited for ever. Nothing on stdin turns that into a failure
- [x] Output is collected raw rather than through the line reader, so a key
      that ends in a newline still does
- [x] `bitwarden({ secrets: true })`, the default, is Secrets Manager: BW_KEY is
      an access token. `secrets: false` is the password manager, where BW_KEY is
      a session and the api credentials obtain one otherwise
- [x] bws is downloaded once per machine from the release Bitwarden publishes.
      It is not an npm package, and the name on npm belongs to somebody else
- [x] Each vault read says which item it is on

Found by running against a real deployment: both build steps sat on "reading
its environment" for 30 seconds, which is the detail added an hour earlier.
Their BW_KEY is a Secrets Manager access token, and it was being handed to the
password manager as a session.

**Confirmed end to end on that deployment.** bws installed in a second, the
token authenticated, and `bws secret get` answered. What it answered was 404 for
the ids in that config, which is data rather than plumbing.

## A secret the app needs as a file

- [x] `files` makes the directory before copying into it. cp makes none, so a
      credential anywhere but beside the code failed the build outright. The
      bundled example only ever used /app, where the parent already exists

3 tests in dockerfile, reverted to check they fail. Proved against a real
daemon: /etc/creds/service-account.json landed r-------- owned by root, the
container read it, and it survived a restart.

## The build could not reach anything over ssh

- [x] `openssh-client` in the builder. Only git was installed, so a git+ssh
      dependency had no ssh to run
- [x] The agent forwarded in: `--ssh default` on the build and
      `--mount=type=ssh` on the install and every step
- [x] `GIT_SSH_COMMAND` with accept-new, because a builder has no known_hosts
      and a refusal on first sight is a dependency it cannot fetch
- [x] None of it when there is no agent: a mount with nothing behind it fails
      the build outright
- [x] Part of the fingerprint, and PIPELINE bumped to 5

All four were in the hand-written pipeline redkite replaced, transcribed in
bench/cache.ts, and all four were dropped. The comment saying nothing in the
build needs an agent is true of submodules, which the host resolves, and wrong
about the dependencies an install fetches.

Proved against a real daemon with `git ls-remote git@github.com:…` as a build
step: without an agent it failed with "Host key verification failed"; with one
it resolved and the image built.

## node_modules was in a cache mount

- [x] `node_modules` and the app's own `node_modules` out of the default
      `caches` on both presets. What an install writes has to be in the image,
      not on a mount BuildKit is free to empty
- [x] A preset test holding the defaults, reverted to check it fails when the
      module caches are put back

Found on a real build: `tsx` was in the dependencies and pinned to 4.19.2, the
build said it could not find it, and `npx tsx --version` answered 4.23.13, which
is npm fetching a copy rather than running the installed one. A cache mount is
evicted independently of the layer that filled it, so the install stayed cached
while the directory it wrote into went empty, and the build then ran against no
dependencies at all.

Proved against a real daemon: the build printed the pinned 4.19.2, and so did
the builder image afterwards with no mounts attached to it.

## Reading a run that is not going well

- [x] A spinner beside the running step, turning on the frame timer and stopping
      when the step does. A step that is slow and a step that is wedged were
      drawn identically
- [x] `quiet 45s` on a running step that has said nothing for a while. The row
      carries when the step last spoke, so silence is on screen rather than
      inferred from a clock that keeps moving
- [x] The gutter frozen at the step's own end, not the current time. Every row
      was counting up, including the ones that had finished
- [x] The points the run has still to walk, drawn under the steps that have
      started. The list is known before the run begins
- [x] `w` wraps the focused step's log instead of cutting it. The room a step is
      given is counted in rows once wrapping is on, or a single long line claims
      one row and loses the rest of itself
- [x] The failed step's last 20 lines written out when the view closes, with a
      count of what was dropped. The alternate screen takes the frames holding
      the reason with it
- [x] The caret gone and the brackets off the gutter: the cursor is a colour,
      and two glyphs for one thing is one too many

13 tests across the model, the renderer and the viewer's exit path, each
reverted to check it fails: the spinner frozen, the spinner still turning on a
finished step, the quiet notice removed, the points to come removed, the started
ones no longer filtered out, the wrap allowance counted in lines, the tail
dropped, the tail never trimmed, and the tail taken from every step.

## Docker's env file is not dotenv

- [x] `dockerEnv` parses the vault's text and writes the values, so `--env-file`
      gets `KEY=value` rather than `KEY="value"`. Docker keeps a quote it is
      given, and every url parser then rejects the scheme
- [x] `parseEnv` moved to `src/environment.ts`, where the thing that needs it
      lives. The cli's dotenv loader imports it rather than owning it
- [x] `parseEnv` reads a quoted value that runs past its own line. It used to
      keep the first line and silently drop the rest, which for a pem is a
      credential that looks present and is not
- [x] A value docker cannot carry is refused by name, not truncated
- [x] The `.env` mounted during the build is untouched: a dotenv parser reads
      that one, and it is the format it expects

Found deploying nebo-ignite: prisma answered P1013, "the scheme is not
recognized in database URL". The vault's entry had 27 quoted values in it, and
the migration was reading `"postgresql://...` with the quote still attached.
Every app redkite has deployed with a quoted vault entry has been running with
quoted values in its environment.

11 tests across the two formats, each reverted to check it fails: the text
handed over unchanged, the quotes left on, and a multi-line value truncated.

Confirmed by deploying nebo-ignite to staging end to end: the migration ran,
both apps swapped, and both answered their health check.

## A migrate option nobody read

- [x] `tunnel: { bastion, from, alias?, port? }` narrowed to `through`. Only
      `bastion` was ever read. The other three described an ssh forward that no
      longer happens, and `from` was required, so a config had to invent a value
      for it
- [x] Renamed with it: the object held one field, and what it checks is that the
      machine the migration goes through is the one this environment deploys to

An earlier migrate opened a forward through the bastion and rewrote the variable
`from` named to point at the forwarded alias. Running the step on the deploy
host with `--network host` replaced all of it, and the fields describing the
forward lost their reader without losing their place in the type.

Probed both ways: dropping the check fails the refusal, and inverting it fails
23, because the example config names its own bastion and every deploy test runs
that migration.
