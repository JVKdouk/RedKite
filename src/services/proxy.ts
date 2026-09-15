import type { AppTopology, Topology } from "../topology.js";
import type { Deployment, ProxyLogs, ProxySpec, ServiceSpec } from "../types.js";

// The proxy every route is resolved by: what it is, and the configuration it
// runs. Both halves here, because a deployment does not list this service and
// the only thing that decides either is the app list.
//
// Header policy is set once rather than per location, which is what let the two
// blocks drift apart and lose X-Forwarded-For on one of them.

const FORWARDING = [
  "proxy_set_header Host $http_host;",
  "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
  "proxy_set_header X-Forwarded-Host $http_host;",
  "proxy_set_header X-Forwarded-Proto $scheme;",
];

const FAILOVER = [
  "proxy_connect_timeout 2s;",
  "proxy_read_timeout 30s;",
  "proxy_next_upstream error timeout http_502 http_503;",
  "proxy_next_upstream_tries 2;",
];

// The port the proxy listens on inside its container. The published port maps
// onto this one, so both sides have to agree and only one of them may say it
export const LISTEN_PORT = 3000;

// What the derived proxy is called. A service by this name would be a second
// container claiming the first one's, so the config surface refuses it
export const PROXY = "nginx";

// Where nginx writes inside its container. A log directory is mounted here
export const LOG_DIRECTORY = "/var/log/nginx";

// Not something a deployment lists. Apps carry routes, routes need something
// to resolve them, and this says what that something is
export function proxyService(config: Deployment): ServiceSpec {
  return {
    name: PROXY,
    image: config.proxy?.image ?? "nginx:stable",
    restart: "always",
  };
}

export function renderProxy(topology: Topology, proxy: ProxySpec = {}) {
  assertNotDerived(proxy.server ?? []);
  assertLocations(topology, proxy);

  const upstreams = topology.apps.map((app) => upstream(app)).join("\n\n");
  // Longest route first, so "/api/" is not shadowed by the "/" catch-all
  const ordered = [...topology.apps].sort((a, b) => b.route.length - a.route.length);

  const locations = ordered
    .map((app) => location(app, [...(proxy.location ?? []), ...(proxy.locations?.[app.name] ?? [])]))
    .join("\n\n");

  // Logging leads the lines written by hand, so an access_log there replaces it
  const server = settled([
    `merge_slashes off;`,
    `client_max_body_size ${proxy.maxBodySize ?? "1M"};`,
    ...logging(proxy.logs, topology.environment),
    ...(proxy.server ?? []),
  ]);

  return `resolver 127.0.0.1 valid=5s;

${upstreams}

server {
    listen ${LISTEN_PORT};
${indented(server, 4)}
${locations}
}
`;
}

// nginx refuses a second proxy_read_timeout but expects several
// proxy_set_header, so what identifies a line is the directive and, for the
// ones that carry a name, the name after it
const NAMED = new Set(["add_header", "proxy_set_header", "proxy_hide_header", "set"]);

function directive(line: string) {
  const [name = "", argument = ""] = line.trim().split(/\s+/);
  return NAMED.has(name) ? `${name} ${argument}` : name;
}

// The last of each wins. A line written by hand replaces the one redkite would
// have put there rather than repeating it, which nginx would refuse outright
function settled(lines: string[]) {
  const kept = new Map<string, string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    kept.set(directive(line), line.trim());
  }

  return [...kept.values()];
}

// The published port maps onto this one, so both sides have to agree and only
// one of them may say it
function assertNotDerived(lines: string[]) {
  const listening = lines.find((line) => directive(line) === "listen");
  if (!listening) return;

  throw new Error(
    `The proxy's server block says ${listening.trim()}, and the port it listens ` +
      "on inside its container is what publicPort is published onto",
  );
}

// Nothing for a deployment that says nothing, so a proxy it already runs is not
// recreated for a config that means the same. error_log has no off: the
// quietest it gets is emerg, written nowhere
function logging(logs: false | ProxyLogs | undefined, environment: string) {
  if (logs === undefined) return [];
  if (logs === false) return ["access_log off;", "error_log /dev/null emerg;"];

  // Named for the environment, since two environments on one host may be given
  // the same directory
  const access = logs.directory ? `${LOG_DIRECTORY}/${environment}.access.log` : "/dev/stdout";
  const error = logs.directory ? `${LOG_DIRECTORY}/${environment}.error.log` : "/dev/stderr";

  return [
    logs.access === false ? "access_log off;" : `access_log ${access};`,
    `error_log ${error} ${logs.errors ?? "error"};`,
  ];
}

// The host directory a deployment's logs land in, mounted where nginx writes.
// Absolute, because docker reads anything else as the name of a volume and the
// logs would go somewhere nobody asked for
export function logMount(proxy: ProxySpec | undefined) {
  const directory = proxy?.logs ? proxy.logs.directory : undefined;
  if (directory === undefined) return undefined;

  if (!directory.startsWith("/") || /[:,]/.test(directory)) {
    throw new Error(
      `The proxy logs to ${directory}, which has to be an absolute path on the deploy ` +
        "host with no colon or comma in it: docker reads anything else as a volume name",
    );
  }

  return { volume: directory, mountPath: LOG_DIRECTORY };
}

// An app name nobody has is a typo, and a location it named would otherwise be
// settings nothing reads. proxy_pass is what routes the location to its app, so
// replacing it is not a setting but a broken route
function assertLocations(topology: Topology, proxy: ProxySpec) {
  const apps = new Set(topology.apps.map((app) => app.name));
  const unknown = Object.keys(proxy.locations ?? {}).filter((name) => !apps.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `The proxy sets locations for ${unknown.join(", ")}, which this deployment has ` +
        `no app by that name for. Its apps are ${[...apps].join(", ")}`,
    );
  }

  const lines = [...(proxy.location ?? []), ...Object.values(proxy.locations ?? {}).flat()];
  const routing = lines.find((line) => directive(line) === "proxy_pass");
  if (!routing) return;

  throw new Error(
    `A proxy location says ${routing.trim()}, and where a location sends a request ` +
      "is its app's route, which redkite derives",
  );
}

function indented(lines: string[], by: number) {
  return lines.map((line) => " ".repeat(by) + line).join("\n");
}

function upstream(app: AppTopology) {
  return `upstream ${app.name} {
    server ${app.container}:${app.port} max_fails=1 fail_timeout=2s;
    server ${app.retired}:${app.port} backup;
}`;
}

function location(app: AppTopology, added: string[]) {
  // A trailing slash on proxy_pass strips the location prefix. The catch-all
  // must not carry one, a mounted route must
  const target = app.route === "/" ? `http://${app.name}` : `http://${app.name}/`;

  // Last, so one of these replaces what redkite set rather than repeating it
  const body = settled([`proxy_pass ${target};`, ...FAILOVER, ...FORWARDING, ...added]);

  return `    location ${app.route} {
${indented(body, 8)}
    }`;
}
