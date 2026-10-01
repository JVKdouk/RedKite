import type { Plan } from "../pipeline.js";

// Must be listed above the migrate it guards; steps run in config order
export type SnapshotPoint = `swap:before:${string}`;

// Letters, digits and single hyphens, which is all RDS accepts as an identifier
export function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function stamp(now: Date) {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function snapshotName(prefix: string, environment: string, now: Date) {
  return slug(`${prefix}-${environment}-${stamp(now)}`);
}

// Read before the run starts, so a missing token fails with the host untouched
export function tokenFrom(name: string, plan: Plan) {
  const value = process.env[name];
  if (value) return value;

  throw new Error(
    `${name} is not set, and ${plan.config.project} snapshots its database before swapping`,
  );
}
