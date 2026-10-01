export type Result = { code: number; stdout: string; stderr: string };

export type OnLine = (line: string) => void;

export type Host = {
  sh(command: string, onLine?: OnLine): Promise<Result>;
  write(name: string, contents: string): Promise<string>;
  // directory is scratch, dropped when the deploy closes; cache survives it
  readonly directory: string;
  readonly cache: string;
  pipe(local: string, remote: string, onLine?: OnLine): Promise<Result>;
  stop(signal: "TERM" | "KILL"): Promise<number>;
  // Runs even once a stop has been asked for, so a revert can still swap back
  final(command: string): Promise<Result>;
  close?(): Promise<void>;
};

export function finalHost(host: Host): Host {
  return { ...host, sh: async (command) => await host.final(command) };
}

// Enough lines that a failure's error still fits, for a build that prints a lot
const TAIL = 200;

export function tail(lines: string[]) {
  return lines.slice(-TAIL).join("\n");
}

// Splits a chunked stream into lines, holding the partial last one back
export function lineReader(onLine: OnLine) {
  let rest = "";

  return {
    push(chunk: string) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    },
    flush() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}
