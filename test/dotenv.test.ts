import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadDotenv } from "../src/cli/dotenv.js";
import { parseEnv } from "../src/environment.js";

// The credentials a deploy needs are the one thing that cannot live in the
// config, so they live beside it. Which file answers depends on the
// environment being deployed, most specific first.

const made: string[] = [];
const KEYS = ["BW_KEY", "OTHER", "QUOTED", "SPACED"];

after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
  for (const key of KEYS) delete process.env[key];
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "redkite-dotenv-"));
  made.push(root);

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }

  for (const key of KEYS) delete process.env[key];
  return root;
}

describe("reading the credentials beside the config", () => {
  it("prefers the deploy file for that environment", async () => {
    const root = await project({
      ".env": "BW_KEY=plain\n",
      ".env.staging": "BW_KEY=staging\n",
      ".env.staging.deploy": "BW_KEY=deploy\n",
    });

    const read = loadDotenv(root, "staging");

    assert.equal(process.env["BW_KEY"], "deploy");
    assert.deepEqual(read, [".env.staging.deploy", ".env.staging", ".env"]);
  });

  it("falls back through the environment's own file to the plain one", async () => {
    const root = await project({ ".env": "BW_KEY=plain\n", ".env.staging": "BW_KEY=staging\n" });

    loadDotenv(root, "staging");
    assert.equal(process.env["BW_KEY"], "staging");
  });

  it("reads only the files that are there", async () => {
    const root = await project({ ".env": "BW_KEY=plain\n" });

    assert.deepEqual(loadDotenv(root, "production"), [".env"]);
    assert.equal(process.env["BW_KEY"], "plain");
  });

  // What the job set was set on purpose, and a file should not talk over it
  it("never replaces what the environment already says", async () => {
    const root = await project({ ".env.staging.deploy": "BW_KEY=from-a-file\n" });
    process.env["BW_KEY"] = "from-the-job";

    loadDotenv(root, "staging");
    assert.equal(process.env["BW_KEY"], "from-the-job");
  });

  it("takes a key the more specific file did not mention", async () => {
    const root = await project({
      ".env": "BW_KEY=plain\nOTHER=only-here\n",
      ".env.staging.deploy": "BW_KEY=deploy\n",
    });

    loadDotenv(root, "staging");

    assert.equal(process.env["BW_KEY"], "deploy");
    assert.equal(process.env["OTHER"], "only-here");
  });

  it("finds nothing to read when there is nothing there", async () => {
    const root = await project({});

    assert.deepEqual(loadDotenv(root, "staging"), []);
  });
});

describe("what a line in one of those files may say", () => {
  it("takes KEY=value", () => {
    assert.deepEqual(parseEnv("A=1\nB=two\n"), { A: "1", B: "two" });
  });

  it("skips blanks and comments", () => {
    assert.deepEqual(parseEnv("\n# a note\nA=1\n\n"), { A: "1" });
  });

  it("strips one pair of quotes", () => {
    const values = parseEnv(`A="quoted"\nB='single'\nC=bare\n`);

    assert.deepEqual(values, { A: "quoted", B: "single", C: "bare" });
  });

  // A vault url carries them, and splitting on the first = is what keeps it
  it("keeps every character after the first equals", () => {
    assert.deepEqual(parseEnv("URL=postgres://u:p@h:5432/db?x=1\n"), {
      URL: "postgres://u:p@h:5432/db?x=1",
    });
  });

  it("takes the export a shell file carries", () => {
    assert.deepEqual(parseEnv("export A=1\n"), { A: "1" });
  });

  it("ignores a line that names nothing", () => {
    assert.deepEqual(parseEnv("=1\nnovalue\n"), {});
  });
});

describe("a value written across several lines", () => {
  it("reads a quoted value that runs past its own line", () => {
    const read = parseEnv('KEY="first\nsecond\nthird"\nPORT=3001\n');

    assert.equal(read["KEY"], "first\nsecond\nthird");
    assert.equal(read["PORT"], "3001", "the key under it is still its own");
  });

  it("stops at the line that closes the quote", () => {
    const read = parseEnv("A='one\ntwo'\nB=three\n");

    assert.equal(read["A"], "one\ntwo");
    assert.equal(read["B"], "three");
  });
});
