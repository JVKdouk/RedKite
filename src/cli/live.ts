// A block of lines at the bottom of the terminal, one per step still running,
// redrawn on a timer. Builds run concurrently, so a single spinner could only
// name one of them, and the question being asked is which one is slow.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;
const BRANCH = "▸";

// A step and the sub-step running under it. The sub-step is the command that
// is actually executing, so the spinner belongs to it once there is one
type Running = {
  label: string;
  started: number;
  detail?: { text: string; started: number };
};

export class Live {
  private readonly running = new Map<number, Running>();
  private timer?: NodeJS.Timeout;
  private drawn = 0;
  private frame = 0;
  private next = 0;

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly enabled: boolean,
    // The same stamp finished lines carry, so a running step and a finished one
    // sit in one column rather than reading as two different kinds of output
    private readonly prefix: () => string,
  ) {}

  start(label: string) {
    const id = (this.next += 1);
    this.running.set(id, { label, started: Date.now() });

    this.tick();
    return id;
  }

  update(id: number, detail: string) {
    const running = this.running.get(id);
    if (!running) return;

    running.detail = { text: detail, started: Date.now() };
    this.draw();
  }

  stop(id: number) {
    this.running.delete(id);
    if (this.running.size === 0) this.rest();

    this.draw();
  }

  elapsed(id: number) {
    const running = this.running.get(id);
    return running ? since(running.started) : "";
  }

  // Everything printed while a block is on screen has to erase it first, or the
  // line lands inside it and the next redraw overwrites the wrong rows
  write(line: string) {
    this.erase();
    this.stream.write(line);
    this.draw();
  }

  private draw() {
    if (!this.enabled) return;

    this.erase();
    if (this.running.size === 0) return;

    const rows = [...this.running.values()].flatMap((running) => this.rows(running));
    this.stream.write(`${rows.join("\n")}\n`);
    this.drawn = rows.length;
  }

  private erase() {
    if (!this.enabled || this.drawn === 0) return;

    this.stream.write(`\u001b[${this.drawn}A\u001b[0J`);
    this.drawn = 0;
  }

  private rows(running: Running) {
    const spinner = FRAMES[this.frame % FRAMES.length] ?? "";
    const { detail } = running;

    // The marker moves down to the sub-step once there is one, because that is
    // the thing actually running. Two spinners on one step is just noise
    const head = this.fit(
      `${this.prefix()} ${detail ? BRANCH : spinner} ${running.label}  ${since(running.started)}`,
    );

    if (!detail) return [head];

    return [
      head,
      this.fit(
        `${this.prefix()}   ${spinner} ${detail.text}  ${since(detail.started)}`,
      ),
    ];
  }

  private fit(line: string) {
    const width = this.stream.columns ?? 0;
    if (width === 0 || line.length <= width) return line;

    return `${line.slice(0, width - 1)}…`;
  }

  private tick() {
    if (!this.enabled || this.timer) return this.draw();

    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, TICK_MS);

    // Nothing here should hold the process open once the deploy is finished
    this.timer.unref();
    this.stream.write("\u001b[?25l");
    process.once("exit", () => this.stream.write("\u001b[?25h"));
  }

  private rest() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write("\u001b[?25h");
  }
}

export function since(started: number) {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (seconds < 60) return `${seconds}s`;

  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
