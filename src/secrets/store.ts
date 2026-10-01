import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SecretStore } from "./refs.js";

// Runs the CLI as an ordinary process. Nothing on stdin, and output kept verbatim

function run(file: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr.trim() || stdout.trim() || `${file} exited ${code}`));
    });
  });
}

// A session, or what it takes to obtain one; both at once is indistinguishable
export type BitwardenCredentials = {
  detail?: (message: string) => void;
} & ({ session: string } | { clientId: string; clientSecret: string; password: string });

// Used when bw is not on PATH. Pinned, so a fresh machine runs the same program
const CLI = "@bitwarden/cli@2026.4.2";

// Keyed by version, so a bump installs beside a command that is mid-flight
const CLIS = join(homedir(), ".cache", "redkite", "cli");

export async function bitwardenStore(
  credentials: BitwardenCredentials,
): Promise<SecretStore> {
  const detail = credentials.detail ?? (() => {});

  // Its own state directory, so a deploy does not disturb the person's own vault
  const appdata = join(homedir(), ".cache", "redkite", "bitwarden");
  await mkdir(appdata, { recursive: true });

  const command = await resolveCli(detail);

  const bw = async (args: string[], env: Record<string, string> = {}) =>
    await run(command.file, [...command.prefix, ...args], {
      BITWARDENCLI_APPDATA_DIR: appdata,
      ...env,
    });

  const session = await unlock(bw, credentials, detail);

  // Without this a new item reads as not found, and a stale session fails late
  await bw(["sync"], { BW_SESSION: session }).catch((error: unknown) => {
    if (!("session" in credentials)) return undefined;

    throw new Error(
      `The session it was given does not open this vault: ${messageOf(error)}. ` +
        "Obtain one with bw unlock --raw, or unset it and let the api credentials do it",
    );
  });

  // Fetched once each, avoiding a process per call site
  const cache = new Map<string, Promise<string>>();

  const fetch = async (id: string) => {
    detail(`reading ${id.slice(0, 8)}`);

    const item = await bw(["get", "notes", id, "--raw"], {
      BW_SESSION: session,
    }).catch((error: unknown) => {
      throw new Error(`Could not read ${id} from Bitwarden: ${messageOf(error)}`);
    });

    return item.stdout;
  };

  return {
    read: async (id) => {
      const pending = cache.get(id) ?? fetch(id);
      cache.set(id, pending);
      return await pending;
    },
  };
}

type Bw = (args: string[], env?: Record<string, string>) => Promise<{ stdout: string }>;

// A key in the environment buys no credentials, no password, two fewer round trips
async function unlock(
  bw: Bw,
  credentials: BitwardenCredentials,
  detail: (message: string) => void,
) {
  if ("session" in credentials) {
    detail("using the session it was given");
    return credentials.session;
  }

  detail("unlocking the vault");

  // Already logged in is not an error; the session is what matters
  await bw(["login", "--apikey"], {
    BW_CLIENTID: credentials.clientId,
    BW_CLIENTSECRET: credentials.clientSecret,
  }).catch(() => undefined);

  const unlocked = await bw(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"], {
    BW_PASSWORD: credentials.password,
  }).catch((error: unknown) => {
    throw new Error(`Could not unlock the Bitwarden vault: ${messageOf(error)}`);
  });

  const session = unlocked.stdout.trim();
  if (session) return session;

  throw new Error("Bitwarden unlocked without a session");
}

type Cli = { file: string; prefix: string[] };

// Installed once, rather than resolved again on every call below
async function resolveCli(detail: (message: string) => void): Promise<Cli> {
  const override = process.env["REDKITE_BW_BIN"];
  if (override) return { file: override, prefix: [] };

  const found = await run("bw", ["--version"]).then(
    () => true,
    () => false,
  );

  if (found) return { file: "bw", prefix: [] };

  return { file: await install(detail), prefix: [] };
}

// npx would resolve again per call, and unlocking is three commands plus one per secret
async function install(detail: (message: string) => void) {
  const directory = join(CLIS, CLI.replace(/[^\w.]+/g, "-"));
  const binary = join(directory, "node_modules", ".bin", "bw");

  if (existsSync(binary)) return binary;

  detail(`installing ${CLI}, once for this machine`);
  await mkdir(directory, { recursive: true });

  await run("npm", [
    "install",
    "--prefix",
    directory,
    "--no-save",
    "--no-audit",
    "--no-fund",
    CLI,
  ]).catch((error: unknown) => {
    throw new Error(`Could not install ${CLI}: ${messageOf(error)}`);
  });

  return binary;
}

function messageOf(error: unknown) {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr) return stderr;
  }

  return error instanceof Error ? error.message : String(error);
}
