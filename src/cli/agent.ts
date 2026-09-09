import { execFileSync } from "node:child_process";

import { environmentOf } from "../config.js";
import type { Deployment } from "../types.js";

// Cloning private repositories and reaching the deploy host both go through
// the agent, so a deploy without one fails halfway rather than at the start

// Asked before one is demanded. A runner has no keys and no way to be prompted
// for one, and a deployment that reaches no other machine and clones nothing
// has no use for an agent: insisting on one there is a green run turned red
export function needsAgent(config: Deployment, environment: string) {
  if (environmentOf(config, environment)?.host?.bastion) return true;

  return config.apps.some((app) => app.repo !== undefined && overSsh(app.repo));
}

// A clone URL that names a transport of its own carries its own credentials.
// Anything else is the scp-like form, which is ssh and wants a key
function overSsh(repo: string) {
  return !/^(https?|git|file):\/\//.test(repo);
}

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

  return socket;
}
