import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sshHost, type Run } from "../src/index.js";

// The host's whole surface is the argv it hands ssh, so that is what this
// asserts on. Nothing here opens a connection.

function recorder(answers: string[] = []) {
  const calls: { args: string[]; stdin?: string }[] = [];

  const run: Run = async (args, options) => {
    calls.push({ args, stdin: options?.stdin });
    return { code: 0, stdout: answers[calls.length - 1] ?? "/home/ubuntu", stderr: "" };
  };

  return { run, calls };
}

const last = (calls: { args: string[] }[]) => calls.at(-1)?.args.at(-1) ?? "";

describe("the ssh host", () => {
  it("runs a shell command where the containers are", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("docker ps -a");

    assert.equal(last(calls), "docker ps -a");
    assert.ok(calls.at(-1)?.args.includes("ubuntu@example.com"));
  });

  // One handshake for the whole deploy. A round trip is otherwise most of what
  // a command costs, and a deploy makes dozens of them
  it("multiplexes every command onto one connection", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.sh("docker ps -a");
    const args = calls.at(-1)?.args ?? [];

    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.some((arg) => arg.startsWith("ControlPath=")));
  });

  // The host clones the repositories itself, which it can only do with the
  // agent this machine is holding
  it("forwards the agent", async () => {
    const { run, calls } = recorder();
    await sshHost("ubuntu@example.com", { run });

    assert.ok(calls.at(-1)?.args.includes("-A"));
  });

  it("hangs its cache off the home directory the host reported", async () => {
    const { run } = recorder(["/home/deployer\n"]);
    const host = await sshHost("ubuntu@example.com", { run });

    // A literal ~ would only survive as long as every caller used a shell
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
    const run: Run = async () => ({ code: 255, stdout: "", stderr: "no route to host" });

    await assert.rejects(() => sshHost("ubuntu@example.com", { run }), /no route to host/);
  });

  it("closes the connection it opened", async () => {
    const { run, calls } = recorder();
    const host = await sshHost("ubuntu@example.com", { run });

    await host.close?.();

    assert.ok(calls.some((call) => call.args.includes("-O")));
  });
});
