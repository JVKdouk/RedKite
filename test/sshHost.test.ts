import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCollect, sshHost, type Ssh } from "../src/index.js";

// The argv handed to ssh is the whole surface; nothing here opens a connection

function recorder(answers: string[] = []) {
  const calls: { args: string[]; stdin?: string }[] = [];

  const run: Ssh = async (args, options) => {
    calls.push({ args, stdin: options?.stdin });
    return { code: 0, stdout: answers[calls.length - 1] ?? "/home/ubuntu", stderr: "" };
  };

  return { run, calls };
}

const last = (calls: { args: string[] }[]) => calls.at(-1)?.args.at(-1) ?? "";

// Hundreds of megabytes, so it goes down the connection already open
describe("shipping something to the ssh host", () => {
  it("pipes a local command into one running there", async () => {
    const { run } = recorder();
    const piped: string[] = [];

    const host = await sshHost("ubuntu@example.com", {
      run,
      shell: async (command) => {
        piped.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await host.pipe("docker save web:1", "docker load");

    const command = piped[0] ?? "";
    assert.ok(command.startsWith("docker save web:1 | ssh "));
    assert.ok(command.includes("'ubuntu@example.com'"));
    assert.ok(command.endsWith("'docker load'"));
  });

  // The same connection, or the stream pays a handshake and an authentication
  it("sends it down the connection already open", async () => {
    const { run } = recorder();
    let command = "";

    const host = await sshHost("ubuntu@example.com", {
      run,
      shell: async (given) => {
        command = given;
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await host.pipe("docker save web:1", "docker load");

    assert.ok(command.includes("'ControlMaster=auto'"));
    assert.match(command, /'ControlPath=\/tmp\/redkite-[0-9a-f]{8}\.control'/);
  });
});

describe("the ssh host", () => {
  it("runs a shell command where the containers are", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("docker ps -a");

    assert.ok(last(calls).includes("{ docker ps -a; }"));
    assert.ok(calls.at(-1)?.args.includes("ubuntu@example.com"));
  });

  // Job control gives the command a process group, and the pid file keeps it
  it("runs it in a process group it can find again", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("docker build .");
    const command = last(calls);

    assert.ok(command.startsWith("set -m; { docker build .; } &"));
    assert.match(command, /printf %s "\$__rk" > '\/tmp\/redkite-[0-9a-f]{8}\/run\.1\.pid'/);
    assert.ok(command.endsWith('wait "$__rk"'), command);
  });

  it("gives every command a pid file of its own", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("one");
    await host.sh("two");

    assert.ok(last(calls).includes("run.2.pid"));
    assert.ok(calls.at(-2)?.args.at(-1)?.includes("run.1.pid"));
  });

  // Signalled where it runs: killing the client leaves the build unreachable
  it("signals the groups on the far side, not the connection", async () => {
    const { run, calls } = recorder(["/home/ubuntu", "0"]);
    const host = await sshHost("ubuntu@example.com", { run });

    await host.stop("TERM");
    const swept = last(calls);

    assert.match(swept, /kill -TERM -"\$p"/);
    assert.match(swept, /kill -0 -"\$p"/);
    assert.match(swept, /'\/tmp\/redkite-[0-9a-f]{8}'\/\*\.pid/, "the files it wrote");
  });

  it("sends a harder signal when it is asked for one", async () => {
    const { run, calls } = recorder(["/home/ubuntu", "0"]);
    const host = await sshHost("ubuntu@example.com", { run });

    await host.stop("KILL");
    assert.match(last(calls), /kill -KILL -"\$p"/);
  });

  // The count is what the caller waits on, and only zero finishes a stop
  it("answers with how many are still running there", async () => {
    const { run } = recorder(["/home/ubuntu", "3"]);
    const host = await sshHost("ubuntu@example.com", { run });

    assert.equal(await host.stop("TERM"), 3);
  });

  it("reads nothing as nothing left", async () => {
    const { run } = recorder(["/home/ubuntu", ""]);
    const host = await sshHost("ubuntu@example.com", { run });

    assert.equal(await host.stop("TERM"), 0);
  });

  // One handshake for a deploy that makes dozens of commands
  it("multiplexes every command onto one connection", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("docker ps -a");
    const args = calls.at(-1)?.args ?? [];

    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.some((arg) => arg.startsWith("ControlPath=")));
  });

  // A deploy hands over a vault's contents, so the address alone is not enough
  it("refuses a host whose key changed, without being asked to", async () => {
    const { run, calls } = recorder();
    await sshHost("ubuntu@example.com", { run });

    assert.ok(calls[0]?.args.includes("StrictHostKeyChecking=accept-new"));
    assert.ok(!calls[0]?.args.includes("StrictHostKeyChecking=no"));
  });

  it("checks nothing only where it was told not to", async () => {
    const { run, calls } = recorder();
    await sshHost("ubuntu@example.com", { run, hostKeys: "off" });

    assert.ok(calls[0]?.args.includes("StrictHostKeyChecking=no"));
  });

  it("takes nothing on trust when it is asked to be strict", async () => {
    const { run, calls } = recorder();
    await sshHost("ubuntu@example.com", { run, hostKeys: "strict" });

    assert.ok(calls[0]?.args.includes("StrictHostKeyChecking=yes"));
  });

  // A question nobody can answer hangs a deploy, under any of the three
  it("never leaves ssh able to ask", async () => {
    for (const hostKeys of ["accept-new", "strict", "off"] as const) {
      const { run, calls } = recorder();
      await sshHost("ubuntu@example.com", { run, hostKeys });

      assert.ok(calls[0]?.args.includes("BatchMode=yes"), hostKeys);
    }
  });

  // The host clones for itself, which needs the agent this machine holds
  it("forwards the agent", async () => {
    const { run, calls } = recorder();
    await sshHost("ubuntu@example.com", { run });

    assert.ok(calls.at(-1)?.args.includes("-A"));
  });

  it("hangs its cache off the home directory the host reported", async () => {
    const { run } = recorder(["/home/deployer\n"]);
    const host = await sshHost("ubuntu@example.com", { run });

    // A literal ~ would only survive while every caller used a shell
    assert.equal(host.cache, "/home/deployer/.cache/redkite");
  });

  it("answers with the path it actually wrote, not the one it was asked for", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run, directory: "/tmp/redkite" });

    const written = await host.write("backend.env", "TOKEN=1\n");

    assert.equal(written, "/tmp/redkite/backend.env");
    assert.equal(calls.at(-1)?.stdin, "TOKEN=1\n");
    assert.match(last(calls), /cat > '\/tmp\/redkite\/backend\.env'/);
  });

  it("refuses to go on when the host cannot be reached", async () => {
    const run: Ssh = async () => ({ code: 255, stdout: "", stderr: "no route to host" });

    await assert.rejects(() => sshHost("ubuntu@example.com", { run }), /no route to host/);
  });

  it("closes the connection it opened", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.close?.();

    assert.ok(calls.some((call) => call.args.includes("-O")));
  });
});


// No sshd here, so the command is run locally; the string is the same either way
describe("what the far side is left running", () => {
  // ssh's own argv is everything before the command
  const asFarSide: Ssh = async (args) =>
    await spawnCollect("sh", ["-c", args.at(-1) ?? "true"]);

  async function opened() {
    const directory = await mkdtemp(join(tmpdir(), "redkite-far-"));
    const stopping = new AbortController();

    const host = await sshHost("ubuntu@example.com", {
      run: asFarSide,
      directory,
      signal: stopping.signal,
    });

    return { host, directory, stopping };
  }

  const alive = async (pid: string) =>
    (await spawnCollect("sh", ["-c", `kill -0 ${pid} 2>/dev/null && echo yes`])).stdout.trim();

  it("records the group of what it started", async () => {
    const { host, directory } = await opened();

    // A grandchild, which is what a build is and what one signal would miss
    const running = host.sh("sh -c 'sleep 20' ");
    let pid = "";

    while (!pid) {
      pid = await readFile(join(directory, "run.1.pid"), "utf8").catch(() => "");
    }

    assert.match(pid, /^\d+$/);
    assert.equal(await alive(pid), "yes");

    await spawnCollect("sh", ["-c", `kill -KILL -${pid} 2>/dev/null; true`]);
    await running;
    await rm(directory, { recursive: true, force: true });
  });

  it("kills the group, not only the command", async () => {
    const { host, directory, stopping } = await opened();

    const running = host.sh("sh -c 'sleep 20' ");
    let pid = "";

    while (!pid) {
      pid = await readFile(join(directory, "run.1.pid"), "utf8").catch(() => "");
    }

    const before = (
      await spawnCollect("sh", ["-c", `ps -eo pgid=,comm= | awk '$1 == ${pid}' | wc -l`])
    ).stdout.trim();

    stopping.abort();
    while ((await host.stop("TERM")) > 0) {
      // The far side takes a moment to go, and the count is what says it has
    }

    await running;

    const after = (
      await spawnCollect("sh", ["-c", `ps -eo pgid=,comm= | awk '$1 == ${pid}' | wc -l`])
    ).stdout.trim();

    assert.ok(Number(before) >= 2, `the group held the command and its child, saw ${before}`);
    assert.equal(after, "0", "and nothing in it is left");
    await rm(directory, { recursive: true, force: true });
  });

  it("hands back what the command exited with", async () => {
    const { host, directory } = await opened();

    assert.equal((await host.sh("exit 7")).code, 7);
    assert.equal((await host.sh("printf hello")).stdout, "hello");

    await rm(directory, { recursive: true, force: true });
  });
});
