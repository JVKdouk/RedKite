import type { ProxySpec, SecretRefs, ServiceSpec } from "../types.js";

// Derived from the apps' routes, not listed; a service by this name is refused
export function nginx(options: ProxySpec = {}): ProxySpec {
  return {
    image: options.image ?? "nginx:stable",
    maxBodySize: options.maxBodySize ?? "1M",
    server: options.server ?? [],
    location: options.location ?? [],
    locations: options.locations ?? {},
    // Carried as given: absent and false mean different things
    logs: options.logs,
  };
}

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
    // The image declares VOLUME /data, so unnamed data lands in an anonymous volume
    volumes: options.volumes ?? { data: "/data" },
  };
}

type PostgresOptions = {
  // The image refuses to start without POSTGRES_PASSWORD, so it is required
  secrets: SecretRefs;
  image?: string;
  alias?: string;
  address?: number;
  volumes?: Record<string, string>;
  // Settings rather than credentials
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
    // The image declares VOLUME here, so unnamed data lands in an anonymous volume
    volumes: options.volumes ?? { data: "/var/lib/postgresql/data" },
  };
}
