import { readFile } from "node:fs/promises";

// Runs from prepublishOnly. Each check asserts presence, not absence of a placeholder

const root = new URL("../", import.meta.url);

const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const licence = await readFile(new URL("LICENSE", root), "utf8");
const action = await readFile(new URL("action.yml", root), "utf8");

// The action pins the version too, and silently runs the release before last if it drifts
const pinned = /^ {4}default: (\d+\.\d+\.\d+)$/m.exec(action);

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
  !pinned && "action.yml has no `version` default to check against package.json",
  pinned &&
    pinned[1] !== manifest.version &&
    `action.yml pins redkite ${pinned[1]}, but this is ${manifest.version}`,
].filter(Boolean);

if (problems.length === 0) process.exit(0);

process.stderr.write(
  `Not ready to publish:\n${problems.map((line) => `  · ${line}`).join("\n")}\n`,
);

process.exit(1);
