import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { discover, loadConfig, loadEnvironments } from "../src/cli/config.js";

// One file at the project root, run as often from a workspace inside it

// Every tree this makes, so the suite leaves none behind
const made: string[] = [];

after(async () => {
  await Promise.all(made.map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: string[] | Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "redkite-discover-"));
  made.push(root);
  const entries = Array.isArray(files)
    ? Object.fromEntries(files.map((file) => [file, "export default {};\n"]))
    : files;

  for (const [file, contents] of Object.entries(entries)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), contents);
  }

  await mkdir(join(root, "apps", "web"), { recursive: true });
  return root;
}

describe("finding the config", () => {
  it("reads the one at the root of the project", async () => {
    const root = await project(["redkite.config.ts"]);

    assert.equal(discover(root), join(root, "redkite.config.ts"));
  });

  it("finds it from a workspace inside the project", async () => {
    const root = await project(["redkite.config.ts"]);

    assert.equal(discover(join(root, "apps", "web")), join(root, "redkite.config.ts"));
  });

  // A project not written in TypeScript still has a deployment
  it("takes a config that is plain JavaScript", async () => {
    const root = await project(["redkite.config.mjs"]);

    assert.equal(discover(root), join(root, "redkite.config.mjs"));
  });

  it("prefers the nearest one to the one above it", async () => {
    const root = await project(["redkite.config.ts", "apps/web/redkite.config.ts"]);

    assert.equal(
      discover(join(root, "apps", "web")),
      join(root, "apps", "web", "redkite.config.ts"),
    );
  });

  // For a repository that would rather not keep them at its root
  it("takes the directory package.json points at", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "deploy" } }),
      "deploy/redkite.config.ts": "export default {};\n",
    });

    assert.equal(discover(root), join(root, "deploy", "redkite.config.ts"));
    assert.equal(discover(join(root, "apps", "web")), join(root, "deploy", "redkite.config.ts"));
  });

  // A named directory must exist, but need not hold the deployment itself
  it("keeps looking when the directory it was pointed at holds no deployment", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "deploy" } }),
      "deploy/.keep": "",
      "redkite.config.ts": "export default {};\n",
    });

    assert.equal(discover(root), join(root, "redkite.config.ts"));
  });

  it("stops when the directory it was pointed at is not there at all", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "gone" } }),
      "redkite.config.ts": "export default {};\n",
    });

    assert.throws(() => discover(root), /points redkite at .*gone, which is not there/);
  });

  it("ignores a package.json that says nothing about redkite", async () => {
    const root = await project({
      "package.json": JSON.stringify({ name: "app" }),
      "redkite.config.ts": "export default {};\n",
    });

    assert.equal(discover(root), join(root, "redkite.config.ts"));
  });

  it("says what it looked for when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "redkite-discover-"));
    made.push(root);

    assert.throws(() => discover(root), /No redkite\.config\.ts found/);
  });
});

// What differs between staging and production is a file, not a nested key
describe("environments in files of their own", () => {
  const environment = (branch: string) =>
    `export default { branch: "${branch}", subnet: "10.0.0", publicPort: 80 };\n`;

  it("reads one file per environment, named by the file", async () => {
    const root = await project({
      "redkite.config.ts": "export default {};\n",
      "redkite.staging.config.ts": environment("staging"),
      "redkite.production.config.mts": environment("main"),
    });

    const found = await loadEnvironments(root);

    assert.deepEqual(Object.keys(found).sort(), ["production", "staging"]);
    assert.equal(found.staging?.branch, "staging");
    assert.equal(found.production?.branch, "main");
  });

  it("does not mistake the deployment itself for an environment", async () => {
    const root = await project({ "redkite.config.ts": "export default {};\n" });

    assert.deepEqual(await loadEnvironments(root), {});
  });

  it("refuses one environment written twice", async () => {
    const root = await project({
      "redkite.staging.config.ts": environment("staging"),
      "redkite.staging.config.mts": environment("staging"),
    });

    await assert.rejects(
      () => loadEnvironments(root),
      /staging is defined by both/,
    );
  });
});


// Said once, in the manifest the repository already has
describe("environments package.json names", () => {
  const deployment = 'export default { project: "p", services: [], apps: [] };\n';
  const environment = (branch: string) =>
    `export default { branch: "${branch}", subnet: "10.0.0", publicPort: 80 };\n`;

  it("reads each one from the path it was pointed at", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        redkite: { environments: { production: "./envs/live.mjs" } },
      }),
      "redkite.config.mjs": deployment,
      "envs/live.mjs": environment("main"),
    });

    const config = await loadConfig(join(root, "redkite.config.mjs"));

    assert.deepEqual(Object.keys(config.environments ?? {}), ["production"]);
    assert.equal(config.environments?.production?.branch, "main");
  });

  it("reads them beside a deployment that also has files of its own", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        redkite: { environments: { production: "./envs/live.mjs" } },
      }),
      "redkite.config.mjs": deployment,
      "redkite.staging.config.mjs": environment("staging"),
      "envs/live.mjs": environment("main"),
    });

    const config = await loadConfig(join(root, "redkite.config.mjs"));

    assert.deepEqual(Object.keys(config.environments ?? {}).sort(), [
      "production",
      "staging",
    ]);
  });

  // One environment, two files, and nothing to say which wins
  it("refuses an environment that is in both places", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        redkite: { environments: { staging: "./envs/other.mjs" } },
      }),
      "redkite.config.mjs": deployment,
      "redkite.staging.config.mjs": environment("staging"),
      "envs/other.mjs": environment("elsewhere"),
    });

    await assert.rejects(
      () => loadConfig(join(root, "redkite.config.mjs")),
      /comes from one place or the other/,
    );
  });

  it("refuses a path that is not there rather than deploying without it", async () => {
    const root = await project({
      "package.json": JSON.stringify({
        redkite: { environments: { production: "./envs/missing.mjs" } },
      }),
      "redkite.config.mjs": deployment,
    });

    await assert.rejects(
      () => loadConfig(join(root, "redkite.config.mjs")),
      /which is not there/,
    );
  });
});

// Read and refused rather than passed over as though it were not there
describe("which files beside the deployment are environments", () => {
  const env = (name: string) => `export default { branch: "${name}", subnet: "10.0.0", publicPort: 80 };\n`;

  it("reads the shape the docs use", async () => {
    const root = await project({ "redkite.staging.config.ts": env("staging") });

    assert.deepEqual(Object.keys(await loadEnvironments(root)), ["staging"]);
  });

  it("reads one that leaves the config out of the name", async () => {
    const root = await project({ "redkite.staging.ts": env("staging") });

    assert.deepEqual(Object.keys(await loadEnvironments(root)), ["staging"]);
  });

  it("reads a hyphen or an underscore where the dot would be", async () => {
    const dashed = await project({ "redkite-staging.ts": env("staging") });
    const scored = await project({ "redkite_staging.config.ts": env("staging") });

    assert.deepEqual(Object.keys(await loadEnvironments(dashed)), ["staging"]);
    assert.deepEqual(Object.keys(await loadEnvironments(scored)), ["staging"]);
  });

  it("reads every module extension node can load", async () => {
    const root = await project({ "redkite.staging.config.mts": env("staging") });

    assert.deepEqual(Object.keys(await loadEnvironments(root)), ["staging"]);
  });

  // It is the deployment, not an environment called config
  it("never reads the deployment itself as one", async () => {
    const root = await project({
      "redkite.config.ts": "export default {};\n",
      "redkite.staging.config.ts": env("staging"),
    });

    assert.deepEqual(Object.keys(await loadEnvironments(root)), ["staging"]);
  });

  it("leaves alone what was never addressed to redkite", async () => {
    const root = await project({ "vite.config.ts": "export default {};\n" });

    assert.deepEqual(Object.keys(await loadEnvironments(root)), []);
  });

  // A tag cannot hold a capital, and skipping it silently hid the file
  it("refuses a name that cannot be one, rather than skipping it", async () => {
    const root = await project({ "redkite.Staging.config.ts": env("staging") });

    await assert.rejects(() => loadEnvironments(root), /cannot name one/);
  });

  it("still refuses one environment defined twice", async () => {
    const root = await project({
      "redkite.staging.config.ts": env("staging"),
      "redkite.staging.ts": env("staging"),
    });

    await assert.rejects(() => loadEnvironments(root), /defined by both/);
  });
});

// The deployment may sit at the root with the environments under one roof
describe("environments in the directory package.json names", () => {
  const env = `export default { branch: "staging", subnet: "10.0.0", publicPort: 80 };\n`;
  const points = JSON.stringify({ redkite: { directory: "deploy" } });

  it("reads them when the deployment sits above them", async () => {
    const root = await project({
      "package.json": points,
      "redkite.config.ts": "export default {};\n",
      "deploy/redkite.staging.config.ts": env,
    });

    assert.equal(discover(root), join(root, "redkite.config.ts"));

    const config = await loadConfig(join(root, "redkite.config.ts"));
    assert.deepEqual(Object.keys(config.environments ?? {}), ["staging"]);
  });

  it("still reads them when the deployment is in there too", async () => {
    const root = await project({
      "package.json": points,
      "deploy/redkite.config.ts": "export default {};\n",
      "deploy/redkite.staging.config.ts": env,
    });

    assert.equal(discover(root), join(root, "deploy", "redkite.config.ts"));

    const config = await loadConfig(join(root, "deploy", "redkite.config.ts"));
    assert.deepEqual(Object.keys(config.environments ?? {}), ["staging"]);
  });

  // One place or the other: two files for one environment is two answers
  it("refuses the same environment in both places", async () => {
    const root = await project({
      "package.json": points,
      "redkite.config.ts": "export default {};\n",
      "redkite.staging.config.ts": env,
      "deploy/redkite.staging.config.ts": env,
    });

    await assert.rejects(
      () => loadConfig(join(root, "redkite.config.ts")),
      /sits both beside the deployment and in/,
    );
  });

  // Naming somewhere that does not exist is still worth stopping for
  it("refuses a directory that is not there", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "gone" } }),
      "redkite.config.ts": "export default {};\n",
    });

    assert.throws(() => discover(root), /which is not there/);
  });
});
