import type { Task } from "../log.js";

import { elapsed as took } from "./screen.js";
import { createViewer, type Viewer } from "./viewer.js";

// What a deploy prints, rather than the engine's own build graph trace

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

// A pipe, a CI log or --full gets one line per event, having nothing to redraw
export function createLog(options: LogOptions = {}): Viewer {
  if (viewable(process.stdout, process.stdin, options)) {
    return createViewer(process.stdout, process.stdin, { onQuit: options.onQuit });
  }

  // --full prints a step's output; --verbose adds the host commands
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

    // Both streams share one terminal, so the block comes down for either
    if (stream === process.stdout) return live.write(line);

    live.write("");
    stream.write(line);
  };

  const info = (message: string) => write(process.stdout, message);

  // Indented under the step it runs inside, the same as the view draws it
  const step = (label: string, depth = 0): Task => {
    const pad = "  ".repeat(depth);
    write(process.stdout, `${pad}${label}`);
    const started = Date.now();

    let current: { text: string; at: number } | undefined;

    // A sub-step lands here with what it cost, keeping the live view short
    const settle = () => {
      if (!current) return;

      write(process.stdout, `${pad}  ${label}: ${current.text} (${since(current.at)})`);
      current = undefined;
    };

    const trace = (message: string) => {
      settle();
      current = { text: message, at: Date.now() };
      write(process.stdout, `${pad}  ${label}: ${message}`);
    };

    return {
      detail: trace,
      // In full, never clipped: this is the view for reading what a build said
      line: (message: string) => {
        if (lines) write(process.stdout, `${pad}  ${label} | ${message}`);
      },
      done: (message?: string) => {
        settle();
        const suffix = message ? `: ${message}` : "";
        write(process.stdout, `${pad}${label}${suffix} (${since(started)})`, DONE);
      },
      fail: (message: string) => {
        settle();
        write(process.stderr, `${pad}${message} (${since(started)})`, FAIL);
      },
      step: (child: string) => step(child, depth + 1),
    };
  };

  return Object.assign(info, {
    warn: (message: string) => write(process.stdout, message, WARN),
    // Failures go to stderr, so a piped log carries the progress alone
    fail: (message: string) => write(process.stderr, message, FAIL),
    done: (message: string) => write(process.stdout, message, DONE),
    step,
  });
}

function paint(text: string, colour: number) {
  return `\u001b[${colour}m${text}\u001b[0m`;
}

// A file or pipe takes the text plain, and NO_COLOR is a standing instruction
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

// The chain matters because a step wraps the command it ran
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

export function causes(error: Error) {
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
