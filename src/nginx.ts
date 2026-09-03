import type { AppTopology, Topology } from "./topology.js";

// The nginx configuration is a function of the app list. Header policy is set
// here once rather than per location, which is what let the two blocks drift
// apart and lose X-Forwarded-For on one of them.

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

export function renderNginx(topology: Topology, maxBodySize?: string) {

  const upstreams = topology.apps.map((app) => upstream(app)).join("\n\n");
  // Longest route first, so "/api/" is not shadowed by the "/" catch-all
  const ordered = [...topology.apps].sort((a, b) => b.route.length - a.route.length);
  const locations = ordered.map((app) => location(app)).join("\n\n");

  return `resolver 127.0.0.1 valid=5s;

${upstreams}

server {
    listen ${LISTEN_PORT};
    merge_slashes off;

    client_max_body_size ${maxBodySize ?? "1M"};

${locations}
}
`;
}

function upstream(app: AppTopology) {
  return `upstream ${app.name} {
    server ${app.container}:${app.port} max_fails=1 fail_timeout=2s;
    server ${app.retired}:${app.port} backup;
}`;
}

function location(app: AppTopology) {
  // A trailing slash on proxy_pass strips the location prefix. The catch-all
  // must not carry one, a mounted route must
  const target = app.route === "/" ? `http://${app.name}` : `http://${app.name}/`;
  const body = [`proxy_pass ${target};`, ...FAILOVER, ...FORWARDING];

  return `    location ${app.route} {
${body.map((line) => `        ${line}`).join("\n")}
    }`;
}
