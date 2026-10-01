import base from "../examples/acme/redkite.config.js";
import production from "../examples/acme/redkite.production.config.js";
import staging from "../examples/acme/redkite.staging.config.js";

export default { ...base, environments: { staging, production } };

export const authored = base;
