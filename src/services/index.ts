import type { ServiceSpec } from "../types.js";

type RedisOptions = {
  image?: string;
  alias?: string;
  address?: number;
  volumes?: Record<string, string>;
};

export function redis(options: RedisOptions = {}): ServiceSpec {
  return {
    name: "redis",
    image: options.image ?? "redis:7",
    alias: options.alias ?? "redis",
    restart: "always",
    address: options.address,
    // The image declares VOLUME /data, so without this the data lands in an
    // anonymous volume that survives nothing and can be named by no one
    volumes: options.volumes ?? { data: "/data" },
  };
}
