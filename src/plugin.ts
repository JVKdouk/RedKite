import { assertSteps, type AnyStep } from "./pipeline.js";
import type { SecretStore } from "./secrets/refs.js";

export type OpenContext = {
  detail: (message: string) => void;
};

// Opened once, and only when a ref names the provider it answers for
export type OpenStore = (context: OpenContext) => Promise<SecretStore>;

export type Plugin = {
  name: string;
  // Run in the order the deployment lists the plugins, above its own steps
  steps?: AnyStep[];
  // Provider tag to how that store is opened
  stores?: Record<string, OpenStore>;
};

// Checks the claimed points here, so a typo fails in the plugin, not the config
export function definePlugin<const T extends Plugin>(plugin: T): T {
  assertSteps(plugin.steps ?? []);
  return plugin;
}

export function pluginSteps(plugins: Plugin[] = []): AnyStep[] {
  return plugins.flatMap((plugin) => plugin.steps ?? []);
}

export function storeFor(plugins: Plugin[] = [], provider: string) {
  const claiming = plugins.filter((plugin) => plugin.stores?.[provider]);

  if (claiming.length > 1) {
    const names = claiming.map((plugin) => plugin.name).join(" and ");
    throw new Error(`${names} both resolve ${provider} secrets, and only one can`);
  }

  return claiming[0]?.stores?.[provider];
}
