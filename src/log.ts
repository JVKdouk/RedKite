// The shape progress is reported through. The library only knows this much, so
// a deploy driven from somewhere without a terminal supplies its own.

// A short label a terminal can draw as a tag, such as the host a repository
// lives on. Marked with private-use characters, which nothing a command prints
// uses, so a log finds one without guessing at brackets somebody typed
const TAG_OPEN = "\uE000";
const TAG_CLOSE = "\uE001";

export const TAGS = /\uE000([^\uE000\uE001]*)\uE001/g;

export function tag(label: string) {
  return `${TAG_OPEN}${label}${TAG_CLOSE}`;
}

// For a log that has no way to draw one: a file, a pipe, a CI log
export function untagged(text: string) {
  return text.replaceAll(TAGS, "[$1]");
}

// Work that is still running. Announced when it starts, because the thing worth
// knowing during a four minute build is which step is the four minutes. What it
// says may carry a tag, which a log that draws plain text passes through untagged
export type Task = {
  // What the step is doing right now, replacing whatever it said before
  detail(message: string): void;
  // A line the step produced, kept under it. detail replaces, this appends,
  // and a build's own output is the reason there are two
  line(message: string): void;
  done(message?: string): void;
  fail(message: string): void;
};

export type Log = ((message: string) => void) & {
  // Every point the run will walk, said once before the first of them starts.
  // A view that knows the whole list can show what has not begun
  plan?(points: string[]): void;
  // Something the run survived, but that the person should know happened
  warn(message: string): void;
  // The reason a deploy is about to stop, or did
  fail(message: string): void;
  // A step reaching the state it was waiting for
  done(message: string): void;
  step(label: string): Task;
};

const NOTHING: Task = {
  detail: () => {},
  line: () => {},
  done: () => {},
  fail: () => {},
};

export const silent: Log = Object.assign(() => {}, {
  plan: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
  step: () => NOTHING,
});
