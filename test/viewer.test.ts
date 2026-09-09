import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createViewer } from "../src/cli/viewer.js";

const ALTERNATE_OFF = "\u001b[?25h\u001b[?1049l";

// The alternate screen takes every frame with it, so what a person keeps is
// whatever close writes on the way out. That is the only way to assert on it.

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

  // Only what comes after the alternate screen is handed back survives it, so
  // the live frames above are not part of the record
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
