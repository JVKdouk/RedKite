// The deploy as a list of collapsibles. A step is a title and the lines it
// produced; the one running is open, the ones finished are shut, and the person
// watching moves between them. The model and the renderer are pure, so what the
// terminal shows is asserted on rather than driven.

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
  expanded: boolean;
  // Opened by hand, so finishing does not shut it under the reader
  held: boolean;
  // Lines between the bottom of the log and the bottom of the window
  offset: number;
};

export type Model = {
  steps: Step[];
  messages: string[];
  cursor: number;
  // The cursor follows the newest step until the reader moves it
  following: boolean;
  // Nothing opens on its own, including the step that is running
  minimal: boolean;
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
  | "quit";

export function emptyModel(rows: number, columns: number, now: number): Model {
  return {
    steps: [],
    messages: [],
    cursor: 0,
    following: true,
    minimal: false,
    rows,
    columns,
    started: now,
    now,
  };
}

const ESCAPE = "\u001b";
const INTERRUPT = "\u0003";

// A terminal delivers whatever arrived since the last read, so two arrow keys
// pressed quickly land as one chunk. Reading only the whole chunk drops both
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
  if (data === "q" || data === INTERRUPT) return "quit";

  return undefined;
}

// Moving up runs out of log before it runs out of steps: the window climbs to
// the top of what this step printed, and only then does the cursor leave it
export function apply(model: Model, key: Key): Model {
  const step = model.steps[model.cursor];

  if (key === "latest") {
    return { ...model, cursor: Math.max(0, model.steps.length - 1), following: true };
  }

  if (key === "first") return { ...model, cursor: 0, following: false };

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

  // Anywhere, so a reader who collapsed everything does not have to find the
  // running step before opening it again
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

// Colours are put on after every width is measured, because an escape is zero
// columns wide and a row measured with one in it is a row that wraps
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

// Clips the row as one string would clip, then hands each surviving piece its
// colour. The ellipsis belongs to whichever piece was cut
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
// A step that is open but not the one being read shows this much of itself
const GLANCE = 6;
// What the focused step keeps even when everything else wants the room
const FLOOR = 3;
// How many of them the frame carries. Every message is written out again when
// the view closes, and a list that only grows crowds every log off the screen
const MESSAGES = 6;

export const HELP =
  "\u2191\u2193 move \u00b7 enter open \u00b7 shift+\u2191 latest \u00b7 + open \u00b7 - collapse all \u00b7 q quit";

export function render(model: Model, colour = false): string[] {
  const body = Math.max(1, model.rows - FOOTER);
  const rows: string[] = [];
  const messages = model.messages.slice(-MESSAGES);

  // More titles than the terminal has lines, so nothing can be open and the
  // list itself is what scrolls
  if (model.steps.length + messages.length > body) {
    const start = Math.max(0, Math.min(model.cursor, model.steps.length - body));

    for (const [index, step] of model.steps.entries()) {
      if (index >= start && rows.length < body) {
        rows.push(title(model, step, index, colour));
      }
    }

    return finish(rows, body, colour);
  }

  const shown = share(model, body - model.steps.length - messages.length);

  for (const [index, step] of model.steps.entries()) {
    rows.push(title(model, step, index, colour));
    rows.push(...logs(model, step, shown.get(index) ?? 0, colour));
  }

  for (const message of messages) {
    rows.push(
      clipped(
        [
          { text: gutter(model), colour: DIM },
          { text: "   " },
          { text: message, colour: WARN },
        ],
        Math.max(24, model.columns),
        colour,
      ),
    );
  }

  return finish(rows, body, colour);
}

// The focused step is the one being read, so it is served first and every other
// open one gets a glance out of what it did not need
function share(model: Model, budget: number) {
  const shown = new Map<number, number>();
  const open = model.steps
    .map((step, index) => ({ step, index }))
    .filter((item) => item.step.expanded);

  const focused = open.find((item) => item.index === model.cursor);
  const others = open.filter((item) => item.index !== model.cursor);

  let left = Math.max(0, budget);

  if (focused) {
    // What the glances would actually cost, not what they could: a step that
    // printed nothing reserves nothing, and served last the focused step used
    // to be left with whatever the others happened not to want
    const glances = others.reduce(
      (total, item) => total + Math.min(GLANCE, item.step.lines.length),
      0,
    );

    const reserve = Math.min(glances, Math.max(0, left - FLOOR));
    const take = Math.min(left - reserve, focused.step.lines.length);

    shown.set(focused.index, take);
    left -= take;
  }

  for (const item of others) {
    const take = Math.min(GLANCE, item.step.lines.length, Math.max(0, left));

    shown.set(item.index, take);
    left -= take;
  }

  return shown;
}

const RULE = "        \u2502 ";

// The newest lines, less whatever the reader has scrolled back past. One line
// each: a wrapped line would push the rows below it off a frame sized in rows
function logs(model: Model, step: Step, take: number, colour: boolean) {
  if (take <= 0) return [];

  const end = Math.max(1, step.lines.length - step.offset);
  const room = Math.max(8, model.columns - RULE.length);

  return step.lines
    .slice(Math.max(0, end - take), end)
    .map((line) => `${paint(RULE, DIM, colour)}${clip(line, room)}`);
}

// The ellipsis is the whole point: a line that was cut has to say so
export function clip(text: string, room: number) {
  if (text.length <= room) return text;
  return `${text.slice(0, room - 1)}\u2026`;
}

function finish(rows: string[], body: number, colour: boolean) {
  const filled = rows.slice(0, body);
  while (filled.length < body) filled.push("");

  return [...filled, "", paint(HELP, DIM, colour)];
}

function title(model: Model, step: Step, index: number, colour: boolean) {
  const selected = index === model.cursor;
  const caret = selected ? "\u276f" : " ";
  const arrow = step.expanded ? "\u25be" : "\u25b8";
  const glyph = step.state === "done" ? "\u2714" : step.state === "failed" ? "\u2718" : arrow;

  const said = step.note ? `: ${step.note}` : step.detail ? `  ${step.detail}` : "";

  const head: Piece[] = [
    { text: gutter(model), colour: DIM },
    { text: " " },
    { text: caret, colour: selected ? CURSOR : undefined },
    { text: " " },
    { text: glyph, colour: stateColour(step) },
    { text: " " },
    { text: step.label, colour: labelColour(step, selected) },
    { text: said, colour: DIM },
  ];

  // Frozen at what it cost the moment it finished, still counting until then
  return fit(model, head, elapsed(step.ended ?? model.now, step.started), colour);
}

function stateColour(step: Step) {
  if (step.state === "done") return DONE;
  if (step.state === "failed") return FAILED;
  return RUNNING;
}

// A failure outranks everything: it is the row the reader is looking for. Then
// where the cursor is, then what is still running
function labelColour(step: Step, selected: boolean) {
  if (step.state === "failed") return FAILED;
  if (selected) return CURSOR;
  if (step.state === "running") return RUNNING;

  return undefined;
}

// The stamp is the whole run, and it keeps counting for every row a step adds
function gutter(model: Model) {
  return `[${elapsed(model.now, model.started, true)}]`;
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

// The timer is pushed to the right edge, and the label is what gives way when
// there is not room for both. One space between them always, which is a row
// wider than the terminal when the label is allowed to fill the gap
function fit(model: Model, head: Piece[], timer: string, colour: boolean) {
  const width = Math.max(24, model.columns);
  const room = width - timer.length - 1;
  const shown = Math.min(widthOf(head), room - 1);

  return (
    `${clipped(head, room - 1, colour)}` +
    `${" ".repeat(Math.max(1, room - shown))} ${paint(timer, DIM, colour)}`
  );
}
