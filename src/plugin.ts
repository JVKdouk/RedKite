import { assertSteps, type AnyStep } from "./pipeline.js";
import type { SecretStore } from "./secrets/refs.js";

// What a deployment can be handed that redkite did not write. A plugin adds
// work to the run, or teaches it to resolve a kind of secret, and nothing it
// brings happens until a deployment lists it. Redkite's own vault is one of
// these rather than something wired in behind them.

export type OpenContext = {
  // What the step row says while the store is being opened. Unlocking a vault
  // is the slowest thing a deploy does before it starts building
  detail: (message: string) => void;
};

// Opened once, and only when a ref names the provider it answers for
export type OpenStore = (context: OpenContext) => Promise<SecretStore>;

export type Plugin = {
  // Says which one when a deployment registers the same plugin twice, and what
  // a failure to open a store is reported against
  name: string;
  // Run in the order the deployment lists the plugins, above its own steps
  steps?: AnyStep[];
  // Provider tag to how that store is opened
  stores?: Record<string, OpenStore>;
};

// Identity, but the points a plugin claims are checked where it is written
// rather than where it is registered, so a typo is the plugin's own failure
export function definePlugin<const T extends Plugin>(plugin: T): T {
  assertSteps(plugin.steps ?? []);
  return plugin;
}

export function pluginSteps(plugins: Plugin[] = []): AnyStep[] {
  return plugins.flatMap((plugin) => plugin.steps ?? []);
}

// The one that answers for this provider. Two plugins claiming it would be two
// vaults for one tag, which is a config nobody can read the intent of
export function storeFor(plugins: Plugin[] = [], provider: string) {
  const claiming = plugins.filter((plugin) => plugin.stores?.[provider]);

  if (claiming.length > 1) {
    const names = claiming.map((plugin) => plugin.name).join(" and ");
    throw new Error(`${names} both resolve ${provider} secrets, and only one can`);
  }

  return claiming[0]?.stores?.[provider];
}
