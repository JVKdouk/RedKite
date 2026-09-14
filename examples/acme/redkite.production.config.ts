import { bitwarden, defineEnvironment, migrate } from "../../src/index.js";

export default defineEnvironment({
  branch: "master",
  subnet: "172.254.0",
  publicPort: 80,
  host: { bastion: "deploy@acme.example" },

  secrets: {
    frontend: bitwarden.item("00000000-0000-4000-8000-000000000021"),
    backend: bitwarden.item("00000000-0000-4000-8000-000000000022"),
  },

  // Laid over the app's own by path: production's service account replaces the
  // one the deployment names, and every other file stays as it was
  files: {
    backend: {
      "/app/service-account.json": bitwarden.item("00000000-0000-4000-8000-000000000023"),
    },
  },

  // At the point the deployment's migration fills, so it replaces that one for
  // production alone. Production applies migrations already written and never
  // generates one against the database that serves
  steps: [migrate({ app: "backend", command: "yarn db:migrate:deploy" })],
});
