import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Step } from "../pipeline.js";
import { definePlugin, type Plugin } from "../plugin.js";

import { slug, snapshotName, type SnapshotPoint } from "./snapshot.js";

// A snapshot of a managed Postgres or MySQL, taken before anything migrates it.
// Through the AWS CLI rather than the REST API: signing a request by hand is a
// page of crypto that nothing here could check, and every runner already has
// the CLI with the credentials the job was given.

const run = promisify(execFile);

// Injected so the argv this builds is asserted on rather than trusted
export type Aws = (args: string[]) => Promise<{ stdout: string }>;

export type RdsSnapshotOptions = {
  // The instance to snapshot, or the cluster for Aurora. One of them
  instance?: string;
  cluster?: string;
  // Goes in front of the snapshot's name, which carries the environment and
  // the minute after it
  name?: string;
  region?: string;
  // Waits for the snapshot to finish rather than only to start. RDS captures
  // the data when it begins, so this is about learning it worked rather than
  // about the restore point, and it can take a very long time
  wait?: boolean;
  aws?: Aws;
};

export function rdsSnapshot(options: RdsSnapshotOptions): Plugin {
  assertOneTarget(options);
  const target = slug(options.instance ?? options.cluster ?? "");

  return definePlugin({
    name: `rds-snapshot-${target}`,
    steps: [snapshotStep(options)],
  });
}

function snapshotStep(options: RdsSnapshotOptions): Step<SnapshotPoint> {
  const target = options.instance ?? options.cluster ?? "";
  const aws = options.aws ?? ((args: string[]) => run("aws", args));

  return {
    point: `swap:before:snapshot-${slug(target)}`,

    run: async (input, context) => {
      const identifier = snapshotName(options.name ?? target, context.environment, new Date());
      context.task.detail(`snapshotting ${target} as ${identifier}`);

      await aws(create(options, identifier));

      // The data is captured when it begins, so this is not what makes the
      // restore point good. It is what turns a snapshot that silently failed
      // into a deploy that stops before the migration
      if (options.wait) {
        context.task.detail(`waiting for ${identifier}`);
        await aws(ready(options, identifier));
      }

      return input;
    },
  };
}

function create(options: RdsSnapshotOptions, identifier: string) {
  const region = options.region ? ["--region", options.region] : [];

  if (options.cluster) {
    return [
      "rds",
      "create-db-cluster-snapshot",
      "--db-cluster-identifier",
      options.cluster,
      "--db-cluster-snapshot-identifier",
      identifier,
      ...region,
    ];
  }

  return [
    "rds",
    "create-db-snapshot",
    "--db-instance-identifier",
    options.instance ?? "",
    "--db-snapshot-identifier",
    identifier,
    ...region,
  ];
}

function ready(options: RdsSnapshotOptions, identifier: string) {
  const region = options.region ? ["--region", options.region] : [];

  if (options.cluster) {
    return [
      "rds",
      "wait",
      "db-cluster-snapshot-available",
      "--db-cluster-snapshot-identifier",
      identifier,
      ...region,
    ];
  }

  return ["rds", "wait", "db-snapshot-available", "--db-snapshot-identifier", identifier, ...region];
}

// An instance and a cluster are different API calls against different things,
// and guessing which was meant is worse than being told. Checked where the
// plugin is written rather than where it runs, so the config fails to load
function assertOneTarget(options: RdsSnapshotOptions) {
  if (options.instance && options.cluster) {
    throw new Error(
      "rdsSnapshot names both an instance and a cluster, and they are different databases",
    );
  }

  if (!options.instance && !options.cluster) {
    throw new Error("rdsSnapshot names no instance or cluster to snapshot");
  }
}
