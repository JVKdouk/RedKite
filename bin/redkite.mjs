#!/usr/bin/env node
import { main } from "../dist/cli/index.js";

// Node warns about a .ts config in a CommonJS package before redkite gets to say
// the same thing usefully, and its advice, .mjs, is wrong for a TypeScript file
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.message.startsWith("Failed to load the ES module")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

await main(process.argv.slice(2));
