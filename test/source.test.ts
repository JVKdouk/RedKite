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
    pipe: async () => ({ code: 0, stdout: "", stderr: "" }),
    stop: async () => 0,
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

    assert.equal(source.tree, `/home/ubuntu/.cache/redkite/source/${request.name}`);
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

// A directory is built as it stands. Nothing is cloned, checked out or
// cleaned, and the release is what the tree contains rather than what a branch
// points at
describe("a source already on this machine", () => {
  const TREE = "3a008571e268eca89be2f744149631701e0e94ee";

  const local = {
    name: "acme-test-backend",
    path: "/home/jvck/work/backend",
    branch: "staging",
    submodules: false,
  };

  function answering(answers: Record<string, string>) {
    const { host, scripts } = recorder(answers);
    return { host, scripts };
  }

  it("builds the directory it was given, without cloning it", async () => {
    const { host, scripts } = answering({
      "is-inside-work-tree": "true\n",
      "write-tree": `${TREE}\n`,
    });

    const source = await prepareSource(host, local);

    assert.equal(source.tree, local.path);
    assert.equal(source.release, TREE);
    assert.ok(!scripts.some((script) => script.includes("git clone")));
    assert.ok(!scripts.some((script) => script.includes("checkout")));
  });

  // The branch an environment names has nothing to say about a tree on disk
  it("never resolves the branch", async () => {
    const { host, scripts } = answering({
      "is-inside-work-tree": "true\n",
      "write-tree": `${TREE}\n`,
    });

    await prepareSource(host, local);
    assert.ok(!scripts.some((script) => script.includes(`refs/heads/${local.branch}`)));
  });

  // An edit that is never committed is a different release, or a deploy hands
  // back an image built from something else
  it("reads the release from the working tree, not from HEAD", async () => {
    const { host, scripts } = answering({
      "is-inside-work-tree": "true\n",
      "write-tree": `${TREE}\n`,
    });

    await prepareSource(host, local);
    const digest = scripts.find((script) => script.includes("write-tree")) ?? "";

    assert.ok(digest.includes("git add -A"), "everything on disk, not just the index");
    assert.ok(digest.includes("init -q --bare"), "into a repository of its own");
    assert.ok(!digest.includes(`git -C '${local.path}'`), "so no object lands in the source");
  });

  // A directory git knows nothing about has nothing to say what belongs in the
  // build, so the deployment says it rather than the deploy refusing to run
  it("takes an explicit list where git cannot answer", async () => {
    const { host, scripts } = answering({
      "is-inside-work-tree": "",
      "write-tree": `${TREE}\n`,
    });

    const source = await prepareSource(host, {
      ...local,
      include: ["src", "package.json"],
    });

    assert.equal(source.release, TREE);

    const digest = scripts.find((script) => script.includes("write-tree")) ?? "";
    assert.ok(digest.includes("git add -- 'src' 'package.json'"), digest);
    assert.ok(!digest.includes("add -A"), "not everything that is lying there");
  });

  // -- would make -A a path to add rather than the flag that adds everything
  it("never passes the everything flag as a path", async () => {
    const { host, scripts } = answering({
      "is-inside-work-tree": "true\n",
      "write-tree": `${TREE}\n`,
    });

    await prepareSource(host, local);
    const digest = scripts.find((script) => script.includes("write-tree")) ?? "";

    assert.ok(!digest.includes("add -- -A"), digest);
  });

  // An include is what a directory outside git needs, so it must not itself
  // need one
  it("asks for a list rather than refusing the directory", async () => {
    const { host } = answering({ "is-inside-work-tree": "" });

    await assert.rejects(() => prepareSource(host, local), /include: \["src", "package.json"\]/);
  });

  it("says what is missing when git cannot answer and nothing was named", async () => {
    const { host } = answering({ "is-inside-work-tree": "" });

    await assert.rejects(() => prepareSource(host, local), /nothing there says what belongs/);
  });

  it("refuses a tree it could not read the state of", async () => {
    const { host } = answering({ "is-inside-work-tree": "true\n", "write-tree": "" });

    await assert.rejects(() => prepareSource(host, local), /Could not read the state of/);
  });

  it("refuses a request naming neither", async () => {
    const { host } = answering({});

    await assert.rejects(
      () => prepareSource(host, { ...local, path: undefined }),
      /names neither a repo nor a path/,
    );
  });
});
