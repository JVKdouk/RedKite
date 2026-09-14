import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import base from "./deployment.js";
import type { Deployment } from "../src/index.js";
import {
  crashDirectory,
  crashFiles,
  dumpCrash,
  recording,
  type Crash,
} from "../src/cli/crash.js";
import type { Viewer } from "../src/cli/viewer.js";

// The view trims each step to its tail and the alternate screen takes the rest,
// so this is the only whole record of a run that failed.

const START = 1_000_000;

function viewer() {
  const calls: string[] = [];

  const log = Object.assign((message: string) => calls.push(`info ${message}`), {
    plan: (points: string[]) => calls.push(`plan ${points.join(",")}`),
    warn: (message: string) => calls.push(`warn ${message}`),
    fail: (message: string) => calls.push(`fail ${message}`),
    done: (message: string) => calls.push(`done ${message}`),
    step: (label: string) => {
      calls.push(`step ${label}`);

      return {
        detail: (message: string) => calls.push(`detail ${message}`),
        line: (message: string) => calls.push(`line ${message}`),
        done: (message?: string) => calls.push(`step-done ${message ?? ""}`),
        fail: (message: string) => calls.push(`step-fail ${message}`),
      };
    },
    close: () => calls.push("close"),
  }) satisfies Viewer;

  return { log, calls };
}

function clock() {
  let now = START;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const crash = (over: Partial<Crash> = {}): Crash => ({
  project: "acme",
  environment: "staging",
  command: "deploy",
  version: "0.1.9",
  argv: ["deploy", "staging"],
  outcome: "failed",
  at: START + 60_000,
  ...over,
});

// A run with two apps building, one of which fails, the shape a crash log is
// most often written for
function failedBuild() {
  const time = clock();
  const recorder = recording(viewer().log, time.now);

  const setup = recorder.log.step("setup");
  setup.detail("creating the network");
  time.advance(2000);
  setup.done();

  const front = recorder.log.step("Building frontend");
  const back = recorder.log.step("Building backend");

  front.line("frontend compiled");
  back.detail("reading its environment");
  back.line("#16 ERROR: process yarn build did not complete");
  time.advance(12_000);
  back.fail("backend failed to build");
  recorder.log.fail("build failed");

  return { recorder, files: crashFiles(recorder.transcript, crash()) };
}

const fileOf = (files: Record<string, string>, name: string) => {
  const contents = files[name];
  if (contents === undefined) throw new Error(`no ${name} among ${Object.keys(files).join(", ")}`);
  return contents;
};

describe("recording a run", () => {
  it("hands every call on to the log it wraps, unchanged", () => {
    const { log, calls } = viewer();
    const recorder = recording(log);

    recorder.log("hello");
    recorder.log.plan?.(["setup", "build"]);
    const build = recorder.log.step("build");
    build.detail("installing");
    build.line("#1 done");
    build.fail("build failed");
    recorder.log.warn("careful");
    recorder.log.close();

    assert.deepEqual(calls, [
      "info hello",
      "plan setup,build",
      "step build",
      "detail installing",
      "line #1 done",
      "step-fail build failed",
      "warn careful",
      "close",
    ]);
  });

  it("keeps what was said in the order it was said, steps among it", () => {
    const recorder = recording(viewer().log, clock().now);

    recorder.log("Reading the vault");
    recorder.log.step("build").done("built");
    recorder.log.fail("it broke");

    const kinds = recorder.transcript.entries.map((entry) => `${entry.kind} ${entry.text}`);

    assert.deepEqual(kinds, [
      "info Reading the vault",
      "step build started",
      "step build done: built (0s)",
      "fail it broke",
    ]);
  });

  it("keeps a host command whether or not it was shown", () => {
    const recorder = recording(viewer().log);
    recorder.command("  $ docker network ls  12ms exit 0");

    const run = fileOf(crashFiles(recorder.transcript, crash()), "run.log");
    assert.match(run, /docker network ls {2}12ms exit 0/);
  });
});

describe("what a crash log holds", () => {
  it("is the run's own log and one file per step, in the order they started", () => {
    const { files } = failedBuild();

    assert.deepEqual(Object.keys(files), [
      "run.log",
      "01-setup.log",
      "02-building-frontend.log",
      "03-building-backend.log",
    ]);
  });

  // Separated by component is the point: one app's output is not read through
  // another's to find the error
  it("keeps each step's output in its own file and nowhere else", () => {
    const { files } = failedBuild();

    const back = fileOf(files, "03-building-backend.log");
    const front = fileOf(files, "02-building-frontend.log");
    const run = fileOf(files, "run.log");

    assert.match(back, /\| #16 ERROR: process yarn build did not complete/);
    assert.doesNotMatch(back, /frontend compiled/);
    assert.match(front, /\| frontend compiled/);
    assert.doesNotMatch(run, /#16 ERROR/, "the run log indexes the steps rather than repeating them");
  });

  it("says how each step ended, at the top of its file", () => {
    const { files } = failedBuild();
    const back = fileOf(files, "03-building-backend.log");

    assert.match(back, /^step {9}Building backend$/m);
    assert.match(back, /^state {8}failed: backend failed to build$/m);
    assert.match(back, /^took {9}12s$/m);
    assert.match(back, /^\+00:02\.000 {2}· reading its environment$/m);
  });

  it("indexes the steps in the run log, with how each ended", () => {
    const run = fileOf(failedBuild().files, "run.log");

    assert.match(run, /^01-setup\.log +done +2s$/m);
    assert.match(run, /^03-building-backend\.log +failed +12s$/m);
  });

  // The view keeps a step's last 2000 lines. The whole point is the ones before
  it("keeps every line a step printed, however many", () => {
    const recorder = recording(viewer().log);
    const build = recorder.log.step("build");

    for (let index = 0; index < 5000; index += 1) build.line(`line ${index}`);
    build.fail("build failed");

    const written = fileOf(crashFiles(recorder.transcript, crash()), "01-build.log");

    assert.match(written, /\| line 0$/m);
    assert.match(written, /\| line 4999$/m);
  });

  it("gives two steps that share a label a file each", () => {
    const recorder = recording(viewer().log);
    recorder.log.step("Reading the vault").line("first");
    recorder.log.step("Reading the vault").line("second");

    const files = crashFiles(recorder.transcript, crash());

    assert.match(fileOf(files, "01-reading-the-vault.log"), /\| first/);
    assert.match(fileOf(files, "02-reading-the-vault.log"), /\| second/);
  });

  it("makes a point with colons in it a file name", () => {
    const recorder = recording(viewer().log);
    recorder.log.step("swap:before:migrate-backend").fail("backend failed to migrate");

    assert.ok("01-swap-before-migrate-backend.log" in crashFiles(recorder.transcript, crash()));
  });

  it("says a step that never finished was still running", () => {
    const recorder = recording(viewer().log);
    recorder.log.step("swap").detail("starting them");

    const swap = fileOf(crashFiles(recorder.transcript, crash()), "01-swap.log");

    assert.match(swap, /^state {8}running$/m);
    assert.match(swap, /^ended {8}still running when the run ended$/m);
  });

  // The terminal gets the tail of the message. The step that threw is usually
  // a cause or two down, and its stack is what says where
  it("writes the whole error chain, stacks included", () => {
    const root = new Error("docker build exited 1", { cause: new Error("yarn build failed") });
    const run = fileOf(crashFiles(recording(viewer().log).transcript, crash({ error: root })), "run.log");

    assert.match(run, /Error: docker build exited 1\n\s+at /);
    assert.match(run, /caused by\nError: yarn build failed\n\s+at /);
  });

  it("says no error was thrown for a deploy that reverted", () => {
    const transcript = recording(viewer().log).transcript;
    const run = fileOf(crashFiles(transcript, crash({ outcome: "reverted" })), "run.log");

    assert.match(run, /^outcome {6}reverted$/m);
    assert.match(run, /== error\nnone thrown/);
  });

  it("lines a message of several lines up under its text", () => {
    const recorder = recording(viewer().log);
    recorder.log.fail("first\nsecond");

    const run = fileOf(crashFiles(recorder.transcript, crash()), "run.log");
    assert.match(run, /fail {2}first\n {14}second/);
  });
});

describe("where a crash log goes", () => {
  const roots: string[] = [];

  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  const scratch = async () => {
    const root = await mkdtemp(join(tmpdir(), "redkite-crash-"));
    roots.push(root);
    return root;
  };

  it("is a directory under the project and the environment, named for the moment", () => {
    const directory = crashDirectory("acme", "staging", new Date("2026-09-14T10:22:05.123Z"));

    assert.equal(directory, "/tmp/acme/staging/crash-2026-09-14T10-22-05.123Z");
  });

  // The environment arrives on the command line, and a path is not somewhere
  // it gets to choose
  it("keeps a project or environment from leaving the directory", () => {
    const directory = crashDirectory("../acme", "../../etc", new Date("2026-09-14T10:22:05.123Z"));

    assert.equal(directory, "/tmp/acme/etc/crash-2026-09-14T10-22-05.123Z");
  });

  it("writes every file, private to whoever ran it", async () => {
    const root = await scratch();
    const { recorder } = failedBuild();

    const directory = await dumpCrash(base, recorder.transcript, crash(), root);
    assert.ok(directory);

    const expected = crashFiles(recorder.transcript, crash());
    assert.deepEqual((await readdir(directory)).sort(), Object.keys(expected).sort());

    for (const [name, contents] of Object.entries(expected)) {
      const path = join(directory, name);

      assert.equal(await readFile(path, "utf8"), contents);
      assert.equal((await stat(path)).mode & 0o777, 0o600, name);
    }

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "acme", "staging"))).mode & 0o777, 0o700);
  });

  it("writes nothing for a deployment that turned it off", async () => {
    const root = await scratch();
    const config = { ...base, options: { crashLog: false } } satisfies Deployment;

    const directory = await dumpCrash(config, recording(viewer().log).transcript, crash(), root);

    assert.equal(directory, undefined);
    assert.ok(!existsSync(join(root, "acme")), "not even the directory");
  });

  it("never writes into a crash directory that is already there", async () => {
    const root = await scratch();
    const transcript = recording(viewer().log).transcript;

    await dumpCrash(base, transcript, crash(), root);
    await assert.rejects(dumpCrash(base, transcript, crash(), root), /EEXIST/);
  });
});
