import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
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

    // A repository keeps its own Dockerfile, and git clean need not know about ours
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

  // A second build of the same source, exporting layers the first produced
  it("keeps the builder as an image of its own", async () => {
    const { result, host } = await run(frontend);

    assert.ok(result.builderTag.includes("-builder:"));
    assert.ok(host.commands.some((c) => c.includes("--target builder")));
  });
});

// A host too small to compile on, so the image is streamed over the open connection
describe("building on this machine", () => {
  it("ships every tag it built, in one archive", async () => {
    const builder = fakeHost();
    const runner = fakeHost();
    const target = topology.apps.find((app) => app.name === "frontend")!;

    const result = await build(frontend, target, {
      host: builder.host,
      docker: new Docker(builder.host),
      deliver: { host: runner.host, docker: new Docker(runner.host) },
      env: "",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    assert.equal(runner.piped.length, 1);
    assert.equal(
      runner.piped[0],
      `docker save ${result.tag} ${target.container} ${result.builderTag} | docker load`,
    );

    // Nothing was built on the machine the containers run on
    assert.ok(!runner.commands.some((command) => command.startsWith("build ")));
    assert.ok(builder.commands.some((command) => command.startsWith("build ")));
  });

  // The skip check cannot ask the daemon that compiled it
  it("skips the build only when the runner holds it", async () => {
    const target = topology.apps.find((app) => app.name === "frontend")!;

    const first = fakeHost();
    const built = await build(frontend, target, {
      host: first.host,
      docker: new Docker(first.host),
      env: "",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    // A machine that compiled it before, deploying to a host that never received it
    const builder = fakeHost();
    for (const image of first.host === builder.host ? [] : first.images) builder.images.add(image);

    const runner = fakeHost();
    const again = await build(frontend, target, {
      host: builder.host,
      docker: new Docker(builder.host),
      deliver: { host: runner.host, docker: new Docker(runner.host) },
      env: "",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    assert.equal(built.tag, again.tag);
    assert.equal(again.cached, false, "the runner has never seen it");
    assert.equal(runner.piped.length, 1);
  });

  it("does not ship when the runner already holds it", async () => {
    const target = topology.apps.find((app) => app.name === "frontend")!;

    const runner = fakeHost();
    await build(frontend, target, {
      host: runner.host,
      docker: new Docker(runner.host),
      env: "",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    const builder = fakeHost();
    const again = await build(frontend, target, {
      host: builder.host,
      docker: new Docker(builder.host),
      deliver: { host: runner.host, docker: new Docker(runner.host) },
      env: "",
      files: {},
      branch: "staging",
      environment: "staging",
    });

    assert.equal(again.cached, true);
    assert.deepEqual(runner.piped, []);
    assert.ok(!builder.commands.some((command) => command.startsWith("build ")));
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

    // Otherwise a migration runs from whichever release was tagged last
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

// Keyed on more than the commit, or a pipeline fix would change nothing visible
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

  // dir changes the Dockerfile alone, which the tag still has to reflect
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

  // A secret mount is not a cache key, so the fingerprint travels in its id
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

// The release is what the tree holds; the context is what the deployment named
describe("building from a directory", () => {
  const local: AppSpec = { ...backend, repo: undefined, path: "/home/jvck/work/api" };

  it("builds the directory rather than cloning it", async () => {
    const { host } = await run(local);

    assert.ok(!host.commands.some((command) => command.includes("git clone")));
    assert.ok(host.commands.some((command) => command.includes("write-tree")));

    const context = buildCommand(host.commands).split(" ").at(-1);
    assert.equal(context, local.path);
  });

  // Narrowing the release alone would hand BuildKit an unrelated node_modules
  it("holds the context to what the app said ships", async () => {
    const { host } = await run({ ...local, include: ["src", "package.json"] });
    const written = host.files.get("backend.Dockerfile.dockerignore") ?? "";

    assert.ok(written.startsWith("*\n"), written);
    assert.ok(written.includes("!src"), written);
    assert.ok(written.includes("!package.json"), written);
  });

  it("leaves the context to the work tree when nothing was named", async () => {
    const { host } = await run(local);
    const written = host.files.get("backend.Dockerfile.dockerignore") ?? "";

    assert.equal(written, ".git\n**/.git\n");
  });
});

// Without --ssh the mount has nothing behind it, and git dependencies fail
describe("forwarding the agent into the build", () => {
  it("asks docker for it when there is one", async () => {
    const { host } = await run(backend, { agent: true });
    const command = buildCommand(host.commands);

    assert.match(command, /--ssh default/);
  });

  it("asks for none when there is not", async () => {
    const { host } = await run(backend, { agent: false });

    assert.ok(!buildCommand(host.commands).includes("--ssh"));
  });

  // It changes the Dockerfile, so the image differs from one built without it
  it("is part of what the image is tagged by", async () => {
    const without = await run(backend, { agent: false });
    const with_ = await run(backend, { agent: true });

    assert.notEqual(without.result.fingerprint, with_.result.fingerprint);
  });
});
