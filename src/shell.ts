import { spawn, type ChildProcess } from "node:child_process";

import { lineReader, tail, type OnLine, type Result } from "./host.js";

// One child process, its output collected and streamed. Both hosts ran their
// own copy of this, and shipping an image needs a third caller.

export type SpawnOptions = {
  stdin?: string;
  onLine?: OnLine;
  // Only stops a command being started. What is already running is stopped by
  // signalling it, which is the host's to do: over ssh the process to signal is
  // on the other machine, and killing the client here would only lose the reach
  signal?: AbortSignal;
};

// Every child still running. A detached child outlives this process, so a stop
// that does not go through here leaves a build running
const live = new Set<ChildProcess>();

// Signals every group and answers with how many are still there. The count is
// the whole point: nothing may exit while it is above zero
export function signalEverything(name: NodeJS.Signals) {
  for (const child of live) {
    try {
      if (child.pid) process.kill(-child.pid, name);
    } catch {
      // Already gone, which is the outcome being asked for
    }
  }

  return live.size;
}

export function stillRunning() {
  return live.size;
}

export function spawnCollect(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("Stopped"));

    // Its own process group, so one signal reaches everything it started. A
    // shell that ran docker dies on its own otherwise, and docker keeps going
    const child = spawn(command, args, {
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });

    live.add(child);

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
    const keep = (lines: string[]) => (options.onLine ? tail(lines) : lines.join("\n"));

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on("error", reject);

    // The only thing that settles this. A signalled command answers here once
    // it has actually gone, which is what lets a caller wait for exactly that
    child.on("close", (code) => {
      live.delete(child);

      stdout.flush();
      stderr.flush();
      resolve({ code: code ?? 1, stdout: keep(out), stderr: keep(err) });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

// Single quotes are what a shell strips, so a value containing double quotes
// survives being handed to one
export function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
