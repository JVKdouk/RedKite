import { spawn, type ChildProcess } from "node:child_process";

import { lineReader, tail, type OnLine, type Result } from "./host.js";

// One child process, its output collected and streamed

export type SpawnOptions = {
  stdin?: string;
  onLine?: OnLine;
  // Only stops a command being started; what runs is the host's to signal
  signal?: AbortSignal;
};

// A detached child outlives this process, so every stop goes through here
const live = new Set<ChildProcess>();

// The count is the point: nothing may exit while it is above zero
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

    // Its own process group, so one signal reaches everything it started
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

    // Only a streamed command is truncated; a host snapshot overruns any tail
    const keep = (lines: string[]) => (options.onLine ? tail(lines) : lines.join("\n"));

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on("error", reject);

    // A signalled command answers here once it has actually gone
    child.on("close", (code) => {
      live.delete(child);

      stdout.flush();
      stderr.flush();
      resolve({ code: code ?? 1, stdout: keep(out), stderr: keep(err) });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

// Single quotes are what a shell strips, so double quotes survive
export function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
