import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { signalEverything, spawnCollect, stillRunning } from "../src/index.js";

// A build is not the process the shell started, it is that process's child. A
// stop that only signals what it spawned leaves the build running.

const made: string[] = [];

after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

// A command whose real work happens in a grandchild, which is the shape of
// every docker build this runs. The grandchild says where to find it
async function nested() {
  const dir = await mkdtemp(join(tmpdir(), "redkite-shell-"));
  made.push(dir);

  const pidfile = join(dir, "pid");
  const command = `sh -c 'echo $$ > ${pidfile}; exec sleep 30' & wait`;

  const started = async () => {
    const pid = await readFile(pidfile, "utf8").catch(() => "");
    return pid.trim();
  };

  return { command, started };
}

async function alive(pid: string) {
  const result = await spawnCollect("sh", ["-c", `kill -0 ${pid} 2>/dev/null`]);
  return result.code === 0;
}

async function until(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (await condition()) return true;
  }

  return false;
}

describe("stopping a command", () => {
  it("kills what the command started, not only the command", async () => {
    const { command, started } = await nested();
    const running = spawnCollect("sh", ["-c", command]);

    assert.ok(await until(async () => (await started()) !== ""));
    const grandchild = await started();
    assert.ok(await alive(grandchild), "the grandchild is what has to die");

    signalEverything("SIGTERM");
    await running;

    assert.ok(await until(async () => !(await alive(grandchild))), "it survived");
  });

  // Aborting only stops the next command being issued. What is already running
  // is stopped by signalling it, because over ssh it is on another machine and
  // killing the client here would leave it going with nothing able to reach it
  it("leaves a running command alone when the signal aborts", async () => {
    const { command, started } = await nested();
    const stopping = new AbortController();

    const running = spawnCollect("sh", ["-c", command], { signal: stopping.signal });
    assert.ok(await until(async () => (await started()) !== ""));

    stopping.abort();
    const grandchild = await started();

    assert.ok(await alive(grandchild), "abort is not a kill");

    signalEverything("SIGKILL");
    await running;
  });

  it("refuses to start once it has been stopped", async () => {
    const stopping = new AbortController();
    stopping.abort();

    await assert.rejects(
      () => spawnCollect("sh", ["-c", "echo never"], { signal: stopping.signal }),
      /Stopped/,
    );
  });

  // What a host signals when it is asked to stop, and the count is what a
  // caller waits on: nothing may leave while it is above zero
  it("signals every group and says how many are left", async () => {
    const { command, started } = await nested();
    const running = spawnCollect("sh", ["-c", command]);

    assert.ok(await until(async () => (await started()) !== ""));
    const grandchild = await started();

    assert.ok(stillRunning() > 0, "it is counted while it runs");
    assert.ok(signalEverything("SIGKILL") > 0, "and counted when it is signalled");

    await running;

    assert.ok(await until(async () => !(await alive(grandchild))), "it survived");
    assert.equal(stillRunning(), 0, "and is not counted once it has gone");
  });

  // The promise is the proof. Settling it on the abort rather than on the
  // process ending is what let a stopped deploy exit with a build still running
  it("does not answer until the process has actually gone", async () => {
    const { command, started } = await nested();
    const stopping = new AbortController();

    const running = spawnCollect("sh", ["-c", command], { signal: stopping.signal });
    assert.ok(await until(async () => (await started()) !== ""));

    const grandchild = await started();

    stopping.abort();
    signalEverything("SIGTERM");
    await running;

    assert.equal(await alive(grandchild), false, "gone by the time it answered");
  });

  it("hands back what the command said and what it exited with", async () => {
    const result = await spawnCollect("sh", ["-c", "printf hello; exit 3"]);

    assert.equal(result.stdout, "hello");
    assert.equal(result.code, 3);
  });
});
