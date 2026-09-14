import { bitwarden, defineEnvironment } from "../../src/index.js";

// Built and checked here, never served. Nothing in a verify run listens for
// traffic, so this names no publicPort and no bastion: the machine running the
// checks is the machine that built them
export default defineEnvironment({
  branch: "pull-request",
  subnet: "172.254.0",

  // The checks migrate and test against a database of their own, never one a
  // deployed environment serves from
  secrets: {
    backend: bitwarden.item("00000000-0000-4000-8000-000000000032"),
  },
});
