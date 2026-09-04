import type { Task } from "../log.js";

import { elapsed as took } from "./screen.js";
import { createViewer, type Viewer } from "./viewer.js";

// What a deploy prints. The engine's own trace is a build graph with span ids
// and manifest resolution in it, which answers a question nobody deploying has.

const STAMP = 90;
const WARN = 33;
const FAIL = 31;
const DONE = 32;

const started = Date.now();

export type LogOptions = {
  verbose?: boolean;
  full?: boolean;
  onQuit?: () => void;
};

// A terminal gets the step viewer. Anything else, a pipe, a CI log or --full,
// gets one line per event, because there is nothing there to redraw
export function createLog(options: LogOptions = {}): Viewer {
  if (viewable(process.stdout, process.stdin, options)) {
    return createViewer(process.stdout, process.stdin, { onQuit: options.onQuit });
  }

  // --full is the reason to print a step's own output without asking for the
  // host commands beside it, which is what --verbose adds
  return Object.assign(plainLog(options.verbose === true || options.full === true), {
    close: () => {},
  });
}

function viewable(
  stream: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  options: LogOptions,
) {
  if (options.full || process.env["REDKITE_PLAIN"]) return false;
  return stream.isTTY === true && input.isTTY === true;
}

function plainLog(lines: boolean) {
  const live = { write: (line: string) => process.stdout.write(line) };

  const write = (stream: NodeJS.WriteStream, message: string, colour?: number) => {
    const painted = colours(stream);
    const stamp = painted ? paint(elapsed(), STAMP) : elapsed();
    const body = painted && colour ? paint(message, colour) : message;
    const line = `${stamp} ${body}\n`;

    // Both streams share one terminal, so the block has to come down for a
    // failure on stderr just as it does for progress on stdout
    if (stream === process.stdout) return live.write(line);

    live.write("");
    stream.write(line);
  };

  const info = (message: string) => write(process.stdout, message);

  const step = (label: string): Task => {
    write(process.stdout, label);
    const started = Date.now();

    let current: { text: string; at: number } | undefined;

    // A sub-step leaves the block when the next one starts, and lands here with
    // what it cost. The live view stays short without the run losing its record
    const settle = () => {
      if (!current) return;

      write(process.stdout, `  ${label}: ${current.text} (${since(current.at)})`);
      current = undefined;
    };

    const trace = (message: string) => {
      settle();
      current = { text: message, at: Date.now() };
      write(process.stdout, `  ${label}: ${message}`);
    };

    return {
      detail: trace,
      // In full, never clipped: this is the view for reading what a build said
      line: (message: string) => {
        if (lines) write(process.stdout, `  ${label} | ${message}`);
      },
      done: (message?: string) => {
        settle();
        const suffix = message ? `: ${message}` : "";
        write(process.stdout, `${label}${suffix} (${since(started)})`, DONE);
      },
      fail: (message: string) => {
        settle();
        write(process.stderr, `${message} (${since(started)})`, FAIL);
      },
    };
  };

  return Object.assign(info, {
    warn: (message: string) => write(process.stdout, message, WARN),
    // Failures go to stderr, so a piped log still carries the progress alone
    fail: (message: string) => write(process.stderr, message, FAIL),
    done: (message: string) => write(process.stdout, message, DONE),
    step,
  });
}

function paint(text: string, colour: number) {
  return `\u001b[${colour}m${text}\u001b[0m`;
}

// A file or a pipe takes the text without the escapes, and NO_COLOR is a
// standing instruction rather than a preference to re-ask about
function colours(stream: NodeJS.WriteStream) {
  if (process.env["NO_COLOR"]) return false;
  return stream.isTTY === true;
}

function elapsed() {
  return `[${took(Date.now(), started, true)}]`;
}

function since(at: number) {
  return took(Date.now(), at);
}

const TAIL = 20;

// A failure carries the tail of whatever the command wrote, and a build writes
// a lot. The chain matters because a step wraps the command it ran
export function describeFailure(error: unknown) {
  if (!(error instanceof Error)) return String(error);

  // A wrapper that already quotes what it wrapped must not say it twice
  const chain = causes(error).map((link) => link.message);
  const said = chain.filter(
    (message, index) => !chain.slice(0, index).some((earlier) => earlier.includes(message)),
  );

  return tail(said.join("\n"));
}

const DEPTH = 8;

function causes(error: Error) {
  const chain: Error[] = [];
  let current: unknown = error;

  while (current instanceof Error && chain.length < DEPTH) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

function tail(body: string) {
  const lines = body.split("\n");
  if (lines.length <= TAIL) return body;

  return [`... ${lines.length - TAIL} earlier lines`, ...lines.slice(-TAIL)].join(
    "\n",
  );
}
