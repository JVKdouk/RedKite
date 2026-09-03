import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { lineReader, tail, type Host, type OnLine, type Result } from "./host.js";

// The same Host without a network in the way, for an environment that names no
// bastion. Deploying to this machine and deploying to another one differ in
// nothing but which of these the CLI constructs.

export type LocalOptions = { cache?: string };

export async function localHost(options: LocalOptions = {}): Promise<Host> {
  const directory = await mkdtemp(join(tmpdir(), "redkite-"));
  const cache = options.cache ?? join(homedir(), ".cache", "redkite");

  await mkdir(cache, { recursive: true });

  return {
    directory,
    cache,
    sh: async (command, onLine) => await spawnShell(command, onLine),

    write: async (name, contents) => {
      const path = join(directory, name);

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, { mode: 0o600 });

      return path;
    },

    close: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function spawnShell(command: string, onLine?: OnLine): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });

    const out: string[] = [];
    const err: string[] = [];

    const collect = (into: string[]) =>
      lineReader((line) => {
        into.push(line);
        onLine?.(line);
      });

    const stdout = collect(out);
    const stderr = collect(err);

    const keep = (lines: string[]) => (onLine ? tail(lines) : lines.join("\n"));

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      stdout.flush();
      stderr.flush();
      resolve({ code: code ?? 1, stdout: keep(out), stderr: keep(err) });
    });
  });
}
