import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import type { Step } from "../src/cli/screen.js";
import { createViewer, spoken } from "../src/cli/viewer.js";

const ALTERNATE_OFF = "\u001b[?25h\u001b[?1049l";

// What a person keeps is whatever close writes on the way out

function screen() {
  const written: string[] = [];

  const stream = Object.assign(new EventEmitter(), {
    isTTY: false,
    rows: 24,
    columns: 80,
    write: (text: string) => {
      written.push(text);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;

  const input = Object.assign(new EventEmitter(), {
    isTTY: false,
    resume: () => {},
    pause: () => {},
    setEncoding: () => {},
  }) as unknown as NodeJS.ReadStream;

  // Only what comes after the alternate screen survives
  const kept = () => written.join("").split(ALTERNATE_OFF).slice(1).join("");

  return { stream, input, said: kept };
}

describe("what is left on the screen after a failure", () => {
  it("writes the end of what the failed step was saying", () => {
    const { stream, input, said } = screen();
    const view = createViewer(stream, input);

    const build = view.step("build");
    build.line("compiling");
    build.line("error TS2307: cannot find module");
    build.fail("build failed");
    view.close();

    assert.match(said(), /build said:/);
    assert.match(said(), /error TS2307: cannot find module/);
  });

  it("says how many lines it did not write", () => {
    const { stream, input, said } = screen();
    const view = createViewer(stream, input);

    const build = view.step("build");
    for (let index = 0; index < 50; index += 1) build.line(`line ${index}`);
    build.fail("build failed");
    view.close();

    assert.match(said(), /\.\.\. 30 earlier lines/);
    assert.ok(!said().includes("line 29"), "the first 30 are dropped");
    assert.match(said(), /line 49/);
  });

  it("leaves a step that passed to its one line", () => {
    const { stream, input, said } = screen();
    const view = createViewer(stream, input);

    const build = view.step("build");
    build.line("compiling");
    build.done();
    view.close();

    assert.ok(!said().includes("build said:"), said());
    assert.ok(!said().includes("compiling"), "output of a step that worked is noise");
  });
});

// The record reads the way the run was drawn, with work under its step
describe("what is left on the screen for a step inside another", () => {
  it("writes it indented under the step it ran inside", () => {
    const { stream, input, said } = screen();
    const view = createViewer(stream, input);

    const build = view.step("build");
    build.step("Building backend").done("abc1234");
    build.done();
    view.close();

    assert.match(said(), /^✔ build \(\d+s\)$/m);
    assert.match(said(), /^ {2}✔ Building backend: abc1234 \(\d+s\)$/m);
  });
});

// A phase whose work is in its children would otherwise read as silent
describe("a step speaking for the steps it runs inside", () => {
  const row = (label: string, over: Partial<Step> = {}): Step => ({
    label,
    started: 0,
    state: "running",
    lines: [],
    expanded: false,
    held: false,
    offset: 0,
    depth: 0,
    spoke: 0,
    ...over,
  });

  it("marks every step above it as having spoken, however deep", () => {
    const steps = [
      row("build"),
      row("Building backend", { parent: 0, depth: 1 }),
      row("installing", { parent: 1, depth: 2 }),
    ];

    const after = spoken(steps, 1, 5000);

    assert.equal(after[1]?.spoke, 5000);
    assert.equal(after[0]?.spoke, 5000);
    assert.equal(after[2]?.spoke, 0, "not the step that spoke, which marks itself");
  });

  it("leaves everything alone for a step at the top", () => {
    const steps = [row("setup"), row("build")];

    assert.deepEqual(spoken(steps, undefined, 5000).map((step) => step.spoke), [0, 0]);
  });
});
