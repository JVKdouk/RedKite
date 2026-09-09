import assert from "node:assert/strict";
import { describe, it } from "node:test";

import base from "./deployment.js";
import type { Deployment } from "../src/index.js";
import {
  bitwarden,
  defineDeployment,
  definePlugin,
  defineStep,
  pluginSteps,
  storeFor,
} from "../src/index.js";

// Nothing a plugin carries happens until a deployment lists it, redkite's own
// vault included. What is asserted here is that opting in is the only way in.

// The loader fills environments in, and defineDeployment refuses one that
// carries them, so the shape a config file actually has is this
const { environments: _, ...authored } = base as Deployment;

const noop = definePlugin({
  name: "noop",
  steps: [defineStep("setup:after:noop", (input) => input)],
});

describe("registering a plugin", () => {
  it("contributes nothing until a deployment lists it", () => {
    assert.deepEqual(pluginSteps(undefined), []);
    assert.deepEqual(pluginSteps([]), []);
    assert.deepEqual(pluginSteps([noop]).map((step) => step.point), ["setup:after:noop"]);
  });

  // Two of the same is either a mistake or two configurations of one thing,
  // and neither is something to pick a winner for
  it("refuses the same plugin twice", () => {
    assert.throws(
      () => defineDeployment({ ...authored, plugins: [noop, noop] }),
      /noop is registered twice/,
    );
  });

  // A plugin's point and the deployment's own share one space, so the clash
  // worth catching is between them rather than within either
  it("refuses a plugin claiming a point the deployment already claims", () => {
    assert.throws(
      () =>
        defineDeployment({
          ...authored,
          plugins: [noop],
          steps: [defineStep("setup:after:noop", (input) => input)],
        }),
      /Two steps share the point setup:after:noop/,
    );
  });

  it("checks a plugin's points where the plugin is written", () => {
    assert.throws(
      () => definePlugin({ name: "bad", steps: [defineStep("setup:after:Not Kebab", (i) => i)] }),
      /kebab-case/,
    );
  });
});

describe("finding the store for a provider", () => {
  it("answers with nothing when no plugin claims it", () => {
    assert.equal(storeFor([noop], "bitwarden"), undefined);
    assert.equal(storeFor(undefined, "bitwarden"), undefined);
  });

  it("answers with the one that claims it", () => {
    assert.ok(storeFor([noop, bitwarden()], "bitwarden"));
  });

  // Two vaults for one tag is a config nobody can read the intent of
  it("refuses two plugins claiming one provider", () => {
    const other = definePlugin({
      name: "other",
      stores: { bitwarden: async () => ({ read: async () => "" }) },
    });

    assert.throws(() => storeFor([bitwarden(), other], "bitwarden"), /both resolve bitwarden/);
  });
});

describe("the vault as a plugin", () => {
  it("claims the provider its items name", () => {
    const item = bitwarden.item("00000000-0000-4000-8000-000000000001");

    assert.equal(item.provider, "bitwarden");
    assert.ok(storeFor([bitwarden()], item.provider));
  });

  // Two services, one plugin. Both answer for the same provider tag, because
  // to an app a secret is a secret whichever Bitwarden holds it
  it("answers for its provider whichever Bitwarden it reads", () => {
    assert.ok(storeFor([bitwarden()], "bitwarden"), "secrets manager");
    assert.ok(storeFor([bitwarden({ secrets: false })], "bitwarden"), "password manager");
  });
});
