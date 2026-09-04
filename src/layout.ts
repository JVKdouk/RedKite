// Where a cache is mounted and where a carried directory lands. The renderer
// and the topology have to agree on these, and a second copy of them is a
// drift waiting to happen.

// A package manager's own cache is global; everything else is a path inside the
// project. Both managers are listed because a preset does not know which the
// repository uses, and mounting the wrong one is a cache that never hits
export function mountFor(name: string, dir?: string) {
  if (name === "yarn") return "/root/.yarn";
  if (name === "npm") return "/root/.npm";
  // A workspace resolves one lockfile at the repository root and hoists there
  if (name === "modules") return "/app/node_modules";
  // An app that installs against its own manifest puts them beside it instead.
  // Both are mounted, because only the install command knows which it does, and
  // mounting the wrong one alone is a cache that never hits
  if (name === "app-modules") return `${appRoot(dir)}/node_modules`;
  if (name === "next-app") return rootedAt("/app/.next/cache", dir);
  return rootedAt(`/app/.cache/${name}`, dir);
}

// Where the app itself sits. The whole repository is copied to /app, and dir is
// the app's own place in it
export function appRoot(dir?: string) {
  return dir ? `/app/${dir}` : "/app";
}

// A path under /app belongs to the app, so it moves with it. Bare /app is the
// repository itself and stays: that is what a build shipping its whole tree copies
export function rootedAt(path: string, dir?: string) {
  if (!dir || !path.startsWith("/app/")) return path;
  return `${appRoot(dir)}/${path.slice("/app/".length)}`;
}

// A directory inside the output root moves with it, because the output becomes
// /app in the runtime. Anything else keeps the position it had in the builder:
// flattening it to a basename is what put Next's static assets at /app/static,
// where the server looks for them under .next and answers 404
export function destinationFor(path: string, output: string) {
  if (path.startsWith(`${output}/`)) return `/app/${path.slice(output.length + 1)}`;
  return path;
}
