import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import { nextApp, nodeApp, renderDockerfile, renderDockerignore, topologyFor } from "../src/index.js";

// Layer order is what nothing about the file itself would tell you had changed

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
  // The repository above the install rebuilt the toolchain on every deploy
  it("installs dependencies before the source is copied", () => {
    const file = render("backend");

    assert.ok(at(file, "COPY package.jso[n]") < at(file, "yarn install"));
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

  // The host resolves them, so the build needs neither an agent nor a .git
  it("does not go looking for the repository during the build", () => {
    const file = render("backend");

    assert.doesNotMatch(file, /git submodule/);
    assert.doesNotMatch(file, /--mount=type=ssh/);
    assert.doesNotMatch(file, /ssh-keyscan/);
  });

  // Flattening the carry to a basename put it at /app/static, and chunks 404d
  it("carries the directories the output does not contain", () => {
    const file = render("frontend");

    assert.match(file, /COPY --from=builder \/app\/\.next\/standalone \/app/);
    assert.match(file, /COPY --from=builder \/app\/\.next\/static \/app\/\.next\/static/);
    assert.match(file, /COPY --from=builder \/app\/publi\[c\] \/app\/public/);
  });

  // The bracket makes it a pattern, and a pattern matching nothing is skipped
  it("fails on a source the build cannot have produced, and only then", () => {
    const file = render("frontend");

    // The output is the app: skipping it ships an image that starts and 404s
    assert.ok(file.includes("COPY --from=builder /app/.next/standalone /app"));
    // What the server serves for every chunk it built
    assert.ok(file.includes("COPY --from=builder /app/.next/static /app/.next/static"));

    // public is whatever the repository put there, and plenty have none
    assert.ok(file.includes("COPY --from=builder /app/publi[c] /app/public"));
    // A lockfile is the package manager's to complain about, in its own words
    assert.ok(file.includes("COPY yarn.loc[k] /app/yarn.lock"));

    // The checkout itself, which is the build having a source at all
    assert.ok(file.includes("COPY . /app"));
  });

  it("exposes the port the topology assigned and sets the entrypoint", () => {
    const file = render("backend");

    assert.match(file, /EXPOSE 3001/);
    assert.match(file, /CMD \["node","\/app\/core\/index\.mjs"\]/);
  });

  // A copied file stays readable in its layer, so only named files are copied
  it("never puts the environment into a layer", () => {
    const rendered = render("backend");

    assert.ok(!rendered.includes("cp /run/secrets/backend-env"), rendered);
    assert.ok(!/COPY[^\n]*\.env/.test(rendered), rendered);
    assert.ok(!rendered.includes("rm -f /app/.env"), "removing it is not the same as not adding it");
  });

  // Present for the step and gone after, so a credential is read but not shipped
  it("mounts the environment onto each build step", () => {
    const steps = render("backend")
      .split("\n")
      .filter((line) => line.startsWith("RUN ") && line.includes("yarn build"));

    assert.ok(steps.length > 0);

    for (const step of steps) {
      assert.match(step, /--mount=type=secret,id=backend-env,target=\/app\/\.env /);
    }
  });

  // Below the packages and above the output, so a new commit does not repeat them
  it("runs the runtime steps between the packages and the output", () => {
    const app = config.apps.find((item) => item.name === "backend")!;
    const target = topology.apps.find((item) => item.name === "backend")!;

    const file = renderDockerfile(
      { ...app.build, runtimePackages: ["curl"], runtimeSteps: ["npm install -g pm2"] },
      {
        caches: target.caches,
        port: target.port,
        release: "da2a148",
        environment: "staging",
        envSecret: "backend-env",
        fileSecrets: {},
      },
    );

    assert.ok(at(file, "apk add --no-cache curl") < at(file, "npm install -g pm2"));
    assert.ok(at(file, "npm install -g pm2") < at(file, "COPY --from=builder"));
  });
});

// The install still runs at the root, where a workspace lockfile resolves
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

    assert.ok(file.includes("COPY package.jso[n] /app/package.json"));
    // Installed before the workdir moves, putting modules where a workspace hoists them
    assert.ok(at(file, "yarn install") < at(file, "WORKDIR /app/apps/web"));
  });

  it("reads the output and what it carries from the app", () => {
    const file = rendered("apps/web");

    assert.ok(file.includes("COPY --from=builder /app/apps/web/.next/standalone /app"));
    assert.ok(file.includes("target=/app/apps/web/.next/cache"));
  });

  // It arrives holding apps/web/server.js, so the carry must not land at the top
  it("lands what it carries where the nested output put the app", () => {
    const file = rendered("apps/web");

    assert.ok(file.includes("/app/apps/web/.next/static /app/apps/web/.next/static"));
    assert.ok(file.includes("/app/apps/web/publi[c] /app/apps/web/public"));
    assert.match(file, /FROM node:22-alpine\nWORKDIR \/app\/apps\/web/);
    assert.match(file, /CMD .*node server\.js/);
  });

  // The ordinary case, where dir must not move anything in the runtime stage
  it("lands it at the top when the output does not keep the layout", () => {
    const spec = { ...config.apps[0]!.build, keepsLayout: false };
    const target = topology.apps.find((item) => item.name === "frontend")!;

    const file = renderDockerfile(spec, {
      caches: target.caches,
      port: target.port,
      release: "da2a148",
      environment: "staging",
      envSecret: "frontend-env",
      fileSecrets: {},
      dir: "apps/web",
    });

    assert.ok(file.includes("/app/apps/web/.next/static /app/.next/static"));
    assert.match(file, /FROM node:22-alpine\nWORKDIR \/app\n/);
  });

  it("mounts the environment where the app will read it", () => {
    assert.ok(rendered("apps/web").includes("target=/app/apps/web/.env"));
    assert.ok(rendered().includes("target=/app/.env"));
  });

  it("changes nothing when the app is the repository", () => {
    assert.equal(rendered(), rendered(undefined));
    assert.ok(!rendered().includes("WORKDIR /app/"));
  });
});

// next.config decides which of the two layouts the build produces
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

  // A step after the build has no mounts, so a node app's modules must be a layer
  it("leaves a plain node app's own node_modules in the image", () => {
    const app = config.apps.find((item) => item.name === "backend")!;
    assert.ok(!app.build.caches.includes("app-modules"));
  });

  // A dropped mount with its layer kept reads as a missing dependency
  it("never mounts node_modules, so it is in the layer that installed it", () => {
    assert.ok(!rendered(false).includes("target=/app/node_modules"));
    assert.ok(!rendered(true).includes("target=/app/node_modules"));
  });

  it("ships only the standalone output otherwise", () => {
    const file = rendered(true);

    assert.ok(file.includes("COPY --from=builder /app/apps/web/.next/standalone /app"));
    assert.match(file, /CMD .*node server\.js/);
  });
});

// Anything a later step must find belongs in the layer, not a mount
describe("what a preset caches", () => {
  const modules = ["modules", "app-modules"];

  it("caches the package managers and nothing that holds node_modules", () => {
    const spec = nodeApp({ steps: [], output: "/app", entrypoint: ["node"] });

    assert.deepEqual(spec.caches, ["yarn", "npm"]);
  });

  it("caches Next's own build cache, which only costs time when it goes", () => {
    const standalone = nextApp();
    const whole = nextApp({ standalone: false });

    assert.ok(standalone.caches.includes("next-app"));
    assert.ok(whole.caches.includes("next-app"));

    for (const name of modules) {
      assert.ok(!standalone.caches.includes(name), name);
      assert.ok(!whole.caches.includes(name), name);
    }
  });
});

// Fetched inside the build, which needs an agent, an ssh, and a host key to check
describe("what the build can reach over ssh", () => {
  const render = (agent?: boolean) => {
    const app = config.apps.find((item) => item.name === "backend")!;

    return renderDockerfile(app.build, {
      caches: {},
      port: 3001,
      release: "abc1234",
      environment: "staging",
      envSecret: "backend-env",
      fileSecrets: {},
      agent,
    });
  };

  it("installs an ssh for git to run", () => {
    assert.match(render(true), /apk add --no-cache [^\n]*openssh-client/);
  });

  it("mounts the agent onto the install and the steps", () => {
    const rendered = render(true).split("\n").filter((line) => line.startsWith("RUN "));
    const reaching = rendered.filter((line) => line.includes("--mount=type=ssh"));

    assert.ok(reaching.some((line) => line.includes("yarn install")), "the install");
    assert.ok(reaching.some((line) => line.includes("yarn build")), "and the steps");
  });

  // Nothing to compare a first sight against, and a refusal breaks the fetch
  it("tells git to accept a host it has not seen", () => {
    assert.match(render(true), /ENV GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"/);
  });

  // Asking for a mount nothing is behind fails the build outright
  it("asks for none of it when there is no agent", () => {
    const rendered = render(false);

    assert.ok(!rendered.includes("--mount=type=ssh"));
    assert.ok(!rendered.includes("GIT_SSH_COMMAND"));
  });
});

// Put into the image on purpose, named, at a path the config chose
describe("a secret an app wants as a file", () => {
  const withFiles = (paths: string[]) => {
    const app = config.apps.find((item) => item.name === "backend")!;

    return renderDockerfile(app.build, {
      caches: {},
      port: 3001,
      release: "abc1234",
      environment: "staging",
      envSecret: "backend-env",
      fileSecrets: Object.fromEntries(paths.map((path, index) => [path, `secret-${index}`])),
    });
  };

  // cp makes no directory, so a credential away from the code used to fail
  it("makes the directory before copying into it", () => {
    const rendered = withFiles(["/etc/creds/service-account.json"]);

    assert.match(rendered, /mkdir -p \/etc\/creds && cp \/run\/secrets\/secret-0/);
  });

  it("mounts each one as its own secret", () => {
    const rendered = withFiles(["/etc/creds/one.json", "/app/two.pem"]);

    assert.match(rendered, /--mount=type=secret,id=secret-0 /);
    assert.match(rendered, /--mount=type=secret,id=secret-1 /);
  });

  // After the output, or the copy that lands /app would remove it again
  it("puts them in after the output has landed", () => {
    const rendered = withFiles(["/app/creds.json"]);

    assert.ok(rendered.indexOf("secrets/secret-0") > rendered.lastIndexOf("COPY --from=builder"));
  });
});

// Narrowing the release alone would upload a node_modules it says nothing about
describe("the rendered dockerignore", () => {
  it("holds back only git when the tree says what it ignores", () => {
    const rendered = renderDockerignore();

    assert.equal(rendered, ".git\n**/.git\n");
  });

  it("holds back everything and lets the named paths through", () => {
    const rendered = renderDockerignore(["src", "package.json"]).split("\n");

    assert.equal(rendered[0], "*");
    assert.ok(rendered.includes("!src"));
    assert.ok(rendered.includes("!package.json"));
  });

  // The last rule to match decides, so an included .git would come back
  it("excludes git after the exemptions, not before", () => {
    const rendered = renderDockerignore(["src"]).split("\n");

    assert.ok(rendered.indexOf(".git") > rendered.indexOf("!src"));
    assert.ok(rendered.includes("**/.git"));
  });
});
