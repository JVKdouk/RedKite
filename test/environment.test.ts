import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dockerEnv } from "../src/environment.js";

// A vault holds dotenv. Docker's env file is a different format that happens to
// look like it, and the difference is silent: the value simply arrives wrong.

describe("handing an environment to docker", () => {
  it("takes the quotes off, because docker would keep them", () => {
    const written = dockerEnv('DATABASE_URL="postgresql://user@host:5432/db"\n');

    assert.equal(written, "DATABASE_URL=postgresql://user@host:5432/db\n");
  });

  it("takes single quotes off too", () => {
    assert.equal(dockerEnv("TOKEN='abc123'\n"), "TOKEN=abc123\n");
  });

  it("leaves an unquoted value alone", () => {
    assert.equal(dockerEnv("PORT=3001\n"), "PORT=3001\n");
  });

  it("keeps a quote that is part of the value", () => {
    assert.equal(dockerEnv('MOTTO=say "hi"\n'), 'MOTTO=say "hi"\n');
  });

  it("drops what docker would read as a variable and should not", () => {
    const written = dockerEnv("# a comment\n\nPORT=3001\n   \n");

    assert.equal(written, "PORT=3001\n");
  });

  it("keeps an = inside a value", () => {
    assert.equal(dockerEnv('KEY="a=b=c"\n'), "KEY=a=b=c\n");
  });

  it("takes the later of two spellings of one variable", () => {
    assert.equal(dockerEnv("PORT=3000\nPORT=3001\n"), "PORT=3001\n");
  });

  it("says which variable it cannot carry, rather than truncating it", () => {
    assert.throws(
      () => dockerEnv('KEY="-----BEGIN----\nline two----END-----"\n'),
      /KEY spans more than one line/,
    );
  });

  it("writes nothing for an environment with nothing in it", () => {
    assert.equal(dockerEnv("# only a comment\n"), "");
  });
});
