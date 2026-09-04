import { execFileSync } from "node:child_process";

// Cloning private repositories and opening the tunnel both go through the
// agent, so a deploy without one fails halfway rather than at the start

// A plain writer rather than a Log, because this runs before the view opens:
// ssh-add may ask for a passphrase, and it cannot ask through a screen
// something else is drawing
export function requireAgent(warn: (message: string) => void) {
  const existing = process.env["SSH_AUTH_SOCK"];
  if (existing) return existing;

  warn("No SSH agent, starting one");

  const output = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
  const socket = output.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1];
  const pid = output.match(/SSH_AGENT_PID=([^;]+);/)?.[1];

  if (!socket) throw new Error("ssh-agent did not report a socket");

  process.env["SSH_AUTH_SOCK"] = socket;
  if (pid) process.env["SSH_AGENT_PID"] = pid;

  // Inherits stdio so a passphrase prompt reaches the person running this
  execFileSync("ssh-add", [], { stdio: "inherit" });

  return socket;
}
