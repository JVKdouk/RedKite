import type { Context } from "./pipeline.js";
import { readEnv } from "./secrets/refs.js";
import type { AppSpec } from "./types.js";

// Vault values reach the app as a file, never baked into an image layer

// Written to the host, so no value appears in an argument list
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

// Docker's env file is not dotenv: a quote there stays part of the value
export function dockerEnv(contents: string) {
  const lines = Object.entries(parseEnv(contents)).map(([key, value]) => {
    // One variable per line, so there is no spelling of this docker reads back
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

// KEY=value, quotes stripped, blank lines and comments skipped
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

    // Take whole lines until the quote closes, so a pem arrives whole
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
