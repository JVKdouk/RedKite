import type { Log, Task } from "../log.js";

import {
  apply,
  elapsed,
  emptyModel,
  keysOf,
  render,
  type Model,
  type Step,
} from "./screen.js";

// The terminal half: raw keys in, a frame out on a timer. Decisions live in screen.ts

const FRAME_MS = 100;
const ALTERNATE_ON = "\u001b[?1049h\u001b[?25l";
const ALTERNATE_OFF = "\u001b[?25h\u001b[?1049l";
const HOME = "\u001b[H";
const CLEAR_LINE = "\u001b[K";
const CLEAR_BELOW = "\u001b[J";

// A build prints tens of thousands of lines and only the tail is read
const KEPT = 2000;

export type Viewer = Log & {
  // Leaves the alternate screen, since nothing drawn inside it survives
  close(): void;
};

// A pty whose size nobody set answers 0, and one row shows only the cursor
const ROWS = 24;
const COLUMNS = 80;

const sizeOf = (stream: NodeJS.WriteStream) => ({
  rows: stream.rows && stream.rows > 4 ? stream.rows : ROWS,
  columns: stream.columns && stream.columns > 20 ? stream.columns : COLUMNS,
});

export type ViewerOptions = {
  // The caller decides what asking twice means, since it also arrives as a signal
  onQuit?: () => void;
};

export function createViewer(
  stream: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  options: ViewerOptions = {},
): Viewer {
  // NO_COLOR is a standing instruction, and the alternate screen may not paint
  const colour = !process.env["NO_COLOR"] && stream.isTTY === true;
  const size = sizeOf(stream);
  let model = emptyModel(size.rows, size.columns, Date.now());
  let open = true;

  const draw = () => {
    if (!open) return;

    model = { ...model, now: Date.now(), ...sizeOf(stream) };
    const rows = render(model, colour).map((row) => `${row}${CLEAR_LINE}`);

    stream.write(`${HOME}${rows.join("\n")}${CLEAR_BELOW}`);
  };

  const change = (next: (current: Model) => Model) => {
    model = next(model);
    draw();
  };

  const timer = setInterval(draw, FRAME_MS);
  timer.unref();

  stream.write(ALTERNATE_ON);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  const plan = (points: string[]) => change((current) => ({ ...current, planned: points }));

  const say = (message: string) =>
    change((current) => ({
      ...current,
      messages: [...current.messages, { text: message, at: Date.now() }],
    }));

  const onKey = (data: string) => {
    for (const key of keysOf(data)) {
      // Not a return: two presses in one read are two asks, and the second hardens it
      if (key === "quit") quit();
      else change((current) => apply(current, key));
    }
  };

  input.on("data", onKey);
  const onResize = () => draw();
  stream.on("resize", onResize);

  const close = () => {
    if (!open) return;
    open = false;

    clearInterval(timer);
    input.off("data", onKey);
    stream.off("resize", onResize);
    if (input.isTTY) input.setRawMode(false);
    input.pause();

    stream.write(ALTERNATE_OFF);
    // The alternate screen takes every frame, so the run is written again after
    for (const line of summary(model)) stream.write(`${line}\n`);
  };

  // Not the view's to decide: the same key arrives as a signal without one
  const quit = () => options.onQuit?.();

  process.once("exit", () => open && stream.write(ALTERNATE_OFF));

  const step = (label: string, parent?: number): Task => {
    let index = 0;

    change((current) => {
      index = current.steps.length;
      const above = parent === undefined ? undefined : current.steps[parent];

      const started: Step = {
        label,
        started: Date.now(),
        state: "running",
        lines: [],
        parent,
        depth: above ? above.depth + 1 : 0,
        // The one running is the one being read, unless the reader said otherwise
        expanded: !current.minimal,
        held: false,
        offset: 0,
      };

      return {
        ...current,
        steps: spoken([...current.steps, started], parent, Date.now()),
        cursor: current.following ? index : current.cursor,
      };
    });

    const edit = (change_: (step: Step) => Step) =>
      change((current) => ({
        ...current,
        steps: spoken(
          current.steps.map((item, at) => (at === index ? change_(item) : item)),
          parent,
          Date.now(),
        ),
      }));

    // A finished step shuts; one the reader opened stays open, being read
    const settle = (state: Step["state"], note?: string) =>
      edit((item) => ({
        ...item,
        state,
        note,
        detail: undefined,
        ended: Date.now(),
        expanded: item.held,
      }));

    // Both mark the step as having spoken, which is what quiet reads
    return {
      detail: (message) => edit((item) => ({ ...item, detail: message, spoke: Date.now() })),
      line: (message) =>
        edit((item) => ({
          ...item,
          spoke: Date.now(),
          lines: [...item.lines, message].slice(-KEPT),
        })),
      done: (message) => settle("done", message),
      fail: (message) => settle("failed", message),
      step: (child) => step(child, index),
    };
  };

  return Object.assign(say, {
    plan,
    warn: say,
    fail: say,
    done: say,
    step,
    close,
  });
}

// A phase whose work is in its children would otherwise read as silent
export function spoken(steps: Step[], from: number | undefined, at: number) {
  let parent = from;

  while (parent !== undefined) {
    const above = steps[parent];
    if (!above) break;

    steps[parent] = { ...above, spoke: at };
    parent = above.parent;
  }

  return steps;
}

// The record a person scrolls back to after the deploy is over
function summary(model: Model): string[] {
  const rows = model.steps.map((step) => {
    const glyph = step.state === "done" ? "✔" : step.state === "failed" ? "✘" : "·";
    const said = step.note ? `: ${step.note}` : "";
    const took = elapsed(step.ended ?? model.now, step.started);

    // Indented under the step it ran inside, the same as it was drawn
    return `${"  ".repeat(step.depth)}${glyph} ${step.label}${said} (${took})`;
  });

  return [
    ...rows,
    ...model.messages.map((message) => message.text),
    ...whatFailed(model),
  ];
}

// Why a build stopped is in its own output, which the alternate screen took
const TAIL = 20;

function whatFailed(model: Model) {
  const rows: string[] = [];

  for (const step of model.steps.filter((item) => item.state === "failed")) {
    if (step.lines.length === 0) continue;

    const kept = step.lines.slice(-TAIL);
    const dropped = step.lines.length - kept.length;

    rows.push("", `${step.label} said:`);
    if (dropped > 0) rows.push(`  ... ${dropped} earlier lines`);
    rows.push(...kept.map((line) => `  ${line}`));
  }

  return rows;
}
