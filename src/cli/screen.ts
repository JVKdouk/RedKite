// The deploy as a list of collapsibles. Model and renderer are pure, so both are asserted on

export type StepState = "running" | "done" | "failed";

export type Step = {
  label: string;
  started: number;
  ended?: number;
  state: StepState;
  // What the step said as it finished, and what it is doing right now
  note?: string;
  detail?: string;
  lines: string[];
  // When it last said anything, which is what the spinner and quiet read
  spoke?: number;
  expanded: boolean;
  // Opened by hand, so finishing does not shut it under the reader
  held: boolean;
  // Lines between the bottom of the log and the bottom of the window
  offset: number;
  // The step this runs inside, by index, and how deep that makes it
  parent?: number;
  depth: number;
};

// Carries the moment it was said, so its row stops ticking
export type Message = { text: string; at: number };

export type Model = {
  steps: Step[];
  messages: Message[];
  cursor: number;
  // The cursor follows the newest step until the reader moves it
  following: boolean;
  // Nothing opens on its own, including the step that is running
  minimal: boolean;
  // Off by default: one row per line is what keeps a frame countable
  wrapped: boolean;
  // Known before the run starts, so the end is visible from the first frame
  planned: string[];
  rows: number;
  columns: number;
  started: number;
  now: number;
};

export type Key =
  | "up"
  | "down"
  | "latest"
  | "first"
  | "toggle"
  | "expand"
  | "collapse"
  | "wrap"
  | "quit";

export function emptyModel(rows: number, columns: number, now: number): Model {
  return {
    steps: [],
    messages: [],
    cursor: 0,
    following: true,
    minimal: false,
    wrapped: false,
    planned: [],
    rows,
    columns,
    started: now,
    now,
  };
}

const ESCAPE = "\u001b";
const INTERRUPT = "\u0003";

// Two arrow keys pressed quickly land as one chunk, so each is read out
export function keysOf(data: string): Key[] {
  const keys: Key[] = [];
  let rest = data;

  while (rest.length > 0) {
    const sequence = rest.startsWith(ESCAPE) ? CSI.exec(rest)?.[0] : undefined;
    const token = sequence ?? rest.slice(0, 1);

    const key = keyOf(token);
    if (key) keys.push(key);

    rest = rest.slice(token.length);
  }

  return keys;
}

const CSI = /^\u001b\[[0-9;]*[A-Za-z]/;

export function keyOf(data: string): Key | undefined {
  if (data === `${ESCAPE}[A`) return "up";
  if (data === `${ESCAPE}[B`) return "down";
  if (data === `${ESCAPE}[1;2A`) return "latest";
  if (data === `${ESCAPE}[1;2B`) return "first";
  if (data === "\r" || data === "\n") return "toggle";
  if (data === "+" || data === "=") return "expand";
  if (data === "-" || data === "_") return "collapse";
  if (data === "w") return "wrap";
  if (data === "q" || data === INTERRUPT) return "quit";

  return undefined;
}

// The window climbs to the top of a step's log before the cursor leaves it
export function apply(model: Model, key: Key): Model {
  const step = model.steps[model.cursor];

  if (key === "latest") {
    return { ...model, cursor: Math.max(0, model.steps.length - 1), following: true };
  }

  if (key === "first") return { ...model, cursor: 0, following: false };
  if (key === "wrap") return { ...model, wrapped: !model.wrapped };

  if (key === "up") {
    if (step?.expanded && step.offset < Math.max(0, step.lines.length - 1)) {
      return scrolled(model, step.offset + 1);
    }

    return { ...model, cursor: Math.max(0, model.cursor - 1), following: false };
  }

  if (key === "down") {
    if (step?.expanded && step.offset > 0) return scrolled(model, step.offset - 1);

    const last = model.steps.length - 1;
    const cursor = Math.max(0, Math.min(last, model.cursor + 1));

    return { ...model, cursor, following: cursor === last };
  }

  if (key === "collapse") {
    return {
      ...model,
      minimal: true,
      steps: model.steps.map((item) => ({ ...item, expanded: false, held: false })),
    };
  }

  // Anywhere, so a reader who collapsed everything need not find the running step
  if (key === "expand") {
    const current = model.steps.length - 1;

    return {
      ...model,
      minimal: false,
      steps: model.steps.map((item, index) =>
        index === current ? { ...item, expanded: true, held: true, offset: 0 } : item,
      ),
    };
  }

  if (key === "toggle" && step) {
    const opening = !step.expanded;

    return {
      ...model,
      // Opening the running step is the same instruction as pressing plus
      minimal: opening && model.cursor === model.steps.length - 1 ? false : model.minimal,
      steps: model.steps.map((item, index) =>
        index === model.cursor
          ? { ...item, expanded: opening, held: opening, offset: 0 }
          : item,
      ),
    };
  }

  return model;
}

function scrolled(model: Model, offset: number): Model {
  return {
    ...model,
    steps: model.steps.map((item, index) =>
      index === model.cursor ? { ...item, offset } : item,
    ),
  };
}

// After measuring: an escape is zero columns wide and would make a row wrap
const DIM = 90;
const CURSOR = 96;
const RUNNING = 93;
const DONE = 32;
const FAILED = 91;
const WARN = 33;

type Piece = { text: string; colour?: number };

function paint(text: string, colour: number | undefined, on: boolean) {
  if (!on || colour === undefined || text === "") return text;
  return `\u001b[${colour}m${text}\u001b[0m`;
}

function widthOf(pieces: Piece[]) {
  return pieces.reduce((total, piece) => total + piece.text.length, 0);
}

// Clips as one string would, then colours each surviving piece
function clipped(pieces: Piece[], room: number, on: boolean) {
  if (widthOf(pieces) <= room) {
    return pieces.map((piece) => paint(piece.text, piece.colour, on)).join("");
  }

  const kept: string[] = [];
  let left = room - 1;

  for (const piece of pieces) {
    if (left <= 0) break;

    const text = piece.text.slice(0, left);
    kept.push(paint(text, piece.colour, on));
    left -= text.length;
  }

  return `${kept.join("")}\u2026`;
}

const FOOTER = 2;
// What an open step that is not being read shows of itself
const GLANCE = 6;
// What the focused step keeps even when everything else wants the room
const FLOOR = 3;
// A list that only grows would crowd every log off the screen
const MESSAGES = 6;

// Every key inside eighty columns, since a wrapped footer costs a counted line
export const HELP =
  "\u2191\u2193 move \u00b7 enter open \u00b7 shift+\u2191 latest \u00b7 +/- all \u00b7 w wrap \u00b7 q quit";

// The frame's clock, so the view is a pure function of now
const SPINNER = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f";
const SPIN_MS = 80;

// Short enough to catch a wedge, long enough that a pause is not one
const QUIET_MS = 8000;

export function render(model: Model, colour = false): string[] {
  const body = Math.max(1, model.rows - FOOTER);
  const rows: string[] = [];
  const messages = model.messages.slice(-MESSAGES);
  const budget = Math.max(1, body - messages.length);

  // The list gives way rather than the log, which carries what titles do not
  const focused = model.steps[model.cursor];
  const floor = focused?.expanded ? Math.min(FLOOR, rowsOf(model, focused)) : 0;

  // More than fits, so the list scrolls and only the focused step keeps a log
  if (model.steps.length + floor > budget) {
    const room = Math.max(1, budget - floor);
    const start = Math.max(0, Math.min(model.cursor - room + 1, model.steps.length - room));

    for (const entry of ordered(model, messages)) {
      if (rows.length >= budget) break;

      if (entry.kind === "message") {
        rows.push(said(model, entry.message, colour));
        continue;
      }

      if (entry.index < start) continue;

      rows.push(title(model, entry.step, entry.index, colour));
      if (entry.index === model.cursor) rows.push(...logs(model, entry.step, floor, colour));
    }

    return finish(model, rows, body, colour);
  }

  const shown = share(model, budget - model.steps.length);

  for (const entry of ordered(model, messages)) {
    if (entry.kind === "message") {
      rows.push(said(model, entry.message, colour));
      continue;
    }

    rows.push(title(model, entry.step, entry.index, colour));
    rows.push(...logs(model, entry.step, shown.get(entry.index) ?? 0, colour));
  }

  for (const point of remaining(model)) {
    if (rows.length >= budget) break;
    rows.push(waiting(model, point, colour));
  }

  return finish(model, rows, body, colour);
}

// Drawn under what has started, so how much is left shows from the first frame
function remaining(model: Model) {
  const started = new Set(model.steps.map((step) => step.label));
  return model.planned.filter((point) => !started.has(point));
}

function waiting(model: Model, point: string, colour: boolean) {
  const head: Piece[] = [
    { text: " ".repeat(gutter(model).length), colour: DIM },
    { text: "   " },
    { text: "\u00b7", colour: DIM },
    { text: " " },
    { text: point, colour: DIM },
  ];

  return fit(model, head, "", colour);
}

type Row =
  | { kind: "step"; at: number; step: Step; index: number }
  | { kind: "message"; at: number; message: Message };

// In the order it was said, rather than printed after each step
function ordered(model: Model, messages: Message[]): Row[] {
  const steps: Row[] = model.steps.map((step, index) => ({
    kind: "step",
    at: step.started,
    step,
    index,
  }));

  const said: Row[] = messages.map((message) => ({
    kind: "message",
    at: message.at,
    message,
  }));

  // On a tie the message leads, being usually about what the step then did
  const rank = (row: Row) => (row.kind === "step" ? 0 : 1);

  return [...steps, ...said].sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

function said(model: Model, message: Message, colour: boolean) {
  return clipped(
    [
      { text: gutter(model, message.at), colour: DIM },
      { text: "   " },
      { text: message.text, colour: WARN },
    ],
    Math.max(24, model.columns),
    colour,
  );
}

// Served first, and every other open step gets a glance out of the rest
function share(model: Model, budget: number) {
  const shown = new Map<number, number>();
  const open = model.steps
    .map((step, index) => ({ step, index }))
    .filter((item) => item.step.expanded);

  const focused = open.find((item) => item.index === model.cursor);
  const others = open.filter((item) => item.index !== model.cursor);

  let left = Math.max(0, budget);

  if (focused) {
    // What the glances cost, not what they could: a silent step reserves nothing
    const glances = others.reduce(
      (total, item) => total + Math.min(GLANCE, rowsOf(model, item.step)),
      0,
    );

    const reserve = Math.min(glances, Math.max(0, left - FLOOR));
    const take = Math.min(left - reserve, rowsOf(model, focused.step));

    shown.set(focused.index, take);
    left -= take;
  }

  for (const item of others) {
    const take = Math.min(GLANCE, rowsOf(model, item.step), Math.max(0, left));

    shown.set(item.index, take);
    left -= take;
  }

  return shown;
}

// One row per line until they are wrapped, then as many as each needs
function rowsOf(model: Model, step: Step) {
  if (!model.wrapped) return step.lines.length;

  const room = Math.max(8, model.columns - RULE.length - indentOf(step).length);
  return step.lines.reduce((total, line) => total + wrapped(line, room).length, 0);
}

const RULE = "        \u2502 ";

// One row each, so a wrapped line cannot push the rows below it off
function logs(model: Model, step: Step, take: number, colour: boolean) {
  if (take <= 0) return [];

  const end = Math.max(1, step.lines.length - step.offset);
  const room = Math.max(8, model.columns - RULE.length - indentOf(step).length);
  const lines = step.lines.slice(Math.max(0, end - take), end);

  // Wrapped, one line is several rows, so this counts rows not lines
  const rows = lines.flatMap((line) =>
    model.wrapped ? wrapped(line, room) : [clip(line, room)],
  );

  return rows.slice(-take).map((row) => `${indentOf(step)}${paint(RULE, DIM, colour)}${row}`);
}

// Cut on width alone: breaking a path on a space hides half of it
function wrapped(line: string, room: number) {
  if (line.length <= room) return [line];

  const rows: string[] = [];
  for (let at = 0; at < line.length; at += room) rows.push(line.slice(at, at + room));

  return rows;
}

// The ellipsis is the point: a line that was cut has to say so
export function clip(text: string, room: number) {
  if (text.length <= room) return text;
  return `${text.slice(0, room - 1)}\u2026`;
}

// Padded above, so the frame fills upwards; the footer is cut like any row
function finish(model: Model, rows: string[], body: number, colour: boolean) {
  const filled = rows.slice(0, body);
  const blanks = Array.from({ length: Math.max(0, body - filled.length) }, () => "");
  const help = clip(HELP, Math.max(24, model.columns));

  return [...blanks, ...filled, "", paint(help, DIM, colour)];
}

function title(model: Model, step: Step, index: number, colour: boolean) {
  const selected = index === model.cursor;
  const running = step.state === "running";
  const arrow = step.expanded ? "\u25be" : "\u25b8";
  const glyph = step.state === "done" ? "\u2714" : step.state === "failed" ? "\u2718" : arrow;

  const said = step.note ? `: ${step.note}` : step.detail ? `  ${step.detail}` : "";

  const head: Piece[] = [
    // The clock as this row stood, stopped at the moment the step finished
    { text: gutter(model, step.ended), colour: DIM },
    { text: " " },
    // Under the step it runs inside, a level at a time
    { text: indentOf(step) },
    // Turning while the step works, including one that has gone quiet
    { text: running ? spinner(model.now) : " ", colour: RUNNING },
    { text: " " },
    { text: glyph, colour: stateColour(step) },
    { text: " " },
    { text: step.label, colour: labelColour(step, selected) },
    { text: said, colour: DIM },
    { text: quiet(model, step), colour: WARN },
  ];

  // Frozen at what it cost the moment it finished
  return fit(model, head, elapsed(step.ended ?? model.now, step.started), colour);
}

// Two columns for every step it sits inside
function indentOf(step: Step) {
  return "  ".repeat(step.depth);
}

function spinner(now: number) {
  return SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length] ?? " ";
}

// The difference between a build that is working and one that is wedged
function quiet(model: Model, step: Step) {
  if (step.state !== "running") return "";

  // A quiet child says so on its own row, not on every row above it
  const index = model.steps.indexOf(step);
  if (model.steps.some((other) => other.parent === index && other.state === "running")) return "";

  const since = model.now - (step.spoke ?? step.started);
  if (since < QUIET_MS) return "";

  return `  quiet ${elapsed(model.now, step.spoke ?? step.started)}`;
}

function stateColour(step: Step) {
  if (step.state === "done") return DONE;
  if (step.state === "failed") return FAILED;
  return RUNNING;
}

// A failure outranks everything, then the cursor, then what is running
function labelColour(step: Step, selected: boolean) {
  if (step.state === "failed") return FAILED;
  if (selected) return CURSOR;
  if (step.state === "running") return RUNNING;

  return undefined;
}

// Given a moment it stops there, so a finished row does not tick along
function gutter(model: Model, at?: number) {
  return elapsed(at ?? model.now, model.started, true);
}

export function elapsed(now: number, started: number, clock = false) {
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);

  if (clock) return `${pad(minutes)}:${pad(seconds % 60)}`;
  if (seconds < 60) return `${seconds}s`;

  return `${minutes}m${pad(seconds % 60)}s`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// The label gives way, keeping the one space that would otherwise overflow
function fit(model: Model, head: Piece[], timer: string, colour: boolean) {
  const width = Math.max(24, model.columns);
  const room = width - timer.length - 1;
  const shown = Math.min(widthOf(head), room - 1);

  return (
    `${clipped(head, room - 1, colour)}` +
    `${" ".repeat(Math.max(1, room - shown))} ${paint(timer, DIM, colour)}`
  );
}
