import { bitwarden, defineEnvironment } from "../../src/index.js";

// The host builds as well as runs, so this is also the machine the images are
// compiled on and the repositories are cloned to
export default defineEnvironment({
  branch: "staging",
  subnet: "172.255.0",
  publicPort: 4000,
  host: { bastion: "deploy@staging.acme.example" },

  // Read after each app's own. Staging's BW_KEY lives in .env.staging.deploy,
  // and a Secrets Manager token scoped to staging cannot read production's
  secrets: {
    frontend: bitwarden.item("00000000-0000-4000-8000-000000000011"),
    backend: bitwarden.item("00000000-0000-4000-8000-000000000012"),
  },
});
