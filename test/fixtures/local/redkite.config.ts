import { defineDeployment, nodeApp } from "../../../src/index.js";

// The source is the directory beside this file, named relatively. What the
// loader does with that is the point of the fixture
export default defineDeployment({
  project: "local",
  services: [],
  apps: [
    {
      name: "service",
      path: "./service",
      route: "/",
      port: 3000,
      build: nodeApp({
        steps: ["yarn build"],
        output: "/app/dist",
        entrypoint: ["node", "/app/index.mjs"],
      }),
      health: { path: "/health", expect: (body) => body.status === "ok" },
    },
  ],
});
