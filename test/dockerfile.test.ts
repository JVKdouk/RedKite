import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
import { nextApp, renderDockerfile, topologyFor } from "../src/index.js";

// The Dockerfile is the pipeline, and the layer order is the part worth
// pinning: it is the difference between a deploy and a cold build, and nothing
// about the file itself would tell you it had changed.

const topology = topologyFor(config, "staging");

function render(name: string) {
  const app = config.apps.find((item) => item.name === name)!;
  const target = topology.apps.find((item) => item.name === name)!;

  return renderDockerfile(app.build, {
    caches: target.caches,
    port: target.port,
    release: "da2a148",
    environment: "staging",
    envSecret: `${name}-env`,
    fileSecrets: name === "backend" ? { "/app/google.json": "backend-file-0" } : {},
  });
}

const at = (text: string, needle: string) =>
  text.split("\n").findIndex((line) => line.includes(needle));

describe("the rendered Dockerfile", () => {
  // The whole performance story. The original put the repository above the
  // package install, which rebuilt the toolchain on every deploy
  it("installs dependencies before the source is copied", () => {
    const file = render("backend");

    assert.ok(at(file, "COPY package.json") < at(file, "yarn install"));
    assert.ok(at(file, "yarn install") < at(file, "COPY . /app"));
  });

  it("mounts every cache the topology derived, and no others", () => {
    const file = render("frontend");
    const ids = topology.apps.find((app) => app.name === "frontend")!.caches;

    for (const id of Object.values(ids)) {
      assert.match(file, new RegExp(`--mount=type=cache,id=${id},target=`));
    }

    const mounted = [...file.matchAll(/--mount=type=cache,id=([^,]+)/g)];
    const distinct = new Set(mounted.map((match) => match[1]));

    assert.deepEqual([...distinct].sort(), Object.values(ids).sort());
  });

  it("takes the environment file as a secret rather than a layer", () => {
    const file = render("backend");

    assert.match(file, /--mount=type=secret,id=backend-env/);
    assert.doesNotMatch(file, /DATABASE_URL/);
  });

  it("runs the configured steps in order", () => {
    const file = render("backend");
    const steps = config.apps.find((app) => app.name === "backend")!.build.steps;

    const positions = steps.map((step) => at(file, step));
    assert.ok(positions.every((position) => position !== -1));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  // The checkout on the host resolves them, so the context arrives complete and
  // the build needs neither an agent nor a .git directory to reach GitHub
  it("does not go looking for the repository during the build", () => {
    const file = render("backend");

    assert.doesNotMatch(file, /git submodule/);
    assert.doesNotMatch(file, /--mount=type=ssh/);
    assert.doesNotMatch(file, /ssh-keyscan/);
  });

  // Next serves /_next/static from .next/static. Flattening the carry to a
  // basename put it at /app/static, and every chunk answered 404
  it("carries the directories the output does not contain", () => {
    const file = render("frontend");

    assert.match(file, /COPY --from=builder \/app\/\.next\/standalone \/app/);
    assert.match(file, /COPY --from=builder \/app\/\.next\/static \/app\/\.next\/static/);
    assert.match(file, /COPY --from=builder \/app\/public \/app\/public/);
  });

  it("exposes the port the topology assigned and sets the entrypoint", () => {
    const file = render("backend");

    assert.match(file, /EXPOSE 3001/);
    assert.match(file, /CMD \["node","\/app\/core\/index\.mjs"\]/);
  });

  it("strips the upload token from the shipped environment file", () => {
    assert.match(render("backend"), /sed -i '\/\^SENTRY_AUTH_TOKEN=\/d'/);
  });
});

// An app that is a directory of a repository rather than the whole of it. The
// install still runs at the root, because that is where a workspace lockfile
// resolves every package at once
describe("an app in a directory of its own", () => {
  function rendered(dir?: string) {
    const app = config.apps.find((item) => item.name === "frontend")!;
    const target = topology.apps.find((item) => item.name === "frontend")!;

    return renderDockerfile(app.build, {
      caches: target.caches,
      port: target.port,
      release: "da2a148",
      environment: "staging",
      envSecret: "frontend-env",
      fileSecrets: {},
      dir,
    });
  }

  it("copies the whole repository, then works in the app", () => {
    const file = rendered("apps/web");

    assert.ok(at(file, "COPY . /app") < at(file, "WORKDIR /app/apps/web"));
    assert.ok(at(file, "yarn install") < at(file, "COPY . /app"));
  });

  it("installs at the repository root, not in the app", () => {
    const file = rendered("apps/web");

    assert.ok(file.includes("COPY package.json /app/package.json"));
    assert.ok(file.includes("target=/app/node_modules"));
  });

  it("reads the output and what it carries from the app", () => {
    const file = rendered("apps/web");

    assert.ok(file.includes("COPY --from=builder /app/apps/web/.next/standalone /app"));
    assert.ok(file.includes("COPY --from=builder /app/apps/web/.next/static /app/.next/static"));
    assert.ok(file.includes("COPY --from=builder /app/apps/web/public /app/public"));
    assert.ok(file.includes("target=/app/apps/web/.next/cache"));
  });

  it("writes the environment file where the app will read it", () => {
    assert.ok(rendered("apps/web").includes("/run/secrets/frontend-env /app/apps/web/.env"));
    assert.ok(rendered().includes("/run/secrets/frontend-env /app/.env"));
  });

  it("changes nothing when the app is the repository", () => {
    assert.equal(rendered(), rendered(undefined));
    assert.ok(!rendered().includes("WORKDIR /app/"));
  });
});

// next.config decides which of the two layouts the build produces, and they
// ship different trees
describe("a Next app that is not standalone", () => {
  function rendered(standalone: boolean) {
    const target = topology.apps.find((item) => item.name === "frontend")!;

    return renderDockerfile(nextApp({ standalone, port: 3000 }), {
      caches: target.caches,
      port: target.port,
      release: "da2a148",
      environment: "staging",
      envSecret: "frontend-env",
      fileSecrets: {},
      dir: "apps/web",
    });
  }

  it("ships the whole tree and starts inside the app", () => {
    const file = rendered(false);

    assert.ok(file.includes("COPY --from=builder /app /app"));
    assert.ok(file.includes("WORKDIR /app/apps/web"));
    assert.match(file, /CMD .*next start/);
  });

  // A cache mount is not in the image, so a runtime resolving its own
  // dependencies would find the directory empty
  it("keeps node_modules out of the cache so it ships", () => {
    assert.ok(!rendered(false).includes("target=/app/node_modules"));
    assert.ok(rendered(true).includes("target=/app/node_modules"));
  });

  it("ships only the standalone output otherwise", () => {
    const file = rendered(true);

    assert.ok(file.includes("COPY --from=builder /app/apps/web/.next/standalone /app"));
    assert.match(file, /CMD .*node \/app\/server\.js/);
  });
});
