import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { Host, OnLine, Result } from "./host.js";
import { quote, spawnCollect } from "./shell.js";

// The deploy host, reached over ssh. The agent is forwarded rather than a key,
// there is nothing to forward, and the agent travels with the connection so the
// host can clone the repositories itself.

// Injected so the argv this builds is asserted on rather than trusted
export type Ssh = (
  args: string[],
  options?: { stdin?: string; onLine?: OnLine },
) => Promise<Result>;

// The local shell a piped stream is fed through, injected for the same reason
// run is: what this builds is asserted on rather than trusted
export type Shell = (command: string) => Promise<Result>;

export type SshOptions = {
  run?: Ssh;
  shell?: Shell;
  directory?: string;
  cache?: string;
  // Aborting kills the ssh client. The command it was carrying keeps running on
  // the other machine, which is what stop is for
  signal?: AbortSignal;
};

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

export async function sshHost(bastion: string, options: SshOptions = {}): Promise<Host> {
  const control = `/tmp/redkite-${randomUUID().slice(0, 8)}.control`;
  const directory = options.directory ?? `/tmp/redkite-${randomUUID().slice(0, 8)}`;
  const signal = options.signal;

  const run =
    options.run ?? ((args, extra) => spawnCollect("ssh", args, { ...extra, signal }));

  // Cleanup has to survive the abort that made it necessary, so it is the one
  // thing here that is not killed along with everything else
  const final = options.run ?? ((args, extra) => spawnCollect("ssh", args, extra));

  const shell =
    options.shell ??
    ((command: string) => spawnCollect("sh", ["-c", command], { signal }));

  const argv = (command: string) => [
    ...MULTIPLEX,
    "-o",
    `ControlPath=${control}`,
    bastion,
    command,
  ];

  const ssh = (command: string, extra?: { stdin?: string; onLine?: OnLine }) =>
    run(argv(command), extra);

  // Each command records the process group job control gave it, because killing
  // the ssh client here leaves what it was carrying running there
  let issued = 0;

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

    sh: async (command, onLine) => {
      issued += 1;
      return await ssh(supervised(command, `${directory}/run.${issued}.pid`), { onLine });
    },

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

    // Through the connection that is already open, so an image is streamed
    // rather than written to a disk at each end and copied between them
    pipe: async (local, remote) =>
      await shell(`${local} | ssh ${argv(remote).map(quote).join(" ")}`),

    // Signalled where they are running, not here. Killing the client would
    // leave the build going with nothing left able to reach it
    stop: async (name) => {
      const result = await final(argv(sweep(directory, name)));
      return Number(result.stdout.trim()) || 0;
    },

    close: async () => {
      await final(argv(`rm -rf '${directory}'`));
      await final(["-o", `ControlPath=${control}`, "-O", "exit", bastion]);
    },
  };
}

// Job control puts a background job in a process group of its own, which is the
// only handle a second connection has on what the first one started. Nothing is
// written to stdout by this: an announcement would corrupt the host snapshot
function supervised(command: string, pidfile: string) {
  return `set -m; { ${command}; } & __rk=$!; printf %s "$__rk" > '${pidfile}'; wait "$__rk"`;
}

// Signals every group this deploy started there, then counts the ones still
// answering. The count is what the caller waits on: a build that ignores the
// first signal keeps it above zero until a harder one is sent
function sweep(directory: string, name: string) {
  return (
    `left=0; for f in '${directory}'/*.pid; do [ -f "$f" ] || continue; ` +
    `p=$(cat "$f" 2>/dev/null) || continue; ` +
    `kill -${name} -"$p" 2>/dev/null; ` +
    `kill -0 -"$p" 2>/dev/null && left=$((left+1)); done; printf %s "$left"`
  );
}
