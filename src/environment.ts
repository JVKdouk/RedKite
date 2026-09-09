import type { Context } from "./pipeline.js";
import { readEnv } from "./secrets/refs.js";
import type { AppSpec } from "./types.js";

// What the vault resolved to, handed over as a file rather than baked into an
// image. Nothing from a vault is in a layer, so this is the only way anything
// running the app's image sees its environment: the container itself, and the
// migrations and checks that run in the builder.

// Written to the host and handed over as a file, so no value appears in an
// argument list. Docker reads it when a container is created, and again for
// each `run --env-file`, so the file goes with the rest of the deploy's scratch
export async function envFileFor(app: AppSpec, context: Context) {
  if (!app.secrets) return undefined;

  const contents = await readEnv(app.secrets, context.secrets);
  return await context.host.write(`apps/${app.name}/env`, dockerEnv(contents));
}

// The flag, or nothing at all for an app that names no secrets
export async function envFlags(app: AppSpec, context: Context) {
  const path = await envFileFor(app, context);
  return path ? [`--env-file ${path}`] : [];
}

// A vault holds dotenv, and docker's env file is not dotenv: a quote is part of
// the value there, so DATABASE_URL="postgres://..." reaches the process with the
// quote still on it and every url parser rejects the scheme
export function dockerEnv(contents: string) {
  const lines = Object.entries(parseEnv(contents)).map(([key, value]) => {
    // The format is one variable per line, so there is no spelling of this that
    // docker would read back. Better to name the variable than to truncate it
    if (value.includes("\n")) {
      throw new Error(
        `${key} spans more than one line, which a docker env file cannot carry. ` +
          "Pass it as a file secret instead",
      );
    }

    return `${key}=${value}`;
  });

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// Enough of the format to carry a credential: KEY=value, quotes stripped,
// blank lines and comments skipped. A quoted value may run past the end of its
// line, because a key or a certificate is written the way it was generated
export function parseEnv(contents: string) {
  const values: Record<string, string> = {};
  const lines = contents.split("\n");

  for (let at = 0; at < lines.length; at += 1) {
    const text = (lines[at] ?? "").trim();
    if (!text || text.startsWith("#")) continue;

    const split = text.indexOf("=");
    if (split < 1) continue;

    const key = text.slice(0, split).replace(/^export\s+/, "").trim();
    const start = text.slice(split + 1).trim();
    const edge = start[0];

    if (edge !== '"' && edge !== "'") {
      values[key] = start;
      continue;
    }

    if (start.length > 1 && start.endsWith(edge)) {
      values[key] = start.slice(1, -1);
      continue;
    }

    // The quote never closed on its own line. Take whole lines until one closes
    // it, so a pem arrives whole rather than as its first line
    const held = [start.slice(1)];

    while (at + 1 < lines.length) {
      at += 1;
      const next = (lines[at] ?? "").trimEnd();

      if (next.endsWith(edge)) {
        held.push(next.slice(0, -1));
        break;
      }

      held.push(next);
    }

    values[key] = held.join("\n");
  }

  return values;
}
