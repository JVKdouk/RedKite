import { defineEnvironment } from "../../src/index.js";

export default defineEnvironment({
  branch: "master",
  subnet: "172.254.0",
  publicPort: 80,
  host: { bastion: "deploy@acme.example" },
});
