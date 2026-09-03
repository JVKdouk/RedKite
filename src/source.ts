import type { Host } from "./host.js";

// Getting the repository onto the machine that builds it. The host clones for
// itself over the forwarded agent, so no tree crosses the wire: a commit that
// is already mirrored costs a fetch of whatever is new since the last deploy.

export type Source = {
  // The commit the branch resolved to, which is what the image is tagged by
  release: string;
  // A checkout at that commit on the host, submodules included
  path: string;
};

export type SourceRequest = {
  // Names the mirror and the checkout. Keyed per app and environment rather
  // than per repository, so two deploys never fetch into one directory at once
  name: string;
  repo: string;
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
  const detail = request.detail ?? (() => {});
  const mirror = `${host.cache}/mirrors/${request.name}.git`;
  const path = `${host.cache}/source/${request.name}`;

  detail(`fetching ${request.branch}`);
  await run(host, `updating the mirror of ${request.repo}`, [
    `if [ -d '${mirror}' ]; then`,
    `  git -C '${mirror}' remote set-url origin '${request.repo}'`,
    `  git -C '${mirror}' remote update --prune`,
    "else",
    `  mkdir -p '${host.cache}/mirrors'`,
    `  git clone --mirror '${request.repo}' '${mirror}'`,
    "fi",
  ]);

  const resolved = await run(host, `resolving ${request.branch}`, [
    `git -C '${mirror}' rev-parse 'refs/heads/${request.branch}'`,
  ]);

  const release = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error(`${request.repo} has no branch ${request.branch}`);
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

  return { release, path };
}

async function run(host: Host, what: string, script: string[]) {
  const result = await host.sh(
    [`export GIT_SSH_COMMAND='${GIT_SSH}'`, "set -e", ...script].join("\n"),
  );

  if (result.code === 0) return result;

  throw new Error(`Failed ${what}: ${result.stderr || result.stdout}`);
}
