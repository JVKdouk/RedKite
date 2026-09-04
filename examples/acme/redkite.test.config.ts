import { defineEnvironment } from "../../src/index.js";

// Built and checked here, never served. Nothing in a verify run listens for
// traffic, so this names no publicPort and no bastion: the machine running the
// checks is the machine that built them
export default defineEnvironment({
  branch: "pull-request",
  subnet: "172.254.0",
});
