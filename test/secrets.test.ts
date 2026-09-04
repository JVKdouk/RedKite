import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import config from "./deployment.js";
import { bitwarden, bitwardenStore, listRefs, readEnv, readRef } from "../src/index.js";
import type { SecretStores } from "../src/index.js";

const stores: SecretStores = {
  bitwarden: {
    read: async (id) => {
      if (id === "shared") return "LOG_LEVEL=info\nREGION=eu\n";
      if (id === "app") return "LOG_LEVEL=debug\n";
      if (id === "no-newline") return "A=1";
      return `unknown:${id}`;
    },
  },
};

describe("secret refs", () => {
  it("wraps an id in a primitive that names its provider", () => {
    assert.deepEqual(bitwarden("abc"), { provider: "bitwarden", id: "abc" });
  });

  it("accepts a single entry and an array identically", async () => {
    const one = await readEnv(bitwarden("app"), stores);
    const many = await readEnv([bitwarden("app")], stores);

    assert.equal(one, many);
    assert.equal(one, "LOG_LEVEL=debug\n");
  });

  it("merges an array in the order written, later winning", async () => {
    const merged = await readEnv([bitwarden("shared"), bitwarden("app")], stores);

    // Every dotenv parser builds an object as it reads, so the last LOG_LEVEL
    // is the one the app sees
    assert.equal(merged, "LOG_LEVEL=info\nREGION=eu\nLOG_LEVEL=debug\n");
  });

  it("separates entries that did not end in a newline", async () => {
    const merged = await readEnv([bitwarden("no-newline"), bitwarden("app")], stores);

    // Without this the last key of one file and the first of the next join
    assert.equal(merged, "A=1\nLOG_LEVEL=debug\n");
  });

  it("treats an app with no secrets as an empty environment", async () => {
    assert.equal(await readEnv(undefined, stores), "");
    assert.deepEqual(listRefs(undefined), []);
  });

  it("names the provider it could not find, and what it was given", async () => {
    await assert.rejects(
      readRef({ provider: "vault", id: "x" }, stores),
      /No store for provider vault, deploy was given bitwarden/,
    );
  });

  // The id is a pointer rather than a credential, and the provider tag on it is
  // the whole of how a deploy knows which store to open
  it("carries every ref a deployment declares, with its provider", () => {
    const backend = config.apps.find((app) => app.name === "backend")!;
    const refs = [...listRefs(backend.secrets), ...Object.values(backend.files ?? {})];

    assert.ok(refs.length >= 2, "an environment and a credential file");

    for (const ref of refs) {
      assert.equal(ref.provider, "bitwarden");
      assert.ok(ref.id.length > 0);
    }

    // Each names a different item, or one of them is silently unreachable
    assert.equal(new Set(refs.map((ref) => ref.id)).size, refs.length);
  });
});


// The CLI is resolved once and then called directly. npx resolved the package
// again on every invocation, and unlocking is three commands plus one per secret
describe("reaching the Bitwarden CLI", () => {
  const calls = join(tmpdir(), `redkite-bw-calls-${process.pid}`);

  after(async () => {
    await rm(calls, { force: true });
  });

  it("calls the binary it was given, and reads each item once", async () => {
    process.env["BW_CALLS"] = calls;
    process.env["REDKITE_BW_BIN"] = new URL("./fixtures/bw", import.meta.url).pathname;

    const store = await bitwardenStore({
      clientId: "id",
      clientSecret: "secret",
      password: "password",
    });

    const first = await store.read("item");
    const second = await store.read("item");

    assert.equal(first, "A=1\n");
    assert.equal(second, first);

    const issued = (await readFile(calls, "utf8")).trim().split("\n");

    assert.deepEqual(issued.filter((line) => line.startsWith("get")).length, 1);
    assert.ok(issued.some((line) => line.startsWith("unlock")));
    assert.ok(!issued.some((line) => line.includes("npx")));
  });
});
