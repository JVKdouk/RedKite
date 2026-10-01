# Changelog

What changed in each release, and what it means for a deployment you already
have. Versions follow [semver](https://semver.org). While this is `0.x` a minor
bump is where a breaking change is allowed to land, and every one of them is
marked **Breaking** below.

Entries up to and including 0.1.14 were reconstructed from the commit history
after the fact, so they say what a release changed rather than everything it
touched. From 0.1.15 on they are written as the work lands.

## Unreleased

### Added

- **A deployment can run without a proxy.** `proxy: false` plans no nginx, and
  stops and removes one an earlier deploy left holding the public port.
- **`ports` on the environment** publishes an app's port on the deploy host,
  keyed by app name. It lives on the environment rather than the app because two
  environments on one host cannot hold one port. An app with no entry is not
  published.
- **The proxy logs to files and to docker at once.** A log directory is now an
  addition to the container's output rather than a replacement for it, so
  `docker logs` keeps working while nginx also writes `access_log` and
  `error_log` to disk. `docker: false` keeps the files alone, and `access` and
  `error` name the files.
- **Steps run inside steps.** Cloning and building are drawn under `build`, and
  each health check and each container's logs under `swap`, indented two columns
  per level. Crash logs record the same depth.

### Changed

- **Breaking: proxy log `errors` is now `level`**, because `error` now names a
  file. Nothing had shipped under the old name.
- **`route` is optional on an app.** It is required when there is a proxy to
  resolve it and refused when there is not, since nothing would read it.
  `publicPort` is likewise not required without a proxy.
- **A parent step no longer says `quiet` while a child is still running.**
  `build` used to report `quiet 27s` while every app under it was compiling.
- **A published app's retired container is stopped just before the new one
  starts**, because a host port is held by one container at a time. That app is
  down for the swap: without a proxy there is nothing to hold traffic. An
  unpublished app swaps as it always did.

### Removed

- **The `GH` label, and the tag mechanism behind it.** A GitHub repository is
  named by its path alone and anything else by host and path, so `tag()`,
  `untagged()` and the pill in the view are gone.

### Refused at config time

A deployment that would have failed on a host now fails in `plan`: ports beside a
proxy, a `publicPort` without one, a port for an app that is not there, a port
that is not a port, two apps on one port, a log file name with no directory, a
log file name that is a path, `docker: false` with no directory, and both logs
naming one file.

## 0.1.14 (2026-09-15)

Nginx rendering moved into `services/proxy.ts` and gained real coverage, with the
rendered configuration now diffed against a fixture a person can read as nginx.

## 0.1.13 (2026-09-14)

Logging handling across the view, the crash record, the health checks and the
agent.

## 0.1.12 (2026-09-14)

Crash dumps: the complete record of a failed run, written while it happens, since
the view trims a step to its last lines and the alternate screen takes the rest
with it. One file per step, private to whoever ran it.

## 0.1.11 (2026-09-14)

Version bump only.

## 0.1.10 (2026-09-14)

Per-environment keys, `cli/dotenv.ts`, and a broad pass over the deployment
process, the config loader and the viewer.

## 0.1.9 (2026-09-09)

Fixes to branch name handling and to the environment files, across `source.ts`,
`build.ts` and the config loader.

## 0.1.8 (2026-09-09)

Version bump only, alongside an `action.yml` update.

## 0.1.7 (2026-09-09)

Database snapshot plugins and Bitwarden secrets: `secrets/`, `plugins/bitwarden`,
`plugins/rds`, `plugins/digitalOcean` and `plugins/snapshot`.

## 0.1.6 (2026-09-04)

The terminal view: `cli/screen.ts` as a pure model and renderer, `cli/viewer.ts`
as the terminal half of it, and `cli/agent.ts`.

## 0.1.5 (2026-09-03)

App root handling: `layout.ts`, and the two roots a Next standalone monorepo
build keeps apart.

## 0.1.3 (2026-09-03)

Swap steps and the per-step network.

## 0.1.2 (2026-09-03)

Extra hosts, the postgres service, and custom files.

## 0.1.1 (2026-09-03)

First published release.
