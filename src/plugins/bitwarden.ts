import { definePlugin, type OpenContext, type Plugin } from "../plugin.js";
import { bitwardenStore } from "../secrets/store.js";
import type { SecretRef } from "../types.js";

// Redkite's own vault, and a plugin like any other: a deployment that does not
// register it cannot resolve a bitwarden ref, and says so before it builds.

// The one variable a vault needs when the session was obtained elsewhere. A CI
// job that unlocked once and reuses it across several deploys is the case
const KEY = "BW_KEY";

export type BitwardenOptions = {
  // Whether this vault answers secret refs, and what unlocks it. true reads
  // BW_KEY, and falls back to the api credentials when that is not set. A
  // string is the session itself, for a config that names its own variable.
  // false registers the plugin without a store, for a deployment that has
  // stopped reading from it but has not yet taken the refs out
  secrets?: boolean | string;
};

function vault(options: BitwardenOptions = {}): Plugin {
  const secrets = options.secrets ?? true;
  if (secrets === false) return definePlugin({ name: "bitwarden" });

  return definePlugin({
    name: "bitwarden",
    stores: { bitwarden: async (context) => await open(secrets, context) },
  });
}

async function open(secrets: true | string, context: OpenContext) {
  const session = typeof secrets === "string" ? secrets : process.env[KEY];
  if (session) return await bitwardenStore({ session, detail: context.detail });

  return await bitwardenStore({
    detail: context.detail,
    clientId: required("BW_CLIENT_ID"),
    clientSecret: required("BW_CLIENT_SECRET"),
    password: required("BW_PASSWORD"),
  });
}

function required(name: string) {
  const value = process.env[name];
  if (value) return value;

  throw new Error(
    `Neither ${KEY} nor ${name} is set, and this deployment reads its environment from Bitwarden`,
  );
}

// The plugin is what a deployment registers; the item is what an app points at.
// Both are named bitwarden because both are the same vault, and the id is a
// pointer rather than a secret, so it belongs in the config
export const bitwarden = Object.assign(vault, {
  item: (id: string): SecretRef => ({ provider: "bitwarden", id }),
});
