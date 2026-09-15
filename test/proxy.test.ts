import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import config from "./deployment.js";
import {
  fingerprintOf,
  nginx,
  plannedServices,
  renderProxy,
  topologyFor,
  type Deployment,
  type ProxySpec,
} from "../src/index.js";

// The configuration a hand-written template produced, kept as a file rather
// than as a string in the test, so this compares against something a person
// can read as nginx rather than against a paraphrase of it
const today = readFileSync(
  new URL("./fixtures/nginx.today.conf", import.meta.url),
  "utf8",
);

const rendered = renderProxy(topologyFor(config, "staging"), config.proxy);

const meaningful = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

// Both files parsed the same way, so the comparison is per location rather
// than over a flat set of lines that hides which block a header came from
function locations(text: string) {
  const blocks = text.split(/location /).slice(1);

  return Object.fromEntries(
    blocks.map((block) => {
      const route = block.slice(0, block.indexOf(" ")).trim();
      const lines = meaningful(block.slice(0, block.indexOf("}")));
      return [route, lines.filter((line) => line.startsWith("proxy_"))];
    }),
  );
}

describe("nginx renderer", () => {
  it("restores X-Forwarded-For on the catch-all, and changes nothing else", () => {
    const before = locations(today);
    const after = locations(rendered);

    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());

    const changes = Object.entries(after).flatMap(([route, lines]) => {
      const added = lines.filter((line) => !before[route]!.includes(line));
      const removed = before[route]!.filter((line) => !lines.includes(line));
      return [
        ...added.map((line) => `+ ${route} ${line}`),
        ...removed.map((line) => `- ${route} ${line}`),
      ];
    });

    // The one difference is the header whose absence made request.ip wrong
    assert.deepEqual(changes, [
      "+ / proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    ]);
  });

  it("keeps every upstream and server directive the template had", () => {
    const missing = meaningful(today).filter(
      (line) => !meaningful(rendered).includes(line),
    );

    assert.deepEqual(missing, []);
  });

  it("sets the forwarding headers identically on every location", () => {
    const blocks = rendered.split("location ").slice(1);
    const headers = blocks.map((block) =>
      meaningful(block).filter((line) => line.startsWith("proxy_set_header")),
    );

    assert.equal(blocks.length, config.apps.length);
    assert.deepEqual(headers[0], headers[1]);
  });

  it("strips the prefix only for a mounted route", () => {
    assert.match(rendered, /location \/api\/ \{\n\s+proxy_pass http:\/\/backend\/;/);
    assert.match(rendered, /location \/ \{\n\s+proxy_pass http:\/\/frontend;/);
  });

  it("orders locations longest route first, so the catch-all cannot shadow", () => {
    assert.ok(rendered.indexOf("location /api/") < rendered.indexOf("location / "));
  });

  it("renders a third app without touching the library", () => {
    const extended = {
      ...config,
      apps: [
        ...config.apps,
        { ...config.apps[1]!, name: "workers", route: "/workers/", port: 3002 },
      ],
    };

    const output = renderProxy(topologyFor(extended, "staging"), config.proxy);

    assert.match(output, /upstream workers \{/);
    assert.match(output, /server acme-staging-workers:3002 max_fails=1/);
    assert.match(output, /server retired-acme-staging-workers:3002 backup;/);
    assert.match(output, /location \/workers\/ \{/);
  });

  it("carries the environment into a production render", () => {
    const output = renderProxy(topologyFor(config, "production"), config.proxy);

    assert.match(output, /server acme-production-backend:3001/);
    assert.doesNotMatch(output, /staging/);
  });
});

// What redkite derives is the server block and the upstreams. What goes around
// them is written by hand, and nginx is strict about what may be said twice.
describe("what a deployment adds to the server block", () => {
  const render = (proxy: Parameters<typeof renderProxy>[1]) =>
    renderProxy(topologyFor(config, "staging"), proxy);

  it("puts server lines inside the server, above the locations", () => {
    const output = render({ server: ["server_tokens off;"] });

    const tokens = output.indexOf("server_tokens off;");
    const first = output.indexOf("location ");

    assert.ok(tokens > output.indexOf("server {"));
    assert.ok(tokens < first);
  });

  it("puts location lines inside every location", () => {
    const output = render({ location: ["proxy_buffering off;"] });

    assert.equal(output.split("proxy_buffering off;").length - 1, config.apps.length);
  });

  // nginx refuses a second proxy_read_timeout outright rather than letting the
  // later one win, so a line written by hand replaces rather than repeats
  it("replaces what redkite set rather than saying it twice", () => {
    const output = render({ location: ["proxy_read_timeout 300s;"] });

    assert.ok(output.includes("proxy_read_timeout 300s;"));
    assert.ok(!output.includes("proxy_read_timeout 30s;"));
  });

  it("replaces in the server block too", () => {
    const output = render({ maxBodySize: "8M", server: ["client_max_body_size 64M;"] });

    assert.ok(output.includes("client_max_body_size 64M;"));
    assert.ok(!output.includes("client_max_body_size 8M;"));
  });

  // Several of these are expected and all of them are kept, which is why the
  // header's name is part of what identifies the line
  it("keeps every header, and replaces only the one named twice", () => {
    const output = render({
      location: ["proxy_set_header Upgrade $http_upgrade;", "proxy_set_header Host $host;"],
    });

    assert.ok(output.includes("proxy_set_header Upgrade $http_upgrade;"));
    assert.ok(output.includes("proxy_set_header Host $host;"));
    assert.ok(!output.includes("proxy_set_header Host $http_host;"));
    assert.ok(output.includes("proxy_set_header X-Forwarded-Proto $scheme;"));
  });

  // The published port maps onto the one inside the container, so both sides
  // have to agree and only one of them may say it
  it("refuses a server block that says what to listen on", () => {
    assert.throws(() => render({ server: ["listen 8080;"] }), /publicPort is published onto/);
  });
});

// A long-polling API wants a longer read timeout than the pages beside it, and
// a setting for every location was the only kind there was
describe("settings for one app's location", () => {
  const render = (proxy: ProxySpec) => renderProxy(topologyFor(config, "staging"), proxy);

  const blockOf = (output: string, route: string) => {
    const start = output.indexOf(`location ${route} {`);
    assert.ok(start >= 0, `a location for ${route}`);
    return output.slice(start, output.indexOf("}", start));
  };

  it("puts them in that app's location and no other", () => {
    const output = render({ locations: { backend: ["proxy_read_timeout 300s;"] } });

    assert.ok(blockOf(output, "/api/").includes("proxy_read_timeout 300s;"));
    assert.ok(!blockOf(output, "/").includes("proxy_read_timeout 300s;"));
  });

  it("replaces what redkite set there, as a line for every location does", () => {
    const output = render({ locations: { backend: ["proxy_read_timeout 300s;"] } });

    assert.ok(!blockOf(output, "/api/").includes("proxy_read_timeout 30s;"));
    assert.ok(blockOf(output, "/").includes("proxy_read_timeout 30s;"));
  });

  it("replaces what every location was given, for that app alone", () => {
    const output = render({
      location: ["proxy_buffering off;"],
      locations: { backend: ["proxy_buffering on;"] },
    });

    assert.ok(blockOf(output, "/api/").includes("proxy_buffering on;"));
    assert.ok(!blockOf(output, "/api/").includes("proxy_buffering off;"));
    assert.ok(blockOf(output, "/").includes("proxy_buffering off;"));
  });

  it("refuses an app the deployment does not have, and says which it has", () => {
    assert.throws(
      () => render({ locations: { worker: ["proxy_buffering off;"] } }),
      /The proxy sets locations for worker.*frontend, backend/,
    );
  });

  // Where a location sends a request is its app's route. Replacing that is not
  // a setting but a route that goes somewhere else
  it("refuses a location that says where to send the request", () => {
    assert.throws(
      () => render({ locations: { backend: ["proxy_pass http://elsewhere;"] } }),
      /proxy_pass http:\/\/elsewhere;.*app's route/,
    );

    assert.throws(() => render({ location: ["proxy_pass http://elsewhere;"] }), /app's route/);
  });
});

describe("what the proxy logs, and where", () => {
  const render = (proxy: ProxySpec) => renderProxy(topologyFor(config, "staging"), proxy);
  const withProxy = (proxy: ProxySpec) => ({ ...config, proxy }) satisfies Deployment;

  // A deployment that says nothing keeps the config it had, so the proxy it runs
  // is not recreated for a change that means nothing to it
  it("leaves logging to the image when nothing is said", () => {
    const output = render({});

    assert.ok(!output.includes("access_log"));
    assert.ok(!output.includes("error_log"));
  });

  it("writes nothing at all when logging is off", () => {
    const output = render({ logs: false });

    assert.ok(output.includes("access_log off;"));
    assert.ok(output.includes("error_log /dev/null emerg;"));
  });

  it("writes to the container's own output when no directory is named", () => {
    const output = render({ logs: {} });

    assert.ok(output.includes("access_log /dev/stdout;"));
    assert.ok(output.includes("error_log /dev/stderr error;"));
  });

  it("writes files named for the environment into a directory", () => {
    const output = render({ logs: { directory: "/var/log/acme" } });

    assert.ok(output.includes("access_log /var/log/nginx/staging.access.log;"));
    assert.ok(output.includes("error_log /var/log/nginx/staging.error.log error;"));
  });

  it("turns the access log off alone, and keeps errors at the level asked for", () => {
    const output = render({ logs: { directory: "/var/log/acme", access: false, errors: "warn" } });

    assert.ok(output.includes("access_log off;"));
    assert.ok(output.includes("error_log /var/log/nginx/staging.error.log warn;"));
  });

  it("logs from the server block, where a line written by hand replaces it", () => {
    const output = render({ logs: {}, server: ["access_log /dev/null;"] });
    const at = output.indexOf("access_log /dev/null;");

    assert.ok(at > output.indexOf("server {") && at < output.indexOf("location "));
    assert.ok(!output.includes("access_log /dev/stdout;"));
  });

  it("mounts the directory where nginx writes", () => {
    const topology = topologyFor(withProxy(nginx({ logs: { directory: "/var/log/acme" } })), "staging");

    assert.deepEqual(topology.router.volumes, [{ volume: "/var/log/acme", mountPath: "/var/log/nginx" }]);
  });

  it("mounts nothing when there is no directory to write into", () => {
    for (const logs of [undefined, false, {}] as const) {
      const topology = topologyFor(withProxy(nginx({ logs })), "staging");
      assert.deepEqual(topology.router.volumes, [], JSON.stringify(logs));
    }
  });

  // Docker reads a relative path as the name of a volume, and the logs would go
  // into one nobody named
  it("refuses a directory docker would read as a volume name", () => {
    assert.throws(
      () => topologyFor(withProxy(nginx({ logs: { directory: "logs/nginx" } })), "staging"),
      /absolute path on the deploy host/,
    );
  });

  it("recreates the proxy when where it logs changes", () => {
    const fingerprint = (directory: string) => {
      const deployment = withProxy(nginx({ logs: { directory } }));
      const topology = topologyFor(deployment, "staging");
      const [proxy] = plannedServices(deployment, topology);
      assert.ok(proxy);
      return fingerprintOf(proxy, topology);
    };

    assert.notEqual(fingerprint("/var/log/acme"), fingerprint("/srv/logs"));
  });

  it("carries locations and logs through nginx()", () => {
    const proxy = nginx({ locations: { backend: ["proxy_buffering off;"] }, logs: false });

    assert.deepEqual(proxy.locations, { backend: ["proxy_buffering off;"] });
    assert.equal(proxy.logs, false);
  });
});
