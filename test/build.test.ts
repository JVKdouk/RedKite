import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
import type { AppSpec, BuildContext } from "../src/index.js";
import { build, Docker, topologyFor } from "../src/index.js";
import { fakeHost, RELEASE } from "./fakes.js";

const topology = topologyFor(config, "staging");
const frontend = config.apps.find((app) => app.name === "frontend")!;
const backend = config.apps.find((app) => app.name === "backend")!;

async function run(app: AppSpec, overrides: Partial<BuildContext> = {}) {
  const host = fakeHost();
  const target = topology.apps.find((item) => item.name === app.name)!;

  const result = await build(app, target, {
    host: host.host,
    docker: new Docker(host.host),
    env: "SENTRY_ORG=acme\n",
    files: {},
    branch: "staging",
    environment: "staging",
    ...overrides,
  });

  return { result, host };
}

const buildCommand = (commands: string[]) =>
  commands.find((command) => command.startsWith("build ") && !command.includes("--target"))!;

describe("build pipeline", () => {
  it("clones the branch the environment names, on the host itself", async () => {
    const { host } = await run(backend);
    const git = host.commands.filter((command) => command.includes("git "));

    assert.ok(git.some((c) => c.includes("git clone --mirror 'git@github.com:acme/backend.git'")));
    assert.ok(git.some((c) => c.includes("rev-parse 'refs/heads/staging'")));
    // Nothing is uploaded: the context is a directory the host already holds
    assert.match(buildCommand(host.commands), /\/cache\/redkite\/source\/acme-staging-backend$/);
  });

  it("fetches submodules only where the config asks for them", async () => {
    const withThem = await run(backend);
    const without = await run(frontend);

    assert.ok(withThem.host.commands.some((c) => c.includes("submodule update --init --remote")));
    assert.ok(!without.host.commands.some((c) => c.includes("submodule update")));
  });

  it("keeps the repository's own .git out of the build", async () => {
    const { host } = await run(backend);

    assert.equal(host.files.get("backend.Dockerfile.dockerignore"), ".git\n**/.git\n");
  });

  it("renders the pipeline beside the checkout rather than into it", async () => {
    const { host } = await run(backend);

    // A repository with a Dockerfile of its own keeps it, and git clean does
    // not have to be taught about a file redkite wrote
    assert.match(buildCommand(host.commands), /-f \/tmp\/redkite\/backend\.Dockerfile /);
    assert.ok(host.files.has("backend.Dockerfile"));
  });

  it("passes the environment as a secret rather than a file in the context", async () => {
    const { result, host } = await run(backend);
    const command = buildCommand(host.commands);

    assert.match(command, new RegExp(`--secret id=backend-env-${result.fingerprint},src=`));
    assert.equal(host.files.get("backend.env"), "SENTRY_ORG=acme\n");
    assert.doesNotMatch(command, /SENTRY_ORG/);
  });

  it("writes credential files as their own secrets", async () => {
    const { result, host } = await run(backend, { files: { "/app/google.json": "{}" } });
    const command = buildCommand(host.commands);

    assert.match(command, new RegExp(`--secret id=backend-file-0-${result.fingerprint},src=`));
    assert.match(host.files.get("backend.Dockerfile")!, /cp \/run\/secrets\/backend-file-0-\w+ \/app\/google\.json/);
  });

  it("tags the image by commit as well as by the name the container uses", async () => {
    const { result, host } = await run(frontend);
    const target = topology.apps.find((app) => app.name === "frontend")!;

    assert.equal(result.tag, `${target.container}:${RELEASE}-${result.fingerprint}`);
    assert.match(buildCommand(host.commands), new RegExp(`-t ${result.tag} -t ${target.container}`));
  });

  // A second build of the same source, exporting layers the first one already
  // produced. Nothing has to ask for it, so no step can find it missing
  it("keeps the builder as an image of its own", async () => {
    const { result, host } = await run(frontend);

    assert.ok(result.builderTag.includes("-builder:"));
    assert.ok(host.commands.some((c) => c.includes("--target builder")));
  });
});

describe("an image the host already holds", () => {
  async function second(app: AppSpec, overrides: Partial<BuildContext> = {}) {
    const first = await run(app, overrides);
    const host = fakeHost();
    const target = topology.apps.find((item) => item.name === app.name)!;

    // Whatever the last deploy of this commit left behind
    for (const image of first.host.images) host.images.add(image);

    const result = await build(app, target, {
      host: host.host,
      docker: new Docker(host.host),
      env: "SENTRY_ORG=acme\n",
      files: {},
      branch: "staging",
      environment: "staging",
      ...overrides,
    });

    return { result, host };
  }

  it("is not built again", async () => {
    const { result, host } = await second(frontend);

    assert.equal(result.cached, true);
    assert.deepEqual(host.commands.filter((c) => c.startsWith("build ")), []);
  });

  it("still takes the name the container is created from", async () => {
    const target = topology.apps.find((app) => app.name === "frontend")!;
    const { result, host } = await second(frontend);

    assert.ok(host.commands.includes(`tag ${result.tag} ${target.container}`));
  });

  it("is rebuilt when the builder it needs is missing", async () => {
    const first = await run(backend);
    const host = fakeHost();
    const target = topology.apps.find((app) => app.name === "backend")!;

    // A runtime image whose builder was reclaimed would otherwise migrate from
    // whichever release happened to be tagged last
    for (const image of first.host.images) {
      if (!image.includes("-builder")) host.images.add(image);
    }

    const result = await build(backend, target, {
      host: host.host,
      docker: new Docker(host.host),
      env: "SENTRY_ORG=acme\n",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    assert.equal(result.cached, false);
  });
});

// The host skips the build when it already holds the tag. Keying that on the
// commit alone served the previous pipeline's image forever: a fix to the build
// changed nothing the host could see, and the old image kept being deployed
describe("what the image is tagged by", () => {
  const fingerprintOf = async (app: AppSpec, overrides: Partial<BuildContext> = {}) =>
    (await run(app, overrides)).result.fingerprint;

  it("changes when the pipeline changes, not only when the commit does", async () => {
    const before = await fingerprintOf(backend);
    const after = await fingerprintOf({
      ...backend,
      build: { ...backend.build, output: "/app/elsewhere" },
    });

    assert.notEqual(before, after);
  });

  // dir renders a different Dockerfile without touching the build spec, so
  // without this the host answers with the image built from the old layout
  it("changes when the app moves inside the repository", async () => {
    assert.notEqual(
      await fingerprintOf(backend),
      await fingerprintOf({ ...backend, dir: "apps/api" }),
    );
  });

  it("changes when the environment file changes", async () => {
    assert.notEqual(
      await fingerprintOf(backend),
      await fingerprintOf(backend, { env: "A=2" }),
    );
  });

  // A secret mount is not part of a layer's cache key, so the fingerprint is
  // what has to reach BuildKit, and it reaches it through the secret's id
  it("changes when a credential file changes", async () => {
    assert.notEqual(
      await fingerprintOf(backend, { files: { "/app/google.json": "{}" } }),
      await fingerprintOf(backend, { files: { "/app/google.json": "{\"a\":1}" } }),
    );
  });

  it("is otherwise stable, so an unchanged deploy skips the build entirely", async () => {
    assert.equal(await fingerprintOf(backend), await fingerprintOf(backend));
  });
});
