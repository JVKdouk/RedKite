import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareSource, type Host, type Result } from "../src/index.js";

// Getting the repository onto the machine that builds it. Every command runs
// there, so this asserts on the script rather than on a checkout.

const SHA = "9f2b4c1d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c";

function recorder(answers: Record<string, string> = {}) {
  const scripts: string[] = [];

  const sh: Host["sh"] = async (command): Promise<Result> => {
    scripts.push(command);

    for (const [needle, stdout] of Object.entries(answers)) {
      if (command.includes(needle)) return { code: 0, stdout, stderr: "" };
    }

    return { code: 0, stdout: command.includes("rev-parse") ? SHA : "", stderr: "" };
  };

  const host: Host = {
    sh,
    write: async (name) => `/tmp/redkite/${name}`,
    directory: "/tmp/redkite",
    cache: "/home/ubuntu/.cache/redkite",
  };

  return { host, scripts };
}

const request = {
  name: "acme-staging-backend",
  repo: "git@github.com:acme/backend.git",
  branch: "staging",
  submodules: true,
};

describe("preparing the source", () => {
  it("resolves the branch to a commit on the host", async () => {
    const { host, scripts } = recorder();
    const source = await prepareSource(host, request);

    assert.equal(source.release, SHA);
    assert.ok(scripts.some((s) => s.includes("rev-parse 'refs/heads/staging'")));
  });

  it("answers with a checkout the build can be pointed at", async () => {
    const { host } = recorder();
    const source = await prepareSource(host, request);

    assert.equal(source.path, `/home/ubuntu/.cache/redkite/source/${request.name}`);
  });

  // The mirror is what makes the second deploy cheap. Cloning into a scratch
  // directory would fetch the whole repository every time
  it("keeps the mirror outside the directory a deploy cleans up", async () => {
    const { host, scripts } = recorder();
    await prepareSource(host, request);

    const mirror = `/home/ubuntu/.cache/redkite/mirrors/${request.name}.git`;
    assert.ok(scripts.some((s) => s.includes(`git clone --mirror '${request.repo}' '${mirror}'`)));
    assert.ok(scripts.some((s) => s.includes(`git -C '${mirror}' remote update --prune`)));
  });

  // Only the working tree is written: the objects are the mirror's
  it("shares the mirror's objects with the checkout", async () => {
    const { host, scripts } = recorder();
    await prepareSource(host, request);

    assert.ok(scripts.some((s) => s.includes("git clone --shared --no-checkout")));
    assert.ok(scripts.some((s) => s.includes(`checkout --detach --force '${SHA}'`)));
  });

  it("follows the branch a submodule names rather than the commit recorded", async () => {
    const { host, scripts } = recorder();
    await prepareSource(host, request);

    assert.ok(scripts.some((s) => s.includes("submodule update --init --remote")));
  });

  it("leaves a repository without submodules alone", async () => {
    const { host, scripts } = recorder();
    await prepareSource(host, { ...request, submodules: false });

    assert.ok(!scripts.some((s) => s.includes("submodule")));
  });

  it("stops at a branch the repository does not have", async () => {
    const { host } = recorder({ "rev-parse": "" });

    await assert.rejects(() => prepareSource(host, request), /has no branch staging/);
  });

  it("stops rather than building from a stale checkout", async () => {
    const { host } = recorder();
    const failing: Host = {
      ...host,
      sh: async (command) =>
        command.includes("checkout --detach")
          ? { code: 1, stdout: "", stderr: "reference is not a tree" }
          : await host.sh(command),
    };

    await assert.rejects(() => prepareSource(failing, request), /reference is not a tree/);
  });
});
