import { defineDeployment, nodeApp } from "../../../src/index.js";

// Not how anyone writes a config. It is the shape Node hands back for one that
// was transpiled to CommonJS, with the real export nested in module.exports
export default {
  default: defineDeployment({
    project: "fixture",
    services: [],
    apps: [
      {
        name: "app",
        repo: "git@example.com:app.git",
        route: "/",
        port: 3000,
        build: nodeApp({
          builder: "22-alpine",
          runtime: "22-alpine",
          steps: ["yarn build"],
          output: "/app/dist",
          entrypoint: ["node", "/app/index.js"],
        }),
        health: { path: "/health", expect: (body) => body.status === "ok" },
      },
    ],
  }),
};
