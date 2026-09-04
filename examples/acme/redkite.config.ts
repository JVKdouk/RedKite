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

  // The environments are the files beside this one, one each. Selecting one on
  // the command line threads its name into every container, network, volume and
  // cache name, so there is one place the environment can be wrong

  // Hung before the swap, so it runs while the old containers still serve. A
  // failure here throws and nothing retires
  steps: [
    migrate({
      app: "backend",
      command: "yarn db:migrate",
      tunnel: { bastion: "deploy@staging.acme.example", from: "DATABASE_URL" },
    }),
  ],

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
      environment: { PM2_HOME: "/app/logs/pm2" },
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

      health: {
        path: "/health",
        expect: (body) =>
          body.status === "up" && body.redis === "up" && body.database === "up",
      },

      // Only `redkite verify` runs these. They run in the builder image, which
      // still has the test runner in it, on the network redis answers on
      verify: {
        steps: ["yarn db:migrate", "yarn test:integration"],
        environment: { NODE_ENV: "test" },
      },
    },
  ],
});
