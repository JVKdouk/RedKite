import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadConfig } from "../src/cli/config.js";
import { positional } from "../src/cli/index.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}/redkite.config.ts`, import.meta.url));

describe("loading a deployment config", () => {
  it("reads the default export of an ES module package", async () => {
    const config = await loadConfig(fixture("module"));
    assert.equal(config.project, "fixture");
  });

  it("reads the default export of a CommonJS package", async () => {
    const config = await loadConfig(fixture("commonjs"));
    assert.equal(config.project, "fixture");
  });

  // What a config transpiled to CommonJS arrives as, which is what happens when
  // the repository being deployed is itself CommonJS
  it("unwraps a default that Node nested inside module.exports", async () => {
    const config = await loadConfig(fixture("wrapped"));
    assert.equal(config.project, "fixture");
  });

  it("refuses a path that holds no config", async () => {
    await assert.rejects(() => loadConfig(fixture("missing")));
  });
});

describe("reading the command line", () => {
  // A flag's value is not the environment, and the environment defaults only
  // when nothing was actually given
  it("does not mistake a flag's value for the environment", () => {
    assert.deepEqual(positional(["deploy", "--config", "a.ts"]), ["deploy"]);
    assert.deepEqual(positional(["deploy", "--config", "a.ts", "production"]), [
      "deploy",
      "production",
    ]);
  });

  it("accepts a flag joined to its value", () => {
    assert.deepEqual(positional(["deploy", "--config=a.ts", "production"]), [
      "deploy",
      "production",
    ]);
  });

  it("keeps a bare flag from swallowing what follows", () => {
    assert.deepEqual(positional(["deploy", "--verbose", "production"]), [
      "deploy",
      "production",
    ]);
  });
});
