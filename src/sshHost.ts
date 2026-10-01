import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import type { Host, OnLine, Result } from "./host.js";
import { quote, spawnCollect } from "./shell.js";
import type { HostKeys } from "./types.js";

// The agent travels with the connection, so the host clones the repositories itself

// Injected so the argv this builds is asserted on rather than trusted
export type Ssh = (
  args: string[],
  options?: { stdin?: string; onLine?: OnLine },
) => Promise<Result>;

// The local shell a piped stream is fed through, injected for the same reason
export type Shell = (command: string) => Promise<Result>;

export type SshOptions = {
  run?: Ssh;
  shell?: Shell;
  directory?: string;
  cache?: string;
  // How the host's key is checked. Defaults to accept-new
  hostKeys?: HostKeys;
  // Aborting kills the client; what it carried keeps running, which stop handles
  signal?: AbortSignal;
};

// accept-new rather than no: a deploy hands a vault's contents to this machine
const CHECKING: Record<HostKeys, string> = {
  "accept-new": "accept-new",
  strict: "yes",
  off: "no",
};

// One connection for the whole deploy; a handshake is most of what a command costs
function multiplex(hostKeys: HostKeys = "accept-new") {
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=60s",
    "-o",
    `StrictHostKeyChecking=${CHECKING[hostKeys]}`,
    // Never a prompt: a question nobody can answer is a deploy that hangs
    "-o",
    "BatchMode=yes",
    // The host clones on our behalf rather than us shipping a tree
    "-A",
  ];
}

export async function sshHost(bastion: string, options: SshOptions = {}): Promise<Host> {
  const control = `/tmp/redkite-${randomUUID().slice(0, 8)}.control`;
  const directory = options.directory ?? `/tmp/redkite-${randomUUID().slice(0, 8)}`;
  const signal = options.signal;

  const run =
    options.run ?? ((args, extra) => spawnCollect("ssh", args, { ...extra, signal }));

  // Cleanup has to survive the abort that made it necessary
  const final = options.run ?? ((args, extra) => spawnCollect("ssh", args, extra));

  const shell =
    options.shell ??
    ((command: string) => spawnCollect("sh", ["-c", command], { signal }));

  const flags = multiplex(options.hostKeys);

  const argv = (command: string) => [
    ...flags,
    "-o",
    `ControlPath=${control}`,
    bastion,
    command,
  ];

  const ssh = (command: string, extra?: { stdin?: string; onLine?: OnLine }) =>
    run(argv(command), extra);

  // Killing the client here leaves what it carried running there
  let issued = 0;

  // One round trip, including the home directory a literal ~ would not survive
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

    // Streamed through the open connection rather than written to a disk at each end
    pipe: async (local, remote) =>
      await shell(`${local} | ssh ${argv(remote).map(quote).join(" ")}`),

    // On the open connection, without the signal that made it necessary
    final: async (command) => await final(argv(command)),

    // Signalled where they run: killing the client would leave the build unreachable
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

// The process group is the only handle a second connection has; writes nothing to stdout
function supervised(command: string, pidfile: string) {
  return `set -m; { ${command}; } & __rk=$!; printf %s "$__rk" > '${pidfile}'; wait "$__rk"`;
}

// The count is what the caller waits on until a harder signal is sent
function sweep(directory: string, name: string) {
  return (
    `left=0; for f in '${directory}'/*.pid; do [ -f "$f" ] || continue; ` +
    `p=$(cat "$f" 2>/dev/null) || continue; ` +
    `kill -${name} -"$p" 2>/dev/null; ` +
    `kill -0 -"$p" 2>/dev/null && left=$((left+1)); done; printf %s "$left"`
  );
}
