import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { lineReader, tail, type Host, type OnLine, type Result } from "./host.js";

// The deploy host over ssh. Commands run where the docker socket already is, so
// there is nothing to forward, and the agent travels with the connection so the
// host can clone the repositories itself.

// Injected so the argv this builds is asserted on rather than trusted
export type Run = (
  args: string[],
  options?: { stdin?: string; onLine?: OnLine },
) => Promise<Result>;

export type SshOptions = { run?: Run; directory?: string; cache?: string };

// One TCP connection and one authentication for the whole deploy. Without it
// every command pays a handshake, which is most of what a command costs
const MULTIPLEX = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=60s",
  "-o",
  "StrictHostKeyChecking=no",
  // The host clones from GitHub on our behalf rather than us shipping a tree
  "-A",
];

export async function sshHost(
  bastion: string,
  options: SshOptions = {},
): Promise<Host> {
  const control = `/tmp/redkite-${randomUUID().slice(0, 8)}.control`;
  const directory = options.directory ?? `/tmp/redkite-${randomUUID().slice(0, 8)}`;
  const run = options.run ?? spawnSsh;

  const ssh = (command: string, extra?: { stdin?: string; onLine?: OnLine }) =>
    run([...MULTIPLEX, "-o", `ControlPath=${control}`, bastion, command], extra);

  // One round trip for all of it, including the home directory the cache hangs
  // off. A literal ~ would only survive as long as every caller used a shell
  const opened = await ssh(
    `mkdir -p -m 700 '${directory}' && mkdir -p "$HOME/.cache/redkite" && printf %s "$HOME"`,
  );

  if (opened.code !== 0) {
    throw new Error(`Could not reach ${bastion}: ${opened.stderr || opened.stdout}`);
  }

  const cache = options.cache ?? `${opened.stdout.trim()}/.cache/redkite`;

  return {
    directory,
    cache,
    sh: async (command, onLine) => await ssh(command, { onLine }),

    write: async (name, contents) => {
      const path = `${directory}/${name}`;
      const result = await ssh(`mkdir -p '${dirname(path)}' && cat > '${path}'`, {
        stdin: contents,
      });

      if (result.code !== 0) {
        throw new Error(`Could not write ${name}: ${result.stderr}`);
      }

      return path;
    },

    close: async () => {
      await ssh(`rm -rf '${directory}'`);
      await run(["-o", `ControlPath=${control}`, "-O", "exit", bastion]);
    },
  };
}

function spawnSsh(
  args: string[],
  options: { stdin?: string; onLine?: OnLine } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    const out: string[] = [];
    const err: string[] = [];

    const collect = (into: string[]) =>
      lineReader((line) => {
        into.push(line);
        options.onLine?.(line);
      });

    const stdout = collect(out);
    const stderr = collect(err);

    // Only a streamed command is truncated. The host snapshot is one command
    // listing every container and image, and a busy host overruns any tail
    const keep = (lines: string[]) =>
      options.onLine ? tail(lines) : lines.join("\n");

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      stdout.flush();
      stderr.flush();
      resolve({ code: code ?? 1, stdout: keep(out), stderr: keep(err) });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
