import { readFile } from "node:fs/promises";

// Runs from prepublishOnly. A licence nobody can rely on and an author nobody
// can contact are not fixable by publishing again.
//
// Every check here asserts what must be there. Asserting the absence of a
// placeholder instead let a LICENSE with no copyright line at all pass.

const root = new URL("../", import.meta.url);

const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const licence = await readFile(new URL("LICENSE", root), "utf8");

const holder = /^Copyright \(c\) (\d{4}) (.+)$/m.exec(licence);

const problems = [
  !holder && "LICENSE has no `Copyright (c) <year> <holder>` line",
  holder && /todo|xxx|your name/i.test(holder[2] ?? "") &&
    `LICENSE names no real copyright holder, it says ${JSON.stringify(holder[2])}`,
  !manifest.author && "package.json has no author",
  manifest.author &&
    !/.+<[^@]+@[^>]+>/.test(manifest.author) &&
    "package.json author has no contact address, expected `Name <email>`",
  !manifest.license && "package.json declares no license",
].filter(Boolean);

if (problems.length === 0) process.exit(0);

process.stderr.write(
  `Not ready to publish:\n${problems.map((line) => `  · ${line}`).join("\n")}\n`,
);

process.exit(1);
