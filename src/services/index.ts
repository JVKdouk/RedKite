import type { SecretRefs, ServiceSpec } from "../types.js";

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

type PostgresOptions = {
  // The image refuses to start without POSTGRES_PASSWORD, so this is required
  // rather than optional: a service that cannot come up is not a default
  secrets: SecretRefs;
  image?: string;
  alias?: string;
  address?: number;
  volumes?: Record<string, string>;
  // POSTGRES_DB and POSTGRES_USER, which are settings rather than credentials
  environment?: Record<string, string>;
};

export function postgres(options: PostgresOptions): ServiceSpec {
  return {
    name: "postgres",
    image: options.image ?? "postgres:17-alpine",
    alias: options.alias ?? "postgres",
    restart: "always",
    address: options.address,
    secrets: options.secrets,
    environment: options.environment,
    // The image declares VOLUME on this path, so without naming it the data
    // lands in an anonymous volume that survives nothing and nobody can name
    volumes: options.volumes ?? { data: "/var/lib/postgresql/data" },
  };
}
