import type { AppTopology, Topology } from "../topology.js";
import type { Deployment, ProxyLogs, ProxySpec, ServiceSpec } from "../types.js";

// Both halves here, since only the app list decides either. Header policy is set once

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

// The published port maps onto this one, and only one side may say it
export const LISTEN_PORT = 3000;

// A service by this name would claim the same container, so the config refuses it
export const PROXY = "nginx";

// Where nginx writes inside its container; a log directory mounts here
export const LOG_DIRECTORY = "/var/log/nginx";

// Derived from the apps' routes rather than listed
export function proxyService(config: Deployment): ServiceSpec {
  return {
    name: PROXY,
    image: (config.proxy && config.proxy.image) || "nginx:stable",
    restart: "always",
  };
}

export function renderProxy(topology: Topology, proxy: ProxySpec = {}) {
  assertNotDerived(proxy.server ?? []);
  assertLocations(topology, proxy);

  const upstreams = topology.apps.map((app) => upstream(app)).join("\n\n");
  // Longest route first, so "/api/" is not shadowed by the "/" catch-all
  const ordered = [...topology.apps].sort((a, b) => routed(b).length - routed(a).length);

  const locations = ordered
    .map((app) => location(app, [...(proxy.location ?? []), ...(proxy.locations?.[app.name] ?? [])]))
    .join("\n\n");

  // Logging leads, so an access_log written by hand replaces it
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

// A line is identified by its directive and, where it carries one, the name after
const NAMED = new Set(["add_header", "proxy_set_header", "proxy_hide_header", "set"]);

// nginx writes to every one, so each is identified by where it writes
const DESTINATIONS = new Set(["access_log", "error_log"]);

function directive(line: string) {
  const [name = "", argument = ""] = line.trim().split(/\s+/);
  if (!NAMED.has(name) && !DESTINATIONS.has(name)) return name;

  return `${name} ${argument.replace(/;$/, "")}`;
}

const ACCESS_OFF = "access_log off";

// The last of each wins; access_log off is every destination, and is itself replaceable
function settled(lines: string[]) {
  const kept = new Map<string, string>();

  for (const line of lines) {
    if (!line.trim()) continue;

    const key = directive(line);
    if (key === ACCESS_OFF) dropAccess(kept);
    if (key.startsWith("access_log ") && key !== ACCESS_OFF) kept.delete(ACCESS_OFF);

    kept.set(key, line.trim());
  }

  return [...kept.values()];
}

function dropAccess(kept: Map<string, string>) {
  for (const key of [...kept.keys()]) {
    if (key.startsWith("access_log ")) kept.delete(key);
  }
}

// The published port maps onto this one, and only one side may say it
function assertNotDerived(lines: string[]) {
  const listening = lines.find((line) => directive(line) === "listen");
  if (!listening) return;

  throw new Error(
    `The proxy's server block says ${listening.trim()}, and the port it listens ` +
      "on inside its container is what publicPort is published onto",
  );
}

// Nothing for a config that says nothing. error_log has no off, only emerg nowhere
function logging(logs: false | ProxyLogs | undefined, environment: string) {
  if (logs === undefined) return [];
  if (logs === false) return ["access_log off;", "error_log /dev/null emerg;"];

  const files = logFiles(logs, environment);
  const docker = logs.docker !== false;
  const level = logs.level ?? "error";

  // Side by side: the image already points its log files at the container output
  const access =
    logs.access === false
      ? ["access_log off;"]
      : [
          ...(files ? [`access_log ${LOG_DIRECTORY}/${files.access};`] : []),
          ...(docker ? ["access_log /dev/stdout;"] : []),
        ];

  const error = [
    ...(files ? [`error_log ${LOG_DIRECTORY}/${files.error} ${level};`] : []),
    ...(docker ? [`error_log /dev/stderr ${level};`] : []),
  ];

  return [...access, ...error];
}

// Each environment's own unless named. A config that would write nowhere is refused
function logFiles(logs: ProxyLogs, environment: string) {
  const access = typeof logs.access === "string" ? logs.access : `${environment}.access.log`;
  const error = logs.error ?? `${environment}.error.log`;
  const named = [typeof logs.access === "string" ? logs.access : undefined, logs.error].filter(
    (name): name is string => name !== undefined,
  );

  if (!logs.directory && named.length > 0) {
    throw new Error(
      `The proxy names the log file ${named.join(" and ")} with no directory to write it in. ` +
        "A file inside the container is gone the next time it is created",
    );
  }

  if (!logs.directory && logs.docker === false) {
    throw new Error(
      "The proxy logs neither to docker nor to a directory. A proxy that should log " +
        "nothing says logs: false",
    );
  }

  if (!logs.directory) return undefined;

  const unsafe = named.find((name) => !/^[\w.-]+$/.test(name) || /^\.+$/.test(name));
  if (unsafe) {
    throw new Error(
      `The proxy log file ${unsafe} has to be a file name: it lands in the directory ` +
        "the logs are mounted from",
    );
  }

  if (logs.access !== false && access === error) {
    throw new Error(`The proxy's access and error logs would both write ${access}, one file`);
  }

  return { access, error };
}

// Absolute, because docker reads anything else as a volume name
export function logMount(proxy: ProxySpec | false | undefined) {
  const directory = proxy && proxy.logs ? proxy.logs.directory : undefined;
  if (directory === undefined) return undefined;

  if (!directory.startsWith("/") || /[:,]/.test(directory)) {
    throw new Error(
      `The proxy logs to ${directory}, which has to be an absolute path on the deploy ` +
        "host with no colon or comma in it: docker reads anything else as a volume name",
    );
  }

  return { volume: directory, mountPath: LOG_DIRECTORY };
}

// proxy_pass is what routes a location, so replacing it is a broken route
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

// Every app has one while there is a proxy; the config refuses one without
function routed(app: AppTopology) {
  if (app.route !== undefined) return app.route;
  throw new Error(`${app.name} has no route, and the proxy resolves every app by one`);
}

function location(app: AppTopology, added: string[]) {
  const route = routed(app);

  // A trailing slash strips the prefix: the catch-all must not carry one
  const target = route === "/" ? `http://${app.name}` : `http://${app.name}/`;

  // Last, so one of these replaces what redkite set rather than repeating it
  const body = settled([`proxy_pass ${target};`, ...FAILOVER, ...FORWARDING, ...added]);

  return `    location ${route} {
${indented(body, 8)}
    }`;
}
