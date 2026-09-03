import {
  bitwarden,
  defineDeployment,
  migrate,
  nextApp,
  nodeApp,
  redis,
  sentry,
} from "../../src/index.js";

export default defineDeployment({
  project: "acme",
  maxBodySize: "1024M",

  // Selected on the command line, threaded into every container, network,
  // volume and cache name. There is one place the environment can be wrong
  environments: {
    // The host builds as well as runs, so this is also the machine the images
    // are compiled on and the repositories are cloned to
    staging: {
      branch: "staging",
      subnet: "172.255.0",
      publicPort: 4000,
      host: { bastion: "deploy@staging.acme.example" },
    },
    production: {
      branch: "master",
      subnet: "172.254.0",
      publicPort: 80,
      host: { bastion: "deploy@acme.example" },
    },
  },

  services: [
    // Pinned while the running container still sits on the address it was
    // given by hand. Drop the pin once it has been recreated
    redis({ address: 26 }),
  ],

  apps: [
    {
      name: "frontend",
      repo: "git@github.com:acme/frontend.git",
      route: "/",
      port: 3000,
      secrets: bitwarden("00000000-0000-4000-8000-000000000001"),
      build: nextApp({ builder: "24-alpine", runtime: "22-alpine" }),
      health: { path: "/api/health", expect: (body) => body.status === "ok" },
    },
    {
      name: "backend",
      repo: "git@github.com:acme/backend.git",
      route: "/api/",
      port: 3001,
      // An array merges in order, so a shared ref could sit ahead of this one
      secrets: bitwarden("00000000-0000-4000-8000-000000000002"),
      volumes: { logs: "/app/logs" },
      files: {
        "/app/service-account.json": bitwarden("00000000-0000-4000-8000-000000000003"),
      },

      build: nodeApp({
        builder: "22-alpine",
        runtime: "24-alpine",
        submodules: true,
        // Install is not listed here. The preset copies package.json and
        // yarn.lock ahead of the source and runs it against those alone
        steps: [
          "sh scripts/install-plugins.sh",
          "yarn db:generate",
          "yarn build",
        ],
        output: "/app/dist",
        carry: ["/app/.generated"],
        entrypoint: ["node", "/app/core/index.mjs"],
        sourcemaps: sentry({ stripFromImage: "SENTRY_AUTH_TOKEN" }),
      }),

      beforeSwap: migrate({
        command: "yarn db:migrate",
        tunnel: { bastion: "deploy@staging.acme.example", from: "DATABASE_URL" },
      }),

      health: {
        path: "/health",
        expect: (body) =>
          body.status === "up" && body.redis === "up" && body.database === "up",
      },
    },
  ],
});
