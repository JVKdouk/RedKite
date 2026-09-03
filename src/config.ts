import { assertSteps } from "./pipeline.js";
import type { Deployment, Environment } from "./types.js";

// Identity, but it pins the type so a missing health predicate fails to compile
export function defineDeployment<const T extends Deployment>(config: T): T {
  assertUniqueNames(config);
  assertRoutesResolvable(config);
  assertDirsRelative(config);
  assertSteps(config.steps ?? []);
  return config;
}

// Identity, for an environment that lives in a file of its own. It pins the
// type the same way defineDeployment does, so a missing subnet fails to compile
export function defineEnvironment<const T extends Environment>(environment: T): T {
  return environment;
}

// A dir is joined onto /app inside the image, so an absolute one would render
// a path with two slashes and a climbing one would leave the checkout
function assertDirsRelative(config: Deployment) {
  for (const app of config.apps) {
    const dir = app.dir;
    if (dir === undefined) continue;

    if (!dir || dir.startsWith("/") || dir.endsWith("/")) {
      throw new Error(`dir for ${app.name} must be a path inside the repository`);
    }

    if (dir.split("/").includes("..")) {
      throw new Error(`dir for ${app.name} must not climb out of the repository`);
    }
  }
}

function assertUniqueNames(config: Deployment) {
  const names = [...config.apps, ...config.services].map((item) => item.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Duplicate name in deployment: ${duplicate}`);
}

// Two apps on the same route means one of them is unreachable, and which one
// depends on nginx location precedence rather than on anything written here
function assertRoutesResolvable(config: Deployment) {
  const routes = config.apps.map((app) => app.route);
  const duplicate = routes.find((route, i) => routes.indexOf(route) !== i);
  if (duplicate) throw new Error(`Two apps share the route ${duplicate}`);

  for (const app of config.apps) {
    if (app.route.startsWith("/")) continue;
    throw new Error(`Route for ${app.name} must start with a slash`);
  }
}
