import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SecretStore } from "./refs.js";

// One implementation of the interface deploy consumes. A second provider only
// has to satisfy read().
//
// The CLI runs here as an ordinary process. It used to run inside a container
// purely as a sandbox, which meant installing several thousand packages on
// every deploy to read three items.

const run = promisify(execFile);

export type BitwardenCredentials = {
  clientId: string;
  clientSecret: string;
  password: string;
  detail?: (message: string) => void;
};

// Used when bw is not already on PATH. Pinned, because an unpinned CLI is a
// different program on a machine that has never run a deploy before
const CLI = "@bitwarden/cli@2026.4.2";

export async function bitwardenStore(
  credentials: BitwardenCredentials,
): Promise<SecretStore> {
  const detail = credentials.detail ?? (() => {});

  // Its own state directory, so a deploy neither reads nor disturbs whatever
  // vault the person running it happens to be logged into
  const appdata = join(homedir(), ".cache", "redkite", "bitwarden");
  await mkdir(appdata, { recursive: true });

  const command = await resolveCli(detail);

  const bw = async (args: string[], env: Record<string, string> = {}) =>
    await run(command.file, [...command.prefix, ...args], {
      env: {
        ...process.env,
        BITWARDENCLI_APPDATA_DIR: appdata,
        ...env,
      },
      maxBuffer: 32 * 1024 * 1024,
    });

  detail("unlocking the vault");

  // Already logged in is not an error, the session is what matters
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
  if (!session) throw new Error("Bitwarden unlocked without a session");

  // An item added since the last deploy is not in the local vault otherwise,
  // and bw get answers "not found" rather than fetching it
  await bw(["sync"], { BW_SESSION: session }).catch(() => undefined);

  // Fetched once each. A second read of the same item during a deploy is the
  // same answer, and this avoids a process per call site
  const cache = new Map<string, Promise<string>>();

  const fetch = async (id: string) => {
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

type Cli = { file: string; prefix: string[] };

// A machine with the CLI installed pays nothing. One without it gets the pinned
// version through npx, which is still cheaper than a container per deploy
async function resolveCli(detail: (message: string) => void): Promise<Cli> {
  const override = process.env["REDKITE_BW_BIN"];
  if (override) return { file: override, prefix: [] };

  const found = await run("bw", ["--version"]).then(
    () => true,
    () => false,
  );

  if (found) return { file: "bw", prefix: [] };

  detail(`fetching ${CLI}`);
  return { file: "npx", prefix: ["--yes", CLI] };
}

function messageOf(error: unknown) {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr) return stderr;
  }

  return error instanceof Error ? error.message : String(error);
}
