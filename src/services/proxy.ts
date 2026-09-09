import type { AppTopology, Topology } from "../topology.js";
import type { Deployment, ProxySpec, ServiceSpec } from "../types.js";

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
  const upstreams = topology.apps.map((app) => upstream(app)).join("\n\n");
  // Longest route first, so "/api/" is not shadowed by the "/" catch-all
  const ordered = [...topology.apps].sort((a, b) => b.route.length - a.route.length);
  const locations = ordered.map((app) => location(app, proxy.location ?? [])).join("\n\n");

  assertNotDerived(proxy.server ?? []);

  const server = settled([
    `merge_slashes off;`,
    `client_max_body_size ${proxy.maxBodySize ?? "1M"};`,
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
