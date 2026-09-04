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

// The terminal half: raw keys in, a frame out on a timer. Everything it decides
// lives in screen.ts, so this file is only the parts a test cannot run.

const FRAME_MS = 100;
const ALTERNATE_ON = "\u001b[?1049h\u001b[?25l";
const ALTERNATE_OFF = "\u001b[?25h\u001b[?1049l";
const HOME = "\u001b[H";
const CLEAR_LINE = "\u001b[K";
const CLEAR_BELOW = "\u001b[J";

// A build prints tens of thousands of lines and only the tail is ever read
const KEPT = 2000;

export type Viewer = Log & {
  // Leaves the alternate screen and prints what happened, since nothing drawn
  // inside it survives
  close(): void;
};

// A pty whose size nobody set answers 0 rather than nothing, and a view one row
// tall can only ever show the step the cursor is on
const ROWS = 24;
const COLUMNS = 80;

const sizeOf = (stream: NodeJS.WriteStream) => ({
  rows: stream.rows && stream.rows > 4 ? stream.rows : ROWS,
  columns: stream.columns && stream.columns > 20 ? stream.columns : COLUMNS,
});

export type ViewerOptions = {
  // Called on the quit key. The caller decides what asking twice means, since
  // the same request arrives as a signal when there is no view
  onQuit?: () => void;
};

export function createViewer(
  stream: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  options: ViewerOptions = {},
): Viewer {
  // NO_COLOR is a standing instruction rather than a preference to re-ask
  // about, and a terminal that took the alternate screen still may not paint
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

  const say = (message: string) =>
    change((current) => ({ ...current, messages: [...current.messages, message] }));

  const onKey = (data: string) => {
    for (const key of keysOf(data)) {
      // Not a return: two presses in one read are two asks, and the second one
      // is what hardens the signal the first one sent
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
    // The alternate screen takes every frame with it, so the run has to be
    // written again on the screen the person keeps
    for (const line of summary(model)) stream.write(`${line}\n`);
  };

  // What a second press means is not the view's to decide: the same key
  // arrives as a signal when there is no view, and one answer serves both
  const quit = () => options.onQuit?.();

  process.once("exit", () => open && stream.write(ALTERNATE_OFF));

  const step = (label: string): Task => {
    let index = 0;

    change((current) => {
      index = current.steps.length;

      const started: Step = {
        label,
        started: Date.now(),
        state: "running",
        lines: [],
        // The one running is the one being read, unless the reader said no
        expanded: !current.minimal,
        held: false,
        offset: 0,
      };

      return {
        ...current,
        steps: [...current.steps, started],
        cursor: current.following ? index : current.cursor,
      };
    });

    const edit = (change_: (step: Step) => Step) =>
      change((current) => ({
        ...current,
        steps: current.steps.map((item, at) => (at === index ? change_(item) : item)),
      }));

    // A finished step shuts, so the list stays a list. One the reader opened by
    // hand stays open: it is being read, and closing it would move the screen
    const settle = (state: Step["state"], note?: string) =>
      edit((item) => ({
        ...item,
        state,
        note,
        detail: undefined,
        ended: Date.now(),
        expanded: item.held,
      }));

    return {
      detail: (message) => edit((item) => ({ ...item, detail: message })),
      line: (message) =>
        edit((item) => ({ ...item, lines: [...item.lines, message].slice(-KEPT) })),
      done: (message) => settle("done", message),
      fail: (message) => settle("failed", message),
    };
  };

  return Object.assign(say, {
    warn: say,
    fail: say,
    done: say,
    step,
    close,
  });
}

// One line per step and whatever was said outside them, which is the record a
// person scrolls back to after the deploy is over
function summary(model: Model): string[] {
  const rows = model.steps.map((step) => {
    const glyph = step.state === "done" ? "✔" : step.state === "failed" ? "✘" : "·";
    const said = step.note ? `: ${step.note}` : "";
    const took = elapsed(step.ended ?? model.now, step.started);

    return `${glyph} ${step.label}${said} (${took})`;
  });

  return [...rows, ...model.messages];
}
