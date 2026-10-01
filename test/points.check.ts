import { defineDeployment, defineStep } from "../src/index.js";
import type { Built, Finished, Prepared, Released, Start } from "../src/index.js";

// Not a test: `npm run check` is the assertion, one per @ts-expect-error below
defineStep("setup:before:check", (input) => {
  const start: Start = input;
  return start;
});

defineStep("setup:provision", (input) => {
  const prepared: Prepared = input;
  return prepared;
});

defineStep("build:after:sourcemaps", (input) => {
  const built: Built = input;
  return built;
});

defineStep("swap:before:announce", (input) => {
  const built: Built = input;
  return built;
});

defineStep("swap:after:record", (input) => {
  const released: Released = input;
  return released;
});

defineStep("cleanup:after:notify", (input) => {
  const finished: Finished = input;
  return finished;
});

defineStep("build", (input) => {
  const prepared: Prepared = input;
  return { ...prepared, apps: [] };
});

defineStep("cleanup", (input) => ({ ...input, removed: [], reclaimed: [] }));

// @ts-expect-error  a phase nobody defined
defineStep("provision:after:x", (input) => input);

// @ts-expect-error  and the same phase as a bare point
defineStep("provision", (input) => input);

// @ts-expect-error  nothing before the swap step has a release to read
defineStep("swap:before:early", (input: Released) => input);

// @ts-expect-error  everything after build was written expecting a Built
defineStep("build", (input) => input);

// @ts-expect-error  the phase was renamed, and the old name is not a point
defineStep("deploy:before:migrate", (input) => input);

defineDeployment({
  project: "acme",
  services: [],
  apps: [],
  // @ts-expect-error  an environment lives in a file of its own
  environments: { staging: { branch: "main", subnet: "10.0.0", publicPort: 80 } },
});

// And a deployment without them still compiles, because the loader fills them
defineDeployment({ project: "acme", services: [], apps: [] });

defineDeployment({
  project: "acme",
  services: [],
  apps: [],
  environment: { branch: "main", subnet: "10.0.0", publicPort: 80 },
});
