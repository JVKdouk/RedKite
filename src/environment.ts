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
  return await context.host.write(`apps/${app.name}/env`, contents);
}

// The flag, or nothing at all for an app that names no secrets
export async function envFlags(app: AppSpec, context: Context) {
  const path = await envFileFor(app, context);
  return path ? [`--env-file ${path}`] : [];
}
