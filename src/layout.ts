// Where a cache is mounted and where a carried directory lands. The renderer
// and the topology have to agree on these, and a second copy of them is a
// drift waiting to happen.

// The yarn cache is global, everything else is a path inside the project
export function mountFor(name: string) {
  if (name === "yarn") return "/root/.yarn";
  if (name === "modules") return "/app/node_modules";
  if (name === "next-app") return "/app/.next/cache";
  return `/app/.cache/${name}`;
}

// A directory inside the output root moves with it, because the output becomes
// /app in the runtime. Anything else keeps the position it had in the builder:
// flattening it to a basename is what put Next's static assets at /app/static,
// where the server looks for them under .next and answers 404
export function destinationFor(path: string, output: string) {
  if (path.startsWith(`${output}/`)) return `/app/${path.slice(output.length + 1)}`;
  return path;
}
