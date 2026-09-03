import type { Log, Task } from "../log.js";

import { Live, since } from "./live.js";

// What a deploy prints. The engine's own trace is a build graph with span ids
// and manifest resolution in it, which answers a question nobody deploying has.

const STAMP = 90;
const WARN = 33;
const FAIL = 31;
const DONE = 32;

const started = Date.now();

export function createLog(): Log {
  const interactive = colours(process.stdout);
  const live = new Live(process.stdout, interactive, () =>
    interactive ? paint(elapsed(), STAMP) : elapsed(),
  );

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
    // The live row is the announcement. Printing one as well would leave the
    // same step on screen twice, once frozen and once ticking
    if (!interactive) write(process.stdout, label);

    const id = live.start(label);
    const started = Date.now();

    let current: { text: string; at: number } | undefined;

    // A sub-step leaves the block when the next one starts, and lands here with
    // what it cost. The live view stays short without the run losing its record
    const settle = () => {
      if (!current) return;

      write(process.stdout, `  ${label}: ${current.text} (${since(current.at)})`);
      current = undefined;
    };

    // Without a block to redraw, a sub-step is only visible if it is printed
    const trace = (message: string) => {
      if (!interactive) return write(process.stdout, `  ${label}: ${message}`);

      settle();
      current = { text: message, at: Date.now() };
      live.update(id, message);
    };

    return {
      detail: trace,
      done: (message?: string) => {
        settle();
        live.stop(id);
        const suffix = message ? `: ${message}` : "";
        write(process.stdout, `${label}${suffix} (${since(started)})`, DONE);
      },
      fail: (message: string) => {
        settle();
        live.stop(id);
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
  const seconds = Math.floor((Date.now() - started) / 1000);
  return `[${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}]`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
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
