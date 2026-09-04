import base from "../examples/acme/redkite.config.js";
import production from "../examples/acme/redkite.production.config.js";
import staging from "../examples/acme/redkite.staging.config.js";

// What the loader assembles from the example: the deployment, and the
// environments that live in files beside it. Assembled here rather than loaded
// so a test stays synchronous, which is the loader's own job to cover
export default { ...base, environments: { staging, production } };

// The deployment as the file declares it. defineDeployment refuses an
// environments key, so anything asserting on that validation starts from here
export const authored = base;
