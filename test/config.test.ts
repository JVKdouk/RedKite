import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadConfig } from "../src/cli/config.js";
import { buildingHere, positional, stopper } from "../src/cli/index.js";

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

