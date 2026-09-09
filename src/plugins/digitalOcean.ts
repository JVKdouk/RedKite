import type { Step } from "../pipeline.js";
import { definePlugin, type Plugin } from "../plugin.js";

import { slug, snapshotName, tokenFrom, type SnapshotPoint } from "./snapshot.js";

// A snapshot of the disk a database sits on, taken before anything migrates it.
//
// DigitalOcean's managed databases have no endpoint that takes one on demand:
// their backups are automatic and the API only lists them. So what this
// snapshots is the block storage volume redkite's own postgres service keeps
// its data on, or the droplet when the database is the whole machine. A volume
// snapshot of a running Postgres is crash consistent rather than clean, which
// Postgres is built to survive: it replays the log on the way back up.

const API = "https://api.digitalocean.com/v2";

// Injected for the same reason the ssh runner is: what this builds is asserted
// on rather than trusted
export type Request = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type DigitalOceanSnapshotOptions = {
  // The block storage volume the data lives on, by id
  volume?: string;
  // Or the droplet, by id, for a database that is the whole machine
  droplet?: number;
  // Goes in front of the snapshot's name, which carries the environment and
  // the minute after it
  name?: string;
  // Environment variable the API token is read from, never the token itself:
  // a config is committed and a token is not
  tokenFrom?: string;
  request?: Request;
};

const TOKEN = "DIGITALOCEAN_TOKEN";

export function digitalOceanSnapshot(options: DigitalOceanSnapshotOptions): Plugin {
  assertOneTarget(options);

  return definePlugin({
    name: `digitalocean-snapshot-${slug(options.volume ?? String(options.droplet ?? ""))}`,
    steps: [snapshotStep(options)],
  });
}

function snapshotStep(options: DigitalOceanSnapshotOptions): Step<SnapshotPoint> {
  const target = options.volume ?? String(options.droplet ?? "");
  const send = options.request ?? ((url, init) => fetch(url, init));
  const variable = options.tokenFrom ?? TOKEN;

  return {
    point: `swap:before:snapshot-${slug(target)}`,
    check: (plan) => tokenFrom(variable, plan),

    run: async (input, context) => {
      const name = snapshotName(options.name ?? target, context.environment, new Date());
      context.task.detail(`snapshotting ${target} as ${name}`);

      const token = tokenFrom(variable, {
        config: context.config,
        environment: context.environment,
      });

      const answer = await send(urlFor(options), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyFor(options, name)),
      });

      if (!answer.ok) {
        throw new Error(
          `DigitalOcean refused the snapshot of ${target} (${answer.status}): ${await answer.text()}`,
        );
      }

      return input;
    },
  };
}

function urlFor(options: DigitalOceanSnapshotOptions) {
  if (options.volume) return `${API}/volumes/${options.volume}/snapshots`;
  return `${API}/droplets/${options.droplet}/actions`;
}

// A volume takes a snapshot, a droplet is asked to perform one. Two endpoints
// with two shapes, which is why the target is not one field
function bodyFor(options: DigitalOceanSnapshotOptions, name: string) {
  if (options.volume) return { name };
  return { type: "snapshot", name };
}

// Checked where the plugin is written rather than where it runs, so the config
// fails to load. The token cannot be: a plan reads the config without one
function assertOneTarget(options: DigitalOceanSnapshotOptions) {
  if (options.volume && options.droplet !== undefined) {
    throw new Error(
      "digitalOceanSnapshot names both a volume and a droplet, and they are different disks",
    );
  }

  if (!options.volume && options.droplet === undefined) {
    throw new Error("digitalOceanSnapshot names no volume or droplet to snapshot");
  }
}
