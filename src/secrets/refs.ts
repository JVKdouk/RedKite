import type { SecretRef, SecretRefs } from "../types.js";

// Resolves an item to its contents. One per provider named by a ref
export type SecretStore = {
  read(id: string): Promise<string>;
};

export type SecretStores = Record<string, SecretStore>;

export function listRefs(refs: SecretRefs | undefined): SecretRef[] {
  if (!refs) return [];
  return Array.isArray(refs) ? refs : [refs];
}

export async function readRef(ref: SecretRef, stores: SecretStores) {
  const store = stores[ref.provider];
  if (store) return await store.read(ref.id);

  const known = Object.keys(stores).join(", ") || "none";
  throw new Error(`No store for provider ${ref.provider}, deploy was given ${known}`);
}

// Concatenated in the order written. Every dotenv parser builds an object as it
// reads, so a key that appears twice takes its later value, which is the
// precedence the config file reads as having
export async function readEnv(refs: SecretRefs | undefined, stores: SecretStores) {
  const contents = await Promise.all(
    listRefs(refs).map(async (ref) => await readRef(ref, stores)),
  );

  return contents.map((text) => (text.endsWith("\n") ? text : `${text}\n`)).join("");
}
