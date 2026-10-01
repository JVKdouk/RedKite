import type { Host } from "./host.js";

// The host clones for itself over the forwarded agent, so no tree crosses the wire

export type Source = {
  // The commit for a repository, the working tree's content for a directory
  release: string;
  // What the build reads, on the machine that builds it
  tree: string;
};

// A branch is tracked, a tag or commit pinned, which decides where git looks
export type RefKind = "branch" | "tag" | "commit";

export type Ref = { kind: RefKind; name: string };

export type SourceRequest = {
  // Keyed per app and environment, so two deploys never fetch into one directory
  name: string;
  // Exactly one of these, which is what the config is checked for
  repo?: string;
  path?: string;
  // Absent leaves it to the work tree's own .gitignore
  include?: string[];
  ref: Ref;
  submodules: boolean;
  detail?: (message: string) => void;
  // Every line git writes: a first clone is the slowest part of a build
  output?: (line: string) => void;
};

// A tag is peeled, so an annotated one answers with the commit it points at
const REVISION: Record<RefKind, (name: string) => string> = {
  branch: (name) => `refs/heads/${name}`,
  tag: (name) => `refs/tags/${name}^{commit}`,
  commit: (name) => `${name}^{commit}`,
};

// Hosts common enough that the path alone names the repository
const WELL_KNOWN = new Set(["github.com"]);

// user@host:path or scheme://user@host/path; a directory has no host
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/;

// The path without the .git, and the host too where it is not a well known one
export function describeRepo(repo: string) {
  const match = REMOTE.exec(repo);
  if (!match?.[1] || !match[2]) return repo.replace(/\.git$/, "");

  return WELL_KNOWN.has(match[1]) ? match[2] : `${match[1]}:${match[2]}`;
}

// A branch goes by name alone; a tag or commit says which kind of pin it is
export function describeRef(ref: Ref) {
  return ref.kind === "branch" ? ref.name : `${ref.kind} ${ref.name}`;
}

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

// Built where it sits: the tree as the person running this left it
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

// Outside a work tree the deployment has to say what belongs in the build
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

// Content addressing over a scratch repository, covering even uncommitted edits
async function treeOf(host: Host, path: string, include?: string[]) {
  // The -- is only for the named form: it would make -A a path rather than a flag
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
  const { kind, name } = request.ref;

  detail(`fetching ${name}`);
  await run(host, `updating the mirror of ${repo}`, [
    `if [ -d '${mirror}' ]; then`,
    `  git -C '${mirror}' remote set-url origin '${repo}'`,
    `  git -C '${mirror}' remote update --prune`,
    "else",
    `  mkdir -p '${host.cache}/mirrors'`,
    `  git clone --mirror '${repo}' '${mirror}'`,
    "fi",
  ], request.output);

  const resolved = await run(host, `resolving ${name}`, [
    `git -C '${mirror}' rev-parse '${REVISION[kind](name)}'`,
  ]);

  const release = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error(`${repo} has no ${kind} ${name}`);
  }

  detail(`checking out ${release.slice(0, 7)}`);
  await run(host, `checking out ${release.slice(0, 7)}`, [
    // Shares the mirror's object store and is reused, hence the reset and clean
    `if [ ! -d '${path}/.git' ]; then`,
    `  rm -rf '${path}'`,
    `  mkdir -p '${host.cache}/source'`,
    `  git clone --shared --no-checkout '${mirror}' '${path}'`,
    "fi",
    `git -C '${path}' fetch --prune origin`,
    `git -C '${path}' checkout --detach --force '${release}'`,
    // Leaves the submodules alone: clean only removes what is not tracked
    `git -C '${path}' clean -ffdx`,
  ], request.output);

  if (request.submodules) {
    // --remote follows .gitmodules' branch rather than the commit the parent recorded
    detail("updating submodules");
    await run(host, "updating submodules", [
      `git -C '${path}' submodule sync --recursive`,
      `git -C '${path}' submodule update --init --remote --recursive`,
    ], request.output);
  }

  return { release, tree: path };
}

async function run(
  host: Host,
  what: string,
  script: string[],
  output?: (line: string) => void,
) {
  const result = await host.sh(
    [`export GIT_SSH_COMMAND='${GIT_SSH}'`, "set -e", ...script].join("\n"),
    output,
  );

  if (result.code === 0) return result;

  throw new Error(`Failed ${what}: ${result.stderr || result.stdout}`);
}
