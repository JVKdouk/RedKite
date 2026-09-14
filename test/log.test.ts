import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tag, untagged } from "../src/log.js";

// A step may say something a terminal draws as a label, such as the host a
// repository lives on. Whatever cannot draw one still has to read.

describe("a tag in what a step says", () => {
  it("is written as the bracketed word where nothing can draw it", () => {
    assert.equal(untagged(`${tag("GH")} acme/backend`), "[GH] acme/backend");
  });

  it("finds every tag in a line", () => {
    assert.equal(untagged(`${tag("GH")} a, ${tag("GL")} b`), "[GH] a, [GL] b");
  });

  // Brackets somebody typed are not a tag, which is why a tag is not brackets
  it("leaves brackets that were never a tag alone", () => {
    assert.equal(untagged("acme [x] y"), "acme [x] y");
  });
});
