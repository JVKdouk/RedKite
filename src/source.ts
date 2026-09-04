import type { Host } from "./host.js";

// Getting the source onto the machine that builds it. A repository the host
// clones for itself over the forwarded agent, so no tree crosses the wire: a
// commit that is already mirrored costs a fetch of whatever is new since the
// last deploy. A directory is already there and is built as it stands.

export type Source = {
  // What the image is tagged by: the commit for a repository, and the content
  // of the working tree for a directory
  release: string;
  // What the build reads, on the machine that builds it
  tree: string;
};

export type SourceRequest = {
  // Names the mirror and the checkout. Keyed per app and environment rather
  // than per repository, so two deploys never fetch into one directory at once
  name: string;
  // Exactly one of these, which is what the config is checked for
  repo?: string;
  path?: string;
  // What of a path goes into the build. Absent leaves it to the work tree's
  // own .gitignore, which is the only other thing that can say
  include?: string[];
  branch: string;
  submodules: boolean;
  detail?: (message: string) => void;
};

// accept-new rather than no: a host key that changes is still worth refusing
const GIT_SSH = "ssh -o StrictHostKeyChecking=accept-new";

export async function prepareSource(
  host: Host,
  request: SourceRequest,
): Promise<Source> {
  if (request.path) return await localSource(host, request.path, request);
  if (request.repo) return await clonedSource(host, request.repo, request);

  throw new Error(`${request.name} names neither a repo nor a path to build from`);
}

// Built where it sits. Nothing is cloned, checked out or cleaned: what the
// build reads is the tree as the person running this left it
async function localSource(
  host: Host,
  path: string,
  request: SourceRequest,
): Promise<Source> {
  const detail = request.detail ?? (() => {});
  detail(`reading ${path}`);

  await assertKnowable(host, path, request.include);

  const release = await treeOf(host, path, request.include);
  detail(`built from ${release.slice(0, 7)}`);

  return { release, tree: path };
}

// Something has to say what belongs in the build. A work tree's .gitignore
// does; anywhere else the deployment has to say it, or the release would cover
// whatever happened to be lying in the directory
async function assertKnowable(host: Host, path: string, include?: string[]) {
  if (include) return;

  const inside = await host.sh(`git -C '${path}' rev-parse --is-inside-work-tree`);
  if (inside.code === 0 && inside.stdout.trim() === "true") return;

  throw new Error(
    `${path} is not a git work tree, so nothing there says what belongs in the ` +
      'build. Say it: include: ["src", "package.json"] on the app names what ' +
      "ships, and git init there would let .gitignore name it instead",
  );
}

// git's own content addressing, over a scratch repository so nothing about the
// source changes and no object lands in it. The tree covers what is committed,
// what is modified and what is untracked, so an edit that is never committed is
// a new release. Without an include it honours .gitignore, which is the same
// set the build reads
async function treeOf(host: Host, path: string, include?: string[]) {
  // Everything the work tree does not ignore, or exactly what was named. The
  // -- is only for the second: it would make -A a path rather than a flag
  const added = include ? `-- ${include.map((item) => `'${item}'`).join(" ")}` : "-A";

  const written = await host.sh(
    [
      "scratch=$(mktemp -d)",
      'git init -q --bare "$scratch/git"',
      `export GIT_DIR="$scratch/git" GIT_WORK_TREE='${path}' GIT_INDEX_FILE="$scratch/index"`,
      `git add ${added}`,
      "git write-tree",
      'rm -rf "$scratch"',
    ].join("\n"),
  );

  const release = written.stdout.trim().split("\n").at(-1) ?? "";
  if (/^[0-9a-f]{40}$/.test(release)) return release;

  throw new Error(`Could not read the state of ${path}: ${written.stderr || written.stdout}`);
}

async function clonedSource(
  host: Host,
  repo: string,
  request: SourceRequest,
): Promise<Source> {
  const detail = request.detail ?? (() => {});
  const mirror = `${host.cache}/mirrors/${request.name}.git`;
  const path = `${host.cache}/source/${request.name}`;

  detail(`fetching ${request.branch}`);
  await run(host, `updating the mirror of ${repo}`, [
    `if [ -d '${mirror}' ]; then`,
    `  git -C '${mirror}' remote set-url origin '${repo}'`,
    `  git -C '${mirror}' remote update --prune`,
    "else",
    `  mkdir -p '${host.cache}/mirrors'`,
    `  git clone --mirror '${repo}' '${mirror}'`,
    "fi",
  ]);

  const resolved = await run(host, `resolving ${request.branch}`, [
    `git -C '${mirror}' rev-parse 'refs/heads/${request.branch}'`,
  ]);

  const release = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error(`${repo} has no branch ${request.branch}`);
  }

  detail(`checking out ${release.slice(0, 7)}`);
  await run(host, `checking out ${release.slice(0, 7)}`, [
    // The checkout shares the mirror's object store, so it costs the working
    // tree and nothing else. Reused between deploys, hence the reset and clean
    `if [ ! -d '${path}/.git' ]; then`,
    `  rm -rf '${path}'`,
    `  mkdir -p '${host.cache}/source'`,
    `  git clone --shared --no-checkout '${mirror}' '${path}'`,
    "fi",
    `git -C '${path}' fetch --prune origin`,
    `git -C '${path}' checkout --detach --force '${release}'`,
    // Leaves the submodules alone: they are tracked, and clean only removes
    // what is not
    `git -C '${path}' clean -ffdx`,
  ]);

  if (request.submodules) {
    // --remote follows the branch named in .gitmodules rather than the commit
    // the parent recorded, which is what the pipeline has always done
    detail("updating submodules");
    await run(host, "updating submodules", [
      `git -C '${path}' submodule sync --recursive`,
      `git -C '${path}' submodule update --init --remote --recursive`,
    ]);
  }

  return { release, tree: path };
}

async function run(host: Host, what: string, script: string[]) {
  const result = await host.sh(
    [`export GIT_SSH_COMMAND='${GIT_SSH}'`, "set -e", ...script].join("\n"),
  );

  if (result.code === 0) return result;

  throw new Error(`Failed ${what}: ${result.stderr || result.stdout}`);
}
