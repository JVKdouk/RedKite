// The shape progress is reported through. The library only knows this much, so
// a deploy driven from somewhere without a terminal supplies its own.

// Work that is still running. Announced when it starts, because the thing worth
// knowing during a four minute build is which step is the four minutes
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
  warn: () => {},
  fail: () => {},
  done: () => {},
  step: () => NOTHING,
});
