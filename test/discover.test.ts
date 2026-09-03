import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { discover, loadEnvironments } from "../src/cli/config.js";

// A deployment is one file at the root of the project, and a deploy is as
// likely to be run from a workspace inside it as from there.

async function project(files: string[] | Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "redkite-discover-"));
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

  // A project that is not written in TypeScript still has a deployment
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

  // package.json says where the deployment files live, for a repository that
  // would rather not keep them at its root
  it("takes the directory package.json points at", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "deploy" } }),
      "deploy/redkite.config.ts": "export default {};\n",
    });

    assert.equal(discover(root), join(root, "deploy", "redkite.config.ts"));
    assert.equal(discover(join(root, "apps", "web")), join(root, "deploy", "redkite.config.ts"));
  });

  // Saying where the files are and not putting them there is a mistake worth
  // stopping for, rather than a reason to keep looking further up
  it("stops rather than searching past a directory that was named", async () => {
    const root = await project({
      "package.json": JSON.stringify({ redkite: { directory: "deploy" } }),
      "deploy/.keep": "",
      "redkite.config.ts": "export default {};\n",
    });

    assert.throws(() => discover(root), /points redkite at .*deploy/);
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

    assert.throws(() => discover(root), /No redkite\.config\.ts found/);
  });
});

// The thing that differs between staging and production is a file, rather than
// a key several levels down one literal
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
