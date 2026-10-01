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

// Asserts that opting in is the only way a plugin's work happens

// The shape a config file actually has, with environments filled by the loader
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

  // A mistake or two configurations, and neither has a winner to pick
  it("refuses the same plugin twice", () => {
    assert.throws(
      () => defineDeployment({ ...authored, plugins: [noop, noop] }),
      /noop is registered twice/,
    );
  });

  // Both share one space, so the collision worth catching is between them
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

  // Two vaults for one tag has no readable intent
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

  // Both answer for one provider: to an app, a secret is a secret
  it("answers for its provider whichever Bitwarden it reads", () => {
    assert.ok(storeFor([bitwarden()], "bitwarden"), "secrets manager");
    assert.ok(storeFor([bitwarden({ secrets: false })], "bitwarden"), "password manager");
  });
});
