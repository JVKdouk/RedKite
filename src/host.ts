// The machine the containers run on. Every command a deploy issues goes through
// this, so the rest of the library is exercised against a recorder rather than
// against a host. Two implementations: one over ssh, one on this machine.

export type Result = { code: number; stdout: string; stderr: string };

// Called per line while a command runs, for the ones long enough that the person
// watching needs to know what they are waiting for
export type OnLine = (line: string) => void;

export type Host = {
  // A shell command, run where the containers are. The shell is what lets a
  // caller redirect, chain, and quote, which several of them do
  sh(command: string, onLine?: OnLine): Promise<Result>;
  // Writes contents to a file there, answering with the path it landed at.
  // Parent directories are created, so a name may contain slashes
  write(name: string, contents: string): Promise<string>;
  // Scratch space this host hands out, removed when the deploy closes
  readonly directory: string;
  // Survives a deploy: the git mirrors and the checkouts built from them
  readonly cache: string;
  // Streams one command's output into another's input, the near side local and
  // the far side here. Shipping an image is the only caller
  pipe(local: string, remote: string, onLine?: OnLine): Promise<Result>;
  // Signals everything this host started and answers with how many are still
  // running. Zero is the only answer that means nothing was left behind
  stop(signal: "TERM" | "KILL"): Promise<number>;
  close?(): Promise<void>;
};

// A streamed command keeps this many lines, so a build that prints tens of
// megabytes still fits in the error a failure reports
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
