import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SecretStore } from "./refs.js";

// Bitwarden Secrets Manager, which is not the password manager: different
// service, different CLI, different credential. An access token opens a set of
// projects rather than a personal vault, which is what a deploy wants, and it
// is the whole of the authentication: nothing to log in to and nothing to
// unlock, so there is no session to obtain or lose.

// Not an npm package. The password manager's CLI is one and redkite installs
// it with npm; this one is a released binary, and the only thing on npm under
// its name belongs to somebody else entirely. Pinned for the same reason the
// other is: an unpinned CLI is a different program on a machine that has never
// run a deploy before
const VERSION = "2.1.0";
const RELEASES = "https://github.com/bitwarden/sdk-sm/releases/download";
const CLIS = join(homedir(), ".cache", "redkite", "cli");

// What the release calls each platform. Anything not here has to bring its own
const TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

export type ManagerCredentials = {
  // The access token, which is the only credential this service has
  token: string;
  detail?: (message: string) => void;
  // Injected so the argv this builds is asserted on rather than trusted
  bws?: Bws;
};

export type Bws = (args: string[], env: Record<string, string>) => Promise<string>;

export async function secretsManagerStore(
  credentials: ManagerCredentials,
): Promise<SecretStore> {
  const detail = credentials.detail ?? (() => {});
  const bws = credentials.bws ?? (await resolve(detail));

  // Fetched once each. A second read of the same item during a deploy is the
  // same answer, and this avoids a process per call site
  const cache = new Map<string, Promise<string>>();

  const fetch = async (id: string) => {
    detail(`reading ${id.slice(0, 8)}`);

    const answer = await bws(["secret", "get", id, "--output", "json"], {
      BWS_ACCESS_TOKEN: credentials.token,
    }).catch((error: unknown) => {
      throw new Error(`Could not read ${id} from Bitwarden Secrets Manager: ${messageOf(error)}`);
    });

    return valueOf(answer, id);
  };

  return {
    read: async (id) => {
      const pending = cache.get(id) ?? fetch(id);
      cache.set(id, pending);
      return await pending;
    },
  };
}

// The secret's value, which is the whole of what a ref points at. Everything
// else the call answers with is about the item rather than in it
function valueOf(answer: string, id: string) {
  try {
    const parsed = JSON.parse(answer) as { value?: unknown };
    if (typeof parsed.value === "string") return parsed.value;
  } catch {
    // Falls through to the same refusal as a shape without a value
  }

  throw new Error(`Bitwarden Secrets Manager answered for ${id} without a value`);
}

async function resolve(detail: (message: string) => void): Promise<Bws> {
  const file = await binary(detail);
  return async (args, env) => await run(file, args, env);
}

async function binary(detail: (message: string) => void) {
  const override = process.env["REDKITE_BWS_BIN"];
  if (override) return override;

  const onPath = await run("bws", ["--version"], {}).then(
    () => true,
    () => false,
  );

  if (onPath) return "bws";

  const directory = join(CLIS, `bws-${VERSION}`);
  const installed = join(directory, process.platform === "win32" ? "bws.exe" : "bws");
  if (existsSync(installed)) return installed;

  return await install(directory, installed, detail);
}

// Downloaded once per machine per pinned version, the way the other CLI is
// installed once. The archive is a zip with one file in it, and unzip is the
// one thing on every platform that reads one
async function install(directory: string, installed: string, detail: (m: string) => void) {
  const target = TARGETS[`${process.platform}-${process.arch}`];

  if (!target) {
    throw new Error(
      `Bitwarden publishes no bws for ${process.platform}-${process.arch}. ` +
        "Install it yourself and point REDKITE_BWS_BIN at it",
    );
  }

  const url = `${RELEASES}/bws-v${VERSION}/bws-${target}-${VERSION}.zip`;
  detail(`installing bws ${VERSION}, once for this machine`);

  await mkdir(directory, { recursive: true });
  const archive = join(directory, "bws.zip");

  const answer = await globalThis.fetch(url);
  if (!answer.ok) throw new Error(`Could not download bws from ${url}: ${answer.status}`);

  await writeFile(archive, Buffer.from(await answer.arrayBuffer()));
  await run("unzip", ["-o", "-q", archive, "-d", directory], {}).catch((error: unknown) => {
    throw new Error(`Could not unpack bws: ${messageOf(error)}`);
  });

  await rm(archive, { force: true });

  // The zip carries no mode anything trusts, so it arrives unrunnable
  chmodSync(installed, 0o755);

  return installed;
}

// Nothing on stdin, and the output kept exactly as it came. The same reasoning
// as the password manager's runner: a question nobody can answer is a deploy
// that waits for ever
function run(file: string, args: string[], env: Record<string, string>) {
  return new Promise<string>((resolve_, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) return resolve_(stdout);
      reject(new Error(stderr.trim() || stdout.trim() || `${file} exited ${code}`));
    });
  });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
