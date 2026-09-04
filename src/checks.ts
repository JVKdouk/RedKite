import { appRoot } from "./layout.js";
import type { Built, Context, Plan, Released } from "./pipeline.js";
import { quote } from "./shell.js";
import { attachment, builderOf } from "./steps.js";
import type { AppSpec, VerifySpec } from "./types.js";

// What redkite's verify step runs. An app declares the commands that decide
// whether its build works, and this is the whole of putting them somewhere they
// can reach the services the deployment brought up.
//
// The image is the builder rather than the runtime one. The runtime image holds
// the compiled output and nothing that compiled it, so the test runner is not
// in there, and installing one at check time would test a different tree.

export async function runChecks(input: Built, context: Context): Promise<Released> {
  const checked: string[] = [];

  for (const app of context.config.apps) {
    if (!app.verify) continue;

    await checkApp(app, app.verify, input, context);
    checked.push(app.name);
  }

  // Anything that got here passed: a failing command throws. The lists a swap
  // fills stay empty, because a verify run moves no addresses
  return { ...input, ok: true, released: [], reverted: [], checked };
}

async function checkApp(app: AppSpec, spec: VerifySpec, input: Built, context: Context) {
  const flags = [
    "run --rm",
    ...attachment(spec.network ?? "deployment", context.topology),
    `--workdir ${appRoot(app.dir)}`,
    ...settings({ ...app.environment, ...spec.environment }),
    builderOf(input, app.name),
  ];

  // In order and one at a time. The first is usually what brings the database
  // to the schema the rest expect, so running them together would race
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

// Checked before the run starts, so asking for a verify that would check
// nothing fails without having created a network or built an image
export function assertCheckable(plan: Plan) {
  if (plan.config.apps.some((app) => app.verify)) return;

  throw new Error(
    "No app declares verify, so this run would check nothing. " +
      "An app is verified by giving it verify: { steps: [...] }",
  );
}
