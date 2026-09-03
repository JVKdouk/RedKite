import type { Host, Result } from "../src/index.js";

// The commit every fake checkout resolves to. Short enough at the front to
// read in an assertion, long enough that the source step accepts it
export const RELEASE = `abc1234${"0".repeat(33)}`;

// A host that records every command and answers from a set of known containers,
// so the orchestration is asserted on rather than trusted.
export function fakeHost(options: { existing?: string[] } = {}) {
  const commands: string[] = [];
  const containers = new Set(options.existing ?? []);
  const images = new Set<string>();
  const networks = new Set<string>();
  const running = new Set(options.existing ?? []);
  const files = new Map<string, string>();
  const health = new Map<string, string>();

  const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });

  // Every command is a shell command on the host, and most of them happen to
  // start with docker. The prefix is dropped here so an assertion reads as the
  // docker operation it is about
  const docker = (command: string): Result => {
    const words = command.split(" ");

    // The one snapshot the deploy takes, in place of an inspect per object
    if (command.startsWith("ps -a")) {
      const rows = [...containers].map(
        (name) => `${name}\t${running.has(name) ? "running" : "exited"}`,
      );

      const tagged = [...images].map((name) =>
        name.includes(":") ? name : `${name}:latest`,
      );

      return ok([rows.join("\n"), tagged.join("\n"), [...networks].join("\n")].join("\n---\n"));
    }

    if (command.startsWith("network create")) {
      networks.add(words[2]!);
      return ok();
    }
    if (command.startsWith("network disconnect") || command.startsWith("network connect")) {
      return ok();
    }
    if (command.startsWith("build ")) {
      for (const [index, word] of words.entries()) {
        if (word === "-t") images.add(words[index + 1]!);
      }
      return ok();
    }
    if (command.startsWith("tag ")) {
      images.add(words[2]!);
      images.add(words[3]!);
      return ok();
    }
    if (command.startsWith("image remove")) {
      images.delete(words.at(-1)!);
      return ok();
    }
    if (command.startsWith("container create")) {
      containers.add(words[3]!);
      return ok();
    }
    if (command.startsWith("container start")) {
      running.add(words[2]!);
      return ok();
    }
    if (command.startsWith("container stop")) {
      running.delete(words[2]!);
      return ok();
    }
    if (command.startsWith("container rename")) {
      containers.delete(words[2]!);
      containers.add(words[3]!);
      if (running.delete(words[2]!)) running.add(words[3]!);
      return ok();
    }
    if (command.startsWith("container rm")) {
      containers.delete(words[2]!);
      return ok();
    }
    if (command.startsWith("exec ")) {
      return ok(health.get(words[1]!) ?? "{}");
    }

    return ok();
  };

  const sh: Host["sh"] = async (command) => {
    if (!command.startsWith("docker ")) {
      commands.push(command);

      // The checkout is several git commands in one script, and the only thing
      // anything reads back from it is the commit the branch resolved to
      return ok(command.includes("rev-parse") ? RELEASE : "");
    }

    const rest = command.slice("docker ".length);
    commands.push(rest);
    return docker(rest);
  };

  const write: Host["write"] = async (name, contents) => {
    files.set(name, contents);
    return `/tmp/redkite/${name}`;
  };

  return {
    host: { sh, write, directory: "/tmp/redkite", cache: "/cache/redkite" } satisfies Host,
    commands,
    files,
    containers,
    running,
    images,
    // Sets what a container's health endpoint answers
    respond: (container: string, body: string) => health.set(container, body),
  };
}
