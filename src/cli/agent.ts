import { execFileSync } from "node:child_process";

import { environmentOf } from "../config.js";
import type { Deployment } from "../types.js";


// Only where a key is actually needed; a runner has no way to be prompted
export function needsAgent(config: Deployment, environment: string) {
  if (environmentOf(config, environment)?.host?.bastion) return true;

  return config.apps.some((app) => app.repo !== undefined && overSsh(app.repo));
}

// Anything not naming its own transport is the scp-like form, which wants a key
function overSsh(repo: string) {
  return !/^(https?|git|file):\/\//.test(repo);
}

export const AGENT_STARTED = "no SSH agent was running, so one was started";

// Runs before the view opens, since ssh-add may ask for a passphrase
export function requireAgent() {
  const existing = process.env["SSH_AUTH_SOCK"];
  if (existing) return { socket: existing, started: false };

  const output = execFileSync("ssh-agent", ["-s"], { encoding: "utf8" });
  const socket = output.match(/SSH_AUTH_SOCK=([^;]+);/)?.[1];
  const pid = output.match(/SSH_AGENT_PID=([^;]+);/)?.[1];

  if (!socket) throw new Error("ssh-agent did not report a socket");

  process.env["SSH_AUTH_SOCK"] = socket;
  if (pid) process.env["SSH_AGENT_PID"] = pid;

  // Inherits stdio so a passphrase prompt reaches the person running this
  try {
    execFileSync("ssh-add", [], { stdio: "inherit" });
  } catch {
    throw new Error(
      "ssh-add found no key to load. This deployment reaches another machine " +
        "or clones over ssh, so it needs an agent holding a key that can. On a " +
        "runner, set one up before this step and leave SSH_AUTH_SOCK in the " +
        "environment",
    );
  }

  return { socket, started: true };
}
