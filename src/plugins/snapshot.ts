import type { Plan } from "../pipeline.js";

// What the two snapshot plugins share. A snapshot is a control-plane call
// rather than anything the deploy host does, so it runs where the credentials
// are, which is the process running redkite.

// Hung before the swap and before any migration, so the thing being protected
// from is still ahead of it. Steps run in the order the config lists them, so a
// snapshot has to be written above the migrate it guards
export type SnapshotPoint = `swap:before:${string}`;

// Letters, digits and single hyphens, which is the intersection of what RDS
// accepts as a snapshot identifier and what a point may be named
export function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// Sortable, second-resolution, and legal in every identifier below. Two
// snapshots in one second would collide, and two deploys in one second is not
// a thing a swap can do
export function stamp(now: Date) {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// Names the deploy it was taken for. A snapshot nobody can place is one nobody
// will dare restore
export function snapshotName(prefix: string, environment: string, now: Date) {
  return slug(`${prefix}-${environment}-${stamp(now)}`);
}

// Read before the run starts, so a missing token is a config that fails while
// the host is untouched rather than a deploy that stops with the swap ahead
export function tokenFrom(name: string, plan: Plan) {
  const value = process.env[name];
  if (value) return value;

  throw new Error(
    `${name} is not set, and ${plan.config.project} snapshots its database before swapping`,
  );
}
