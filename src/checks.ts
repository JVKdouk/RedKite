import { envFlags } from "./environment.js";
import { appRoot } from "./layout.js";
import type { Built, Context, Plan, Released } from "./pipeline.js";
import { quote } from "./shell.js";
import { attachment, builderOf } from "./steps.js";
import type { AppSpec, VerifySpec } from "./types.js";

// Runs in the builder image, the only one holding the test runner

export async function runChecks(input: Built, context: Context): Promise<Released> {
  const checked: string[] = [];

  for (const app of context.config.apps) {
    if (!app.verify) continue;

    await checkApp(app, app.verify, input, context);
    checked.push(app.name);
  }

  // A failing command throws, and a verify run moves no addresses
  return { ...input, ok: true, released: [], reverted: [], checked };
}

async function checkApp(app: AppSpec, spec: VerifySpec, input: Built, context: Context) {
  const flags = [
    "run --rm",
    ...attachment(spec.network ?? "deployment", context.topology),
    // Before the named settings, so a check can override the vault
    ...(await envFlags(app, context)),
    `--workdir ${appRoot(app.dir)}`,
    ...settings({ ...app.environment, ...spec.environment }),
    builderOf(input, app.name),
  ];

  // One at a time: the first usually migrates the database the rest expect
  for (const command of spec.steps) {
    context.task.detail(`${app.name}: ${command}`);

    await context.docker.runOrThrow(
      [...flags, "sh -c", quote(command)].join(" "),
      `${app.name} failed ${command}`,
      context.task.line,
    );
  }
}

function settings(environment: Record<string, string>) {
  return Object.entries(environment).map(([name, value]) => `-e ${name}=${quote(value)}`);
}

// Checked before the run starts, so nothing is created first
export function assertCheckable(plan: Plan) {
  if (plan.config.apps.some((app) => app.verify)) return;

  throw new Error(
    "No app declares verify, so this run would check nothing. " +
      "An app is verified by giving it verify: { steps: [...] }",
  );
}
