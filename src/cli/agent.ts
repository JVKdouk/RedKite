import { execFileSync } from "node:child_process";

import type { Log } from "../log.js";

// Cloning private repositories and opening the tunnel both go through the
// agent, so a deploy without one fails halfway rather than at the start

export function requireAgent(log: Log) {
  const existing = process.env["SSH_AUTH_SOCK"];
  if (existing) return existing;

  log.warn("No SSH agent, starting one");

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
