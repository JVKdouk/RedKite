import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
import { renderNginx, topologyFor } from "../src/index.js";

// The configuration a hand-written template produced, kept as a file rather
// than as a string in the test, so this compares against something a person
// can read as nginx rather than against a paraphrase of it
const today = readFileSync(
  new URL("./fixtures/nginx.today.conf", import.meta.url),
  "utf8",
);

const rendered = renderNginx(topologyFor(config, "staging"), config.maxBodySize);

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

    const output = renderNginx(topologyFor(extended, "staging"), config.maxBodySize);

    assert.match(output, /upstream workers \{/);
    assert.match(output, /server acme-staging-workers:3002 max_fails=1/);
    assert.match(output, /server retired-acme-staging-workers:3002 backup;/);
    assert.match(output, /location \/workers\/ \{/);
  });

  it("carries the environment into a production render", () => {
    const output = renderNginx(topologyFor(config, "production"), config.maxBodySize);

    assert.match(output, /server acme-production-backend:3001/);
    assert.doesNotMatch(output, /staging/);
  });
});
