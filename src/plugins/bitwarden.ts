import { definePlugin, type OpenContext, type Plugin } from "../plugin.js";
import { secretsManagerStore } from "../secrets/manager.js";
import { bitwardenStore } from "../secrets/store.js";
import type { SecretRef } from "../types.js";

// Two Bitwarden services: Secrets Manager takes an access token, the password manager a session

// The one variable either side reads, so a job sets one thing
const KEY = "BW_KEY";

export type BitwardenOptions = {
  // true (default) is Secrets Manager and BW_KEY is its token; false is the password manager
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

// A session skips the login and unlock, the only way in without a master password
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

// Both are named bitwarden; an id is a pointer, not a secret, so it may be committed
export const bitwarden = Object.assign(vault, {
  item: (id: string): SecretRef => ({ provider: "bitwarden", id }),
});
