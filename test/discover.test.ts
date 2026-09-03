import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { discover } from "../src/cli/config.js";

// A deployment is one file at the root of the project, and a deploy is as
// likely to be run from a workspace inside it as from there.

async function project(files: string[]) {
  const root = await mkdtemp(join(tmpdir(), "redkite-discover-"));

  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "export default {};\n");
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

  it("says what it looked for when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "redkite-discover-"));

    assert.throws(() => discover(root), /No redkite\.config\.ts found/);
  });
});
