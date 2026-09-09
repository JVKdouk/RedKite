import { definePlugin, defineStep, type Plugin } from "redkite";

// What an external plugin is: a package exporting a function that answers with
// a Plugin. Nothing registers itself, so installing this changes nothing until
// a deployment lists it, and there is no build step to run: redkite reads the
// config with Node's own TypeScript, and a plugin is read the same way.

export type AnnounceOptions = {
  // Where to post. A URL is not a secret, and one that is belongs in the vault
  url: string;
  // Named rather than given, so a token is not committed with the config
  tokenFrom?: string;
  // Injected for the same reason redkite injects its own runners: what this
  // builds is asserted on rather than trusted
  request?: typeof fetch;
};

export function announce(options: AnnounceOptions): Plugin {
  const send = options.request ?? fetch;

  return definePlugin({
    name: "announce",

    // After the swap, so what it announces is a release that is serving. A
    // point is a phase, a slot and a kebab-case name, and two steps may not
    // share one
    steps: [
      defineStep("swap:after:announce", async (input, context) => {
        if (!input.ok) return input;

        context.task.detail(`announcing ${input.released.join(", ")}`);

        await send(options.url, {
          method: "POST",
          headers: token(options.tokenFrom),
          body: JSON.stringify({
            project: context.config.project,
            environment: context.environment,
            released: input.released,
          }),
        });

        return input;
      }),
    ],
  });
}

function token(name?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!name) return headers;

  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set, and announce posts with it`);

  headers["authorization"] = `Bearer ${value}`;
  return headers;
}
