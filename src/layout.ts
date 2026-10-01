// Manager caches are global, the rest project paths; both managers are mounted
export function mountFor(name: string, dir?: string) {
  if (name === "yarn") return "/root/.yarn";
  if (name === "npm") return "/root/.npm";
  if (name === "modules") return "/app/node_modules";
  if (name === "app-modules") return `${appRoot(dir)}/node_modules`;
  if (name === "next-app") return rootedAt("/app/.next/cache", dir);
  return rootedAt(`/app/.cache/${name}`, dir);
}

export function appRoot(dir?: string) {
  return dir ? `/app/${dir}` : "/app";
}

// Bare /app is the repository itself and stays put
export function rootedAt(path: string, dir?: string) {
  if (!dir || !path.startsWith("/app/")) return path;
  return `${appRoot(dir)}/${path.slice("/app/".length)}`;
}

// A path under the output root moves with it, because the output becomes /app
export function destinationFor(path: string, output: string) {
  if (path.startsWith(`${output}/`)) return `/app/${path.slice(output.length + 1)}`;
  return path;
}
