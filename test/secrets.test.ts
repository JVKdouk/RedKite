import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import config from "./deployment.js";
import { bitwarden, bitwardenStore, listRefs, readEnv, readRef, storeFor } from "../src/index.js";
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
    assert.deepEqual(bitwarden.item("abc"), { provider: "bitwarden", id: "abc" });
  });

  it("accepts a single entry and an array identically", async () => {
    const one = await readEnv(bitwarden.item("app"), stores);
    const many = await readEnv([bitwarden.item("app")], stores);

    assert.equal(one, many);
    assert.equal(one, "LOG_LEVEL=debug\n");
  });

  it("merges an array in the order written, later winning", async () => {
    const merged = await readEnv([bitwarden.item("shared"), bitwarden.item("app")], stores);

    // Every dotenv parser builds an object as it reads, so the last LOG_LEVEL
    // is the one the app sees
    assert.equal(merged, "LOG_LEVEL=info\nREGION=eu\nLOG_LEVEL=debug\n");
  });

  it("separates entries that did not end in a newline", async () => {
    const merged = await readEnv([bitwarden.item("no-newline"), bitwarden.item("app")], stores);

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

// Bitwarden is two services. Secrets Manager opens with an access token and is
// what a deploy wants; the password manager wants a session or a master
// password. Handing one service's credential to the other is how a deploy ends
// up waiting on a prompt nobody can see.
describe("which Bitwarden a deployment reads", () => {
  const calls = join(tmpdir(), `redkite-bw-which-${process.pid}`);
  const managerCalls = join(tmpdir(), `redkite-bws-which-${process.pid}`);

  after(async () => {
    await Promise.all([rm(calls, { force: true }), rm(managerCalls, { force: true })]);
    for (const key of ["BW_KEY", "BW_CLIENT_ID", "BW_CLIENT_SECRET", "BW_PASSWORD"]) {
      delete process.env[key];
    }
  });

  const pointAt = async () => {
    await Promise.all([rm(calls, { force: true }), rm(managerCalls, { force: true })]);

    process.env["BW_CALLS"] = calls;
    process.env["BWS_CALLS"] = managerCalls;
    process.env["REDKITE_BW_BIN"] = new URL("./fixtures/bw", import.meta.url).pathname;
    process.env["REDKITE_BWS_BIN"] = new URL("./fixtures/bws", import.meta.url).pathname;
  };

  const read = async (plugin: ReturnType<typeof bitwarden>) => {
    const open = storeFor([plugin], "bitwarden");
    assert.ok(open);

    const store = await open({ detail: () => {} });
    return await store.read("00000000-0000-4000-8000-000000000001");
  };

  it("reads Secrets Manager by default, with BW_KEY as the access token", async () => {
    await pointAt();
    process.env["BW_KEY"] = "an-access-token";

    assert.equal(await read(bitwarden()), "A=1\n");

    const issued = (await readFile(managerCalls, "utf8")).trim().split("\n");
    assert.ok(issued.some((line) => line.startsWith("secret get")), issued.join(" | "));
    assert.ok(!existsSync(calls), "and the password manager is never reached for");
  });

  // The one that was hanging: a Secrets Manager token given to the password
  // manager, which decided the vault was locked and asked for a password
  it("says what is wrong rather than reaching for the wrong service", async () => {
    await pointAt();
    delete process.env["BW_KEY"];

    const open = storeFor([bitwarden()], "bitwarden");

    await assert.rejects(() => open!({ detail: () => {} }), /access token, not a password/);
  });

  it("reads the password manager when it is told to", async () => {
    await pointAt();
    process.env["BW_KEY"] = "a-session";

    assert.equal(await read(bitwarden({ secrets: false })), "A=1\n");

    const issued = (await readFile(calls, "utf8")).trim().split("\n");
    assert.ok(issued.some((line) => line.startsWith("get")));
    assert.ok(!issued.some((line) => line.startsWith("unlock")), "the session skips unlocking");
  });

  it("takes the token on the object rather than from the environment", async () => {
    await pointAt();
    delete process.env["BW_KEY"];

    assert.equal(await read(bitwarden({ secrets: "handed-in" })), "A=1\n");
  });

  it("falls back to the api credentials for the password manager", async () => {
    await pointAt();
    delete process.env["BW_KEY"];

    process.env["BW_CLIENT_ID"] = "id";
    process.env["BW_CLIENT_SECRET"] = "secret";
    process.env["BW_PASSWORD"] = "password";

    await read(bitwarden({ secrets: false }));

    const issued = (await readFile(calls, "utf8")).trim().split("\n");
    assert.ok(issued.some((line) => line.startsWith("login")));
    assert.ok(issued.some((line) => line.startsWith("unlock")));
  });
});
