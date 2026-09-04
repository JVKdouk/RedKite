import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Host } from "./host.js";
import { signalEverything, spawnCollect } from "./shell.js";

// The same Host without a network in the way, for an environment that names no
// bastion. Deploying to this machine and deploying to another one differ in
// nothing but which of these the CLI constructs.

export type LocalOptions = { cache?: string; signal?: AbortSignal };

export async function localHost(options: LocalOptions = {}): Promise<Host> {
  const directory = await mkdtemp(join(tmpdir(), "redkite-"));
  const cache = options.cache ?? join(homedir(), ".cache", "redkite");

  await mkdir(cache, { recursive: true });

  return {
    directory,
    cache,
    sh: async (command, onLine) =>
      await spawnCollect("sh", ["-c", command], { onLine, signal: options.signal }),

    write: async (name, contents) => {
      const path = join(directory, name);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, { mode: 0o600 });

      return path;
    },

    // Both ends are this machine, so the pipe is one shell away
    pipe: async (local, remote, onLine) =>
      await spawnCollect("sh", ["-c", `${local} | ${remote}`], {
        onLine,
        signal: options.signal,
      }),

    // The build is a grandchild of the shell that was spawned, and every child
    // is a process group leader, so one signal reaches the whole tree
    stop: async (name) => signalEverything(name === "KILL" ? "SIGKILL" : "SIGTERM"),

    close: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
