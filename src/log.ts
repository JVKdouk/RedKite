// The shape progress is reported through, for a deploy driven without a terminal.

export type Task = {
  // Replaces whatever the step said before; line() appends instead
  detail(message: string): void;
  line(message: string): void;
  done(message?: string): void;
  fail(message: string): void;
  // Work inside this one, drawn under it
  step(label: string): Task;
};

export type Log = ((message: string) => void) & {
  // Every point the run will walk, said once before the first of them starts
  plan?(points: string[]): void;
  warn(message: string): void;
  fail(message: string): void;
  done(message: string): void;
  step(label: string): Task;
};

const NOTHING: Task = {
  detail: () => {},
  line: () => {},
  done: () => {},
  fail: () => {},
  step: () => NOTHING,
};

export const silent: Log = Object.assign(() => {}, {
  plan: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
  step: () => NOTHING,
});
