import { defineStep } from "../src/index.js";
import type { Built, Finished, Prepared, Released, Start } from "../src/index.js";

// Not a test: a file that only compiles if the wrong step is impossible to
// write. Every @ts-expect-error below is an error if the compiler stops
// catching what it names, so `npm run check` is the assertion.
//
// The type catches a phase nobody defined and a value a slot has not produced
// yet. A misspelled slot and a name that is not kebab-case are caught when the
// config loads instead, because a template literal cannot exclude them.

// A step's input is decided by where it runs, not annotated at the call site
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

// Redkite's own four sit at ordinary points, and replacing one means answering
// with what the rest of the run was written to receive
defineStep("build", (input) => {
  const prepared: Prepared = input;
  return { ...prepared, apps: [] };
});

defineStep("cleanup", (input) => ({ ...input, removed: [], reclaimed: [] }));

// A phase nobody defined
// @ts-expect-error
defineStep("provision:after:x", (input) => input);

// @ts-expect-error
defineStep("provision", (input) => input);

// Nothing before the swap step has a release to read
// @ts-expect-error
defineStep("swap:before:early", (input: Released) => input);

// Replacing a redkite step means keeping its half of the contract: everything
// after build was written expecting a Built
// @ts-expect-error
defineStep("build", (input) => input);

// The phase that moves the addresses is named for what it does, and the name it
// used to have is not a point
// @ts-expect-error
defineStep("deploy:before:migrate", (input) => input);
