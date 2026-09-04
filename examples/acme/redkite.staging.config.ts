import { defineEnvironment } from "../../src/index.js";

// The host builds as well as runs, so this is also the machine the images are
// compiled on and the repositories are cloned to
export default defineEnvironment({
  branch: "staging",
  subnet: "172.255.0",
  publicPort: 4000,
  host: { bastion: "deploy@staging.acme.example" },
});
