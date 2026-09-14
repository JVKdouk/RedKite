import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import base from "./deployment.js";
import {
  bitwarden,
  defineEnvironment,
  definePlugin,
  defineStep,
  listRefs,
  migrate,
  withEnvironment,
} from "../src/index.js";
import type { Deployment, Environment } from "../src/index.js";
import { loadConfig } from "../src/cli/config.js";
import { buildingHere, positional, stopper } from "../src/cli/index.js";
import { needsAgent } from "../src/cli/agent.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}/redkite.config.ts`, import.meta.url));

describe("loading a deployment config", () => {
  it("reads the default export of an ES module package", async () => {
    const config = await loadConfig(fixture("module"));
    assert.equal(config.project, "fixture");
  });

  it("reads the default export of a CommonJS package", async () => {
    const config = await loadConfig(fixture("commonjs"));
    assert.equal(config.project, "fixture");
  });

  // What a config transpiled to CommonJS arrives as, which is what happens when
  // the repository being deployed is itself CommonJS
  it("unwraps a default that Node nested inside module.exports", async () => {
    const config = await loadConfig(fixture("wrapped"));
    assert.equal(config.project, "fixture");
  });

  it("refuses a path that holds no config", async () => {
    await assert.rejects(() => loadConfig(fixture("missing")));
  });
});

// A source path belongs to the file that named it. Read against the working
// directory instead, a deploy from a workspace would build a different tree
// from one run at the root
describe("where a local source resolves to", () => {
  it("reads a path against the deployment file, not the shell", async () => {
    const loaded = await loadConfig(fixture("local"));
    const app = loaded.apps.find((item) => item.path);

    assert.equal(app?.path, dirname(fixture("local")) + "/service");
  });

  it("leaves an app that names a repo alone", async () => {
    const loaded = await loadConfig(fixture("module"));

    assert.ok(loaded.apps.every((app) => app.path === undefined));
  });
});

describe("reading the command line", () => {
  // A flag's value is not the environment, and the environment defaults only
  // when nothing was actually given
  it("does not mistake a flag's value for the environment", () => {
    assert.deepEqual(positional(["deploy", "--config", "a.ts"]), ["deploy"]);
    assert.deepEqual(positional(["deploy", "--config", "a.ts", "production"]), [
      "deploy",
      "production",
    ]);
  });

  it("accepts a flag joined to its value", () => {
    assert.deepEqual(positional(["deploy", "--config=a.ts", "production"]), [
      "deploy",
      "production",
    ]);
  });

  it("keeps a bare flag from swallowing what follows", () => {
    assert.deepEqual(positional(["deploy", "--verbose", "production"]), [
      "deploy",
      "production",
    ]);
  });
});

// A run asked to stop does not exit while what it started is still running.
// What a press changes is how hard the signal is, not whether there is a wait
describe("asking a run to stop", () => {
  function recorder() {
    const said: string[] = [];
    const sent: string[] = [];
    let aborted = 0;
    let left = 0;

    const stop = stopper({
      abort: () => (aborted += 1),
      say: (message) => said.push(message),
      signal: (name) => sent.push(name),
      leave: () => (left += 1),
    });

    const press = (times: number) => {
      for (let n = 0; n < times; n += 1) stop();
    };

    return { press, said, sent, aborted: () => aborted, left: () => left };
  }

  it("asks the build to stop, and says which signal that is", () => {
    const { press, said, sent, aborted } = recorder();
    press(1);

    assert.equal(aborted(), 1);
    assert.deepEqual(sent, ["TERM"]);
    assert.match(said[0] ?? "", /SIGTERM/);
    assert.match(said[0] ?? "", /Press again to kill/);
  });

  it("hardens the signal on the next press, and says so", () => {
    const { press, said, sent } = recorder();
    press(2);

    assert.deepEqual(sent, ["TERM", "KILL"]);
    assert.match(said[1] ?? "", /SIGKILL/);
    assert.match(said[1] ?? "", /Nothing exits until it is gone/);
  });

  // The run is already unwinding, and asking twice must not start it over
  it("aborts once, however many times it is asked", () => {
    const { press, sent, aborted } = recorder();
    press(4);

    assert.equal(aborted(), 1);
    assert.deepEqual(sent, ["TERM", "KILL", "KILL", "KILL"]);
  });

  it("says something on every press", () => {
    const { press, said } = recorder();
    press(3);

    assert.ok(said.length >= 3);
  });

  // Five presses is a build that has ignored SIGKILL. Leaving is offered
  // rather than taken, because taking it leaves work running unwatched
  it("offers the way out after five, and says what it costs", () => {
    const { press, said, sent, left } = recorder();
    press(5);

    assert.equal(left(), 0, "it offers, it does not leave");
    assert.deepEqual(sent, ["TERM", "KILL", "KILL", "KILL", "KILL"]);

    const warning = said.join(" ");
    assert.match(warning, /Press again to leave redkite/);
    assert.match(warning, /keeps running on the host/);
    assert.match(warning, /Nothing will clean up after it but you/);
  });

  it("leaves only once the way out has been read", () => {
    const { press, left } = recorder();
    press(6);

    assert.equal(left(), 1);
  });

  it("does not offer it before five", () => {
    const { press, said } = recorder();
    press(4);

    assert.ok(!said.join(" ").includes("leave redkite"));
  });
});

// --local is the same instruction as buildOn: "local", for one run
// What differs between staging and production is usually which vault item, and
// an environment file is where the rest of what differs already lives
describe("an environment's own secrets", () => {
  const staging: Environment = { branch: "staging", subnet: "10.1.0", publicPort: 80 };
  const production: Environment = { branch: "main", subnet: "10.2.0", publicPort: 80 };

  const deployment = (given: Partial<Record<"staging" | "production", Environment>>) =>
    ({ ...base, environments: { staging, production, ...given } }) satisfies Deployment;

  const appOf = (config: Deployment, name: string) => {
    const app = config.apps.find((item) => item.name === name);
    if (!app) throw new Error(`no ${name} in the fixture`);
    return app;
  };

  it("reads the environment's item after the app's own", () => {
    const config = deployment({
      staging: { ...staging, secrets: { backend: bitwarden.item("staging-backend") } },
    });

    const merged = withEnvironment(config, "staging");
    const before = listRefs(appOf(base, "backend").secrets);

    assert.deepEqual(listRefs(appOf(merged, "backend").secrets), [
      ...before,
      bitwarden.item("staging-backend"),
    ]);
  });

  it("gives an app with none of its own the environment's alone", () => {
    const config = deployment({
      staging: { ...staging, secrets: { frontend: bitwarden.item("staging-frontend") } },
    });

    const merged = withEnvironment(config, "staging");

    assert.deepEqual(listRefs(appOf(merged, "frontend").secrets), [
      bitwarden.item("staging-frontend"),
    ]);
  });

  it("lays the environment's files over the app's own, path by path", () => {
    const config = deployment({
      production: {
        ...production,
        files: {
          backend: {
            "/app/service-account.json": bitwarden.item("production-account"),
            "/etc/ca.pem": bitwarden.item("production-ca"),
          },
        },
      },
    });

    const files = appOf(withEnvironment(config, "production"), "backend").files;

    assert.deepEqual(files?.["/app/service-account.json"], bitwarden.item("production-account"));
    assert.deepEqual(files?.["/etc/ca.pem"], bitwarden.item("production-ca"));
  });

  it("reads only the environment being deployed", () => {
    const config = deployment({
      staging: { ...staging, secrets: { backend: bitwarden.item("staging-backend") } },
      production: { ...production, secrets: { backend: bitwarden.item("production-backend") } },
    });

    const ids = listRefs(appOf(withEnvironment(config, "staging"), "backend").secrets).map(
      (ref) => ref.id,
    );

    assert.ok(ids.includes("staging-backend"));
    assert.ok(!ids.includes("production-backend"), "never another environment's item");
  });

  it("leaves an app the environment does not name as it was", () => {
    const config = deployment({
      staging: { ...staging, secrets: { backend: bitwarden.item("staging-backend") } },
    });

    assert.equal(appOf(withEnvironment(config, "staging"), "frontend"), appOf(config, "frontend"));
  });

  it("refuses an app name the deployment does not have, and says which it has", () => {
    const config = deployment({
      staging: { ...staging, secrets: { worker: bitwarden.item("staging-worker") } },
    });

    assert.throws(() => withEnvironment(config, "staging"), /staging gives secrets to worker.*frontend, backend/);
  });

  it("refuses one named only for its files", () => {
    const config = deployment({
      staging: { ...staging, files: { wroker: { "/app/key.pem": bitwarden.item("key") } } },
    });

    assert.throws(() => withEnvironment(config, "staging"), /wroker/);
  });

  // The CLI folds before it opens anything and the run folds again when it
  // starts. Doing it twice must be doing it once
  it("adds nothing when folded a second time", () => {
    const config = deployment({
      staging: { ...staging, secrets: { backend: bitwarden.item("staging-backend") } },
    });

    const once = withEnvironment(config, "staging");
    const twice = withEnvironment(once, "staging");

    assert.deepEqual(listRefs(appOf(twice, "backend").secrets), listRefs(appOf(once, "backend").secrets));
  });

  it("folds an environment the deployment carries inline the same way", () => {
    const config = {
      ...base,
      environment: { ...staging, secrets: { backend: bitwarden.item("inline-backend") } },
    } satisfies Deployment;

    const ids = listRefs(appOf(withEnvironment(config, "anything"), "backend").secrets).map(
      (ref) => ref.id,
    );

    assert.ok(ids.includes("inline-backend"));
  });

  it("hands back the deployment itself when the environment names no secrets", () => {
    const config = deployment({});

    assert.equal(withEnvironment(config, "staging"), config);
  });
});

// How a migration reaches its database, and whether anything is snapshotted
// first, differ by environment. A step in an environment file says so there
describe("an environment's own steps", () => {
  const staging: Environment = { branch: "staging", subnet: "10.1.0", publicPort: 80 };
  const production: Environment = { branch: "main", subnet: "10.2.0", publicPort: 80 };

  const report = defineStep("build:after:report", (built) => built);
  const shared = migrate({ app: "backend", command: "yarn db:migrate" });

  const deployment = (given: Partial<Record<"staging" | "production", Environment>>) =>
    ({
      ...base,
      steps: [report, shared],
      environments: { staging, production, ...given },
    }) satisfies Deployment;

  it("replaces the deployment's step at the same point, where it stood", () => {
    const own = migrate({ app: "backend", command: "yarn db:migrate", network: "deployment" });
    const merged = withEnvironment(deployment({ staging: { ...staging, steps: [own] } }), "staging");

    assert.deepEqual(merged.steps, [report, own]);
  });

  it("runs a step only the environment has ahead of the deployment's", () => {
    const snapshot = defineStep("swap:before:snapshot-db", (built) => built);
    const merged = withEnvironment(
      deployment({ production: { ...production, steps: [snapshot] } }),
      "production",
    );

    assert.deepEqual(merged.steps, [snapshot, report, shared]);
  });

  it("reads only the environment being deployed", () => {
    const own = migrate({ app: "backend", command: "yarn db:migrate:production" });
    const merged = withEnvironment(
      deployment({ production: { ...production, steps: [own] } }),
      "staging",
    );

    assert.deepEqual(merged.steps, [report, shared]);
  });

  // Replacing by point would otherwise keep the second and drop the first
  it("refuses two steps at one point in one environment", () => {
    const one = migrate({ app: "backend", command: "yarn db:migrate" });
    const two = migrate({ app: "backend", command: "yarn db:migrate:again" });
    const config = deployment({ staging: { ...staging, steps: [one, two] } });

    assert.throws(() => withEnvironment(config, "staging"), /Two steps share the point swap:before:migrate-backend/);
  });

  it("refuses them when the environment file is defined, before anything loads it", () => {
    const one = migrate({ app: "backend", command: "yarn db:migrate" });
    const two = migrate({ app: "backend", command: "yarn db:migrate:again" });

    assert.throws(() => defineEnvironment({ ...staging, steps: [one, two] }), /Two steps share/);
  });

  it("refuses a step at a point a plugin already fills", () => {
    const point = "swap:before:snapshot-db";
    const plugin = definePlugin({ name: "snapshots", steps: [defineStep(point, (built) => built)] });

    const config = {
      ...deployment({ staging: { ...staging, steps: [defineStep(point, (built) => built)] } }),
      plugins: [plugin],
    } satisfies Deployment;

    assert.throws(() => withEnvironment(config, "staging"), /Two steps share the point swap:before:snapshot-db/);
  });

  it("adds nothing when folded a second time", () => {
    const snapshot = defineStep("swap:before:snapshot-db", (built) => built);
    const once = withEnvironment(deployment({ staging: { ...staging, steps: [snapshot] } }), "staging");

    assert.deepEqual(withEnvironment(once, "staging").steps, once.steps);
  });
});

describe("building here for one run", () => {
  const config = {
    project: "acme",
    services: [],
    apps: [],
    environments: {
      staging: { branch: "staging", subnet: "10.1.0", publicPort: 80 },
      production: { branch: "main", subnet: "10.2.0", publicPort: 80 },
    },
  };

  it("moves the build for the environment being deployed", () => {
    const moved = buildingHere(config, "production");

    assert.equal(moved.environments?.production?.buildOn, "local");
    assert.equal(moved.environments?.staging?.buildOn, undefined);
  });

  it("keeps everything else the environment said", () => {
    const moved = buildingHere(config, "production");

    assert.equal(moved.environments?.production?.branch, "main");
    assert.equal(moved.environments?.production?.publicPort, 80);
  });

  it("changes nothing for an environment nobody defined", () => {
    assert.equal(buildingHere(config, "nowhere"), config);
  });
});


// A runner has no keys and no way to be asked for one. Demanding an agent that
// nothing will use is a deploy that cannot run where it has no reason to fail
describe("when an agent is wanted", () => {
  const app = { ...base.apps[0]!, repo: "git@github.com:acme/web.git" };
  const of = (over: Partial<Deployment>): Deployment => ({ ...base, apps: [app], ...over });

  // The connection itself carries the agent, whatever the apps are built from
  it("wants one to reach another machine, whatever it clones", () => {
    const remote = of({
      environment: {
        branch: "main",
        subnet: "10.0.0",
        publicPort: 80,
        host: { bastion: "deploy@acme.example" },
      },
      apps: [{ ...app, repo: "https://github.com/acme/web.git" }],
    });

    assert.equal(needsAgent(remote, "staging"), true);
  });

  it("wants one to clone over ssh, even onto this machine", () => {
    const here = of({ environment: { branch: "main", subnet: "10.0.0", publicPort: 80 } });

    assert.equal(needsAgent(here, "staging"), true);
  });

  // A URL naming its own transport carries its own credentials
  it("wants none for an https clone", () => {
    const open = of({
      environment: { branch: "main", subnet: "10.0.0", publicPort: 80 },
      apps: [{ ...app, repo: "https://github.com/acme/web.git" }],
    });

    assert.equal(needsAgent(open, "staging"), false);
  });

  // What a checked-out runner deploying to its own docker looks like
  it("wants none for a directory on this machine", () => {
    const local = of({
      environment: { branch: "main", subnet: "10.0.0", publicPort: 80 },
      apps: [{ ...app, repo: undefined, path: "." }],
    });

    assert.equal(needsAgent(local, "staging"), false);
  });
});
