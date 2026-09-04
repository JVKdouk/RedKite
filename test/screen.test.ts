import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  apply,
  clip,
  elapsed,
  emptyModel,
  HELP,
  keyOf,
  keysOf,
  render,
  type Model,
  type Step,
} from "../src/cli/screen.js";

// The view is a pure function of the model, which is the only reason any of
// this can be asserted on rather than watched.

const START = 1_000_000;

function step(label: string, over: Partial<Step> = {}): Step {
  return {
    label,
    started: START,
    state: "running",
    lines: [],
    expanded: false,
    held: false,
    offset: 0,
    ...over,
  };
}

function model(steps: Step[], over: Partial<Model> = {}): Model {
  return {
    ...emptyModel(20, 80, START),
    steps,
    cursor: steps.length - 1,
    ...over,
  };
}

const rows = (m: Model) => render(m).filter((row) => row.trim() !== "");
const at = (m: Model, needle: string) => render(m).findIndex((row) => row.includes(needle));

describe("reading the keys", () => {
  it("knows the ones the footer offers", () => {
    assert.equal(keyOf("[A"), "up");
    assert.equal(keyOf("[B"), "down");
    assert.equal(keyOf("[1;2A"), "latest");
    assert.equal(keyOf("\r"), "toggle");
    assert.equal(keyOf("+"), "expand");
    assert.equal(keyOf("-"), "collapse");
    assert.equal(keyOf("q"), "quit");
    assert.equal(keyOf(""), "quit");
  });

  // Two keys pressed quickly arrive as one read, and taking the chunk whole
  // matched neither of them
  it("reads every key in one chunk", () => {
    assert.deepEqual(keysOf("\u001b[A\r"), ["up", "toggle"]);
    assert.deepEqual(keysOf("\u001b[A\u001b[A\u001b[A"), ["up", "up", "up"]);
    assert.deepEqual(keysOf("\u001b[1;2A-"), ["latest", "collapse"]);
  });

  it("skips what it does not know without losing what follows", () => {
    assert.deepEqual(keysOf("\u001b[Cz+"), ["expand"]);
  });

  // Pressing quit twice quickly is how a stop is escalated, and both presses
  // arrive in one read
  it("reads a second quit in the same read", () => {
    assert.deepEqual(keysOf("qq"), ["quit", "quit"]);
    assert.deepEqual(keysOf("\u0003\u0003\u0003"), ["quit", "quit", "quit"]);
  });

  it("ignores anything else rather than acting on it", () => {
    assert.equal(keyOf("z"), undefined);
    assert.equal(keyOf("[C"), undefined);
  });
});

describe("moving through the steps", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);

  it("scrolls the open log before it leaves the step", () => {
    const one = model([step("setup"), step("build", { expanded: true, lines })]);
    const two = apply(one, "up");

    assert.equal(two.cursor, 1, "still on build");
    assert.equal(two.steps[1]?.offset, 1);
  });

  it("leaves the step once the log has no more to give", () => {
    const one = model([
      step("setup"),
      step("build", { expanded: true, lines, offset: lines.length - 1 }),
    ]);

    assert.equal(apply(one, "up").cursor, 0);
  });

  // A collapsed step has no window to scroll, so the arrow is a move
  it("moves straight past a step that is shut", () => {
    const one = model([step("setup"), step("build", { lines })]);
    assert.equal(apply(one, "up").cursor, 0);
  });

  it("comes back down through the log before the next step", () => {
    const one = model(
      [step("setup", { expanded: true, lines, offset: 2 }), step("build")],
      { cursor: 0 },
    );

    const two = apply(one, "down");
    assert.equal(two.cursor, 0);
    assert.equal(two.steps[0]?.offset, 1);
  });

  it("jumps to the newest step and follows it again", () => {
    const one = model([step("setup"), step("build"), step("swap")], {
      cursor: 0,
      following: false,
    });

    const two = apply(one, "latest");
    assert.equal(two.cursor, 2);
    assert.equal(two.following, true);
  });

  // Moving away means the reader chose a step, and a new one must not steal it
  it("stops following once the cursor is moved", () => {
    const one = model([step("setup"), step("build")]);
    assert.equal(apply(one, "up").following, false);
  });
});

describe("opening and closing", () => {
  it("opens the step under the cursor and closes it again", () => {
    const one = model([step("setup"), step("build")], { cursor: 0 });

    const opened = apply(one, "toggle");
    assert.equal(opened.steps[0]?.expanded, true);
    assert.equal(opened.steps[0]?.held, true, "held, so finishing does not shut it");

    assert.equal(apply(opened, "toggle").steps[0]?.expanded, false);
  });

  it("collapses everything and stops opening what comes next", () => {
    const one = model([step("setup", { expanded: true }), step("build", { expanded: true })]);
    const two = apply(one, "collapse");

    assert.deepEqual(two.steps.map((item) => item.expanded), [false, false]);
    assert.equal(two.minimal, true);
  });

  it("opens the current step again from anywhere", () => {
    const shut = apply(model([step("setup"), step("build")], { cursor: 0 }), "collapse");
    const two = apply(shut, "expand");

    assert.equal(two.minimal, false);
    assert.equal(two.steps[1]?.expanded, true, "the current one, not the one under the cursor");
    assert.equal(two.cursor, 0, "and the cursor stays where the reader put it");
  });

  // The same instruction, said with a different key
  it("treats enter on the current step as plus", () => {
    const shut = apply(model([step("setup"), step("build")]), "collapse");
    const two = apply(shut, "toggle");

    assert.equal(two.minimal, false);
    assert.equal(two.steps[1]?.expanded, true);
  });

  it("does not start opening again when an older step is opened", () => {
    const shut = apply(model([step("setup"), step("build")]), "collapse");
    const two = apply({ ...shut, cursor: 0 }, "toggle");

    assert.equal(two.minimal, true, "one step was asked for, not all of them");
  });
});

describe("what the terminal is given", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);

  it("fills the terminal exactly, footer included", () => {
    const drawn = render(model([step("setup", { expanded: true, lines })]));

    assert.equal(drawn.length, 20);
    assert.equal(drawn.at(-1), HELP);
  });

  // The title is written before the log, so the log rolls underneath a header
  // that does not move
  it("keeps the open step's title above its log", () => {
    const one = model([step("setup"), step("build", { expanded: true, lines })]);
    const drawn = render(one);

    const header = drawn.findIndex((row) => row.includes("build"));
    const first = drawn.findIndex((row) => row.includes("line "));

    assert.ok(header >= 0 && first > header);
  });

  it("shows the newest lines, not the first ones", () => {
    const drawn = rows(model([step("build", { expanded: true, lines })]));

    assert.ok(drawn.some((row) => row.includes("line 99")));
    assert.ok(!drawn.some((row) => row.includes("line 0 ")));
  });

  // A wrapped line would push everything below it off a frame counted in rows
  it("gives each line one row, and says where it cut", () => {
    const long = "x".repeat(400);
    const drawn = rows(model([step("build", { expanded: true, lines: [long] })]));
    const row = drawn.find((item) => item.includes("xxx")) ?? "";

    assert.equal(row.length, 80);
    assert.ok(row.endsWith("…"));
  });

  it("leaves a line that fits exactly as it is", () => {
    const drawn = rows(model([step("build", { expanded: true, lines: ["short"] })]));

    assert.ok(drawn.some((row) => row.endsWith("short")));
    assert.ok(!drawn.some((row) => row.includes("…")));
  });

  it("shows what the reader scrolled back to", () => {
    const drawn = rows(model([step("build", { expanded: true, lines, offset: 50 })]));

    assert.ok(drawn.some((row) => row.includes("line 49")));
    assert.ok(!drawn.some((row) => row.includes("line 99")));
  });

  it("gives the room to the step being read", () => {
    const one = model([
      step("setup", { expanded: true, lines }),
      step("build", { expanded: true, lines }),
    ]);

    const drawn = render(one);
    const build = drawn.filter((row) => row.includes("line ")).length;

    assert.ok(build > 6, "the focused step gets more than a glance");
    assert.ok(at(one, "setup") < at(one, "build"));
  });

  it("drops to titles alone when there are more steps than lines", () => {
    const many = Array.from({ length: 40 }, (_, index) => step(`step ${index}`));
    const drawn = render(model(many, { cursor: 39 }));

    assert.equal(drawn.length, 20);
    assert.ok(drawn.some((row) => row.includes("step 39")));
    assert.ok(!drawn.some((row) => row.includes("│")));
  });

  // A row wider than the terminal wraps, and a wrapped row pushes everything
  // under it out of a frame counted in rows
  it("never draws a row wider than the terminal", () => {
    const wide = model(
      [
        step("Building web", {
          expanded: true,
          detail: "RUN --mount=type=cache,id=web-staging-yarn-cache,target=/root/.yarn yarn build",
          lines: ["x".repeat(300)],
        }),
      ],
      { columns: 76, messages: ["y".repeat(300)], now: START + 3000 },
    );

    for (const row of render(wide)) assert.ok(row.length <= 76, `${row.length}: ${row}`);
  });

  // The label filling the gap exactly is the case that used to overflow by one
  it("keeps the timer on the row at every width", () => {
    for (let columns = 30; columns <= 120; columns += 1) {
      const one = model([step("Building web", { detail: "x".repeat(200) })], {
        columns,
        now: START + 3000,
      });

      const row = render(one)[0] ?? "";
      assert.equal(row.length, columns, `at ${columns} columns`);
      assert.ok(row.endsWith("3s"), `at ${columns} columns: ${row}`);
    }
  });

  it("marks the step under the cursor", () => {
    const drawn = render(model([step("setup"), step("build")], { cursor: 0 }));
    const marked = drawn.filter((row) => row.includes("❯"));

    assert.equal(marked.length, 1);
    assert.ok(marked[0]?.includes("setup"));
  });

  it("says how a step ended", () => {
    const done = render(model([step("setup", { state: "done", ended: START + 3000 })]));
    const failed = render(model([step("swap", { state: "failed", ended: START + 1000 })]));

    assert.ok(done[0]?.includes("✔"));
    assert.ok(failed[0]?.includes("✘"));
  });
});

describe("the colours", () => {
  const CODES = /\u001b\[[0-9;]*m/g;
  const bare = (row: string) => row.replace(CODES, "");
  const painted = (m: Model) => render(m, true);

  it("says nothing in escapes when it is not painting", () => {
    const drawn = render(model([step("build", { expanded: true, lines: ["a"] })]));
    assert.ok(drawn.every((row) => !row.includes("\u001b")));
  });

  // The cursor is a place, the running step is a state, and a reader who has
  // moved away from the running step has to be able to see both
  it("gives the selected step and the running one different colours", () => {
    const one = model([step("setup", { state: "done", ended: START + 1000 }), step("build")], {
      cursor: 0,
    });

    const drawn = painted(one);
    const selected = drawn.find((row) => bare(row).includes("setup")) ?? "";
    const running = drawn.find((row) => bare(row).includes("build")) ?? "";

    assert.ok(selected.includes("\u001b[96msetup"), selected);
    assert.ok(running.includes("\u001b[93mbuild"), running);
  });

  it("marks a failed step even when the cursor is elsewhere", () => {
    const one = model([step("swap", { state: "failed", ended: START + 1000 }), step("cleanup")], {
      cursor: 1,
    });

    const row = painted(one).find((item) => bare(item).includes("swap")) ?? "";
    assert.ok(row.includes("\u001b[91mswap"), row);
  });

  // Every width is measured before an escape is added, because an escape is
  // zero columns wide and a row measured with one in it wraps. A short row is
  // what catches it: that is where the padding is doing the work
  it("counts no escape towards the width of a row", () => {
    const details = ["", "ready", "x".repeat(200)];

    for (const detail of details) {
      for (let columns = 30; columns <= 120; columns += 7) {
        const one = model([step("web", { detail })], { columns, now: START + 3000 });
        const row = painted(one)[0] ?? "";

        assert.equal(bare(row).length, columns, `${columns} columns, detail ${detail.length}`);
        assert.ok(bare(row).endsWith("3s"), `${columns} columns`);
      }
    }
  });

  // The painted row and the plain one are the same row, so one is the other
  // with the escapes taken out
  it("paints without moving anything", () => {
    const one = model([step("setup", { state: "done", ended: START + 2000 }), step("build")], {
      columns: 64,
      now: START + 5000,
    });

    assert.deepEqual(painted(one).map(bare), render(one));
  });

  it("keeps a clipped row's ellipsis outside the colour it cut", () => {
    const one = model([step("Building web", { detail: "x".repeat(200) })], { columns: 40 });
    const row = painted(one)[0] ?? "";

    assert.ok(bare(row).includes("\u2026"));
    assert.equal(bare(row).length, 40);
  });
});

describe("what the frame keeps room for", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const rule = (drawn: string[]) => drawn.filter((row) => row.includes("\u2502")).length;

  // Messages only ever accumulated, so a long enough run pushed every log off
  // the screen: the running step stopped streaming and opening an older one
  // did nothing. They are all written out again when the view closes
  it("never lets messages crowd the logs out", () => {
    const steps = [step("setup", { state: "done" }), step("build", { expanded: true, lines })];

    const quiet = model(steps, { messages: [] });
    const noisy = model(steps, {
      messages: Array.from({ length: 40 }, (_, index) => `$ docker ps  ${index}ms`),
    });

    assert.ok(rule(render(quiet)) > 0);
    assert.ok(rule(render(noisy)) > 0, "a log survives however much was said");
  });

  it("shows the messages that were said last", () => {
    const one = model([step("build")], {
      messages: ["oldest", "middle", "newest"],
    });

    const drawn = render(one);
    assert.ok(drawn.some((row) => row.includes("newest")));
  });

  // Served last, the focused step was left with whatever the others happened
  // not to want, which on a busy build was nothing
  it("gives the focused step its room before the others get a glance", () => {
    const one = model(
      [
        step("Building frontend", { expanded: true, lines }),
        step("Building backend", { expanded: true, lines }),
      ],
      { cursor: 1 },
    );

    const drawn = render(one);
    const backend = drawn.findIndex((row) => row.includes("Building backend"));
    const under = drawn.slice(backend).filter((row) => row.includes("\u2502")).length;
    const above = drawn.slice(0, backend).filter((row) => row.includes("\u2502")).length;

    assert.ok(under > above, `focused got ${under}, the other got ${above}`);
    assert.ok(above > 0, "and the other one still gets a glance");
  });

  // Reserving a glance for a step that printed nothing is room taken from the
  // one being read and given to nobody
  it("gives a step that printed nothing none of the room", () => {
    const alone = model([step("Building web", { expanded: true, lines })], { cursor: 0 });

    const beside = model(
      [step("build", { expanded: true }), step("Building web", { expanded: true, lines })],
      { cursor: 1 },
    );

    // The empty step costs its own title row, and nothing beyond it
    assert.equal(rule(render(beside)), rule(render(alone)) - 1);
  });
});

describe("cutting a line to the terminal", () => {
  it("keeps what fits", () => {
    assert.equal(clip("abcdef", 6), "abcdef");
    assert.equal(clip("abc", 10), "abc");
  });

  it("says it cut", () => {
    assert.equal(clip("abcdefgh", 4), "abc…");
  });
});

describe("the clocks", () => {
  it("counts the whole run in the gutter and the step beside it", () => {
    const one = model([step("build", { started: START + 5000 })], { now: START + 95_000 });
    const drawn = render(one);

    assert.ok(drawn[0]?.startsWith("[01:35]"), drawn[0]);
    assert.ok(drawn[0]?.endsWith("1m30s"), drawn[0]);
  });

  // A finished step is a record of what it cost, so the number stops moving
  it("freezes a step's timer at what it cost", () => {
    const finished = step("build", { state: "done", ended: START + 12_000 });

    const early = render(model([finished], { now: START + 20_000 }));
    const late = render(model([finished], { now: START + 900_000 }));

    assert.ok(early[0]?.endsWith("12s"));
    assert.ok(late[0]?.endsWith("12s"));
  });

  it("reads a long run as minutes and seconds", () => {
    assert.equal(elapsed(START + 9000, START), "9s");
    assert.equal(elapsed(START + 92_000, START), "1m32s");
    assert.equal(elapsed(START + 92_000, START, true), "01:32");
  });
});
