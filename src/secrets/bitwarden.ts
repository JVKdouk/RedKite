import type { SecretRef } from "../types.js";

// Names an item in a Bitwarden vault. The id is not a secret, it is a pointer,
// so it belongs in the config while the credentials arrive at deploy time
export function bitwarden(id: string): SecretRef {
  return { provider: "bitwarden", id };
}
