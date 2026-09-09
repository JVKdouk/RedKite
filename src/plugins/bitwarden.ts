import { definePlugin, type OpenContext, type Plugin } from "../plugin.js";
import { secretsManagerStore } from "../secrets/manager.js";
import { bitwardenStore } from "../secrets/store.js";
import type { SecretRef } from "../types.js";

// Redkite's own vault, and a plugin like any other: a deployment that does not
// register it cannot resolve a bitwarden ref, and says so before it builds.
//
// Bitwarden is two services rather than one. Secrets Manager holds secrets for
// machines and opens with an access token, which is what a deploy wants. The
// password manager holds a person's vault and wants a session obtained by
// unlocking it. The ids are different, the CLIs are different, and giving one
// service's credential to the other is how a deploy ends up waiting on a
// password prompt nobody can see.

// The one variable either side reads, so a job sets one thing whichever it is
const KEY = "BW_KEY";

export type BitwardenOptions = {
  // Which Bitwarden this deployment reads, and what opens it.
  //
  // true, the default, is Secrets Manager: BW_KEY is the access token. A
  // string is that token given directly, for a config naming its own variable.
  //
  // false is the password manager: BW_KEY is a session from bw unlock --raw,
  // and without one the api credentials obtain one.
  secrets?: boolean | string;
};

function vault(options: BitwardenOptions = {}): Plugin {
  const secrets = options.secrets ?? true;

  return definePlugin({
    name: "bitwarden",
    stores: { bitwarden: async (context) => await open(secrets, context) },
  });
}

async function open(secrets: boolean | string, context: OpenContext) {
  if (secrets === false) return await passwords(context);

  const token = typeof secrets === "string" ? secrets : process.env[KEY];

  if (!token) {
    throw new Error(
      `${KEY} is not set, and this deployment reads from Bitwarden Secrets ` +
        "Manager. It is an access token, not a password. A deployment reading " +
        "the password manager instead says bitwarden({ secrets: false })",
    );
  }

  return await secretsManagerStore({ token, detail: context.detail });
}

// The personal vault. A session skips the login and the unlock, which is two
// fewer round trips and the only way a job without a master password gets in
async function passwords(context: OpenContext) {
  const session = process.env[KEY];
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
    `Neither ${KEY} nor ${name} is set, and this deployment reads its ` +
      "environment from the Bitwarden password manager",
  );
}

// The plugin is what a deployment registers; the item is what an app points at.
// Both are named bitwarden because both are the same vault, and the id is a
// pointer rather than a secret, so it belongs in the config
export const bitwarden = Object.assign(vault, {
  item: (id: string): SecretRef => ({ provider: "bitwarden", id }),
});
