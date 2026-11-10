export class ConfigError extends Error {}

export interface Limits {
  /** Rooms that may exist at once. */
  maxRooms: number;
  /** Open connections in total. */
  maxConnections: number;
  maxConnectionsPerIp: number;
  roomCreatesPerIpPerHour: number;
  /** Failed joins or resumes per address in 5 minutes, before further attempts are refused. */
  failedJoinsPerIpPer5Min: number;
  /** Messages of any kind one connection may send in 10 seconds. */
  eventsPerSocketPer10s: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRooms: 200,
  maxConnections: 500,
  maxConnectionsPerIp: 30,
  roomCreatesPerIpPerHour: 20,
  failedJoinsPerIpPer5Min: 30,
  eventsPerSocketPer10s: 60,
};

export interface ServerConfig {
  port: number;
  /** Websites allowed to connect. */
  origins: string[];
  /** How many proxies sit in front of the server (see clientIp). 0 = none. */
  trustProxyHops: number;
  logClientIps: boolean;
  limits: Limits;
  production: boolean;
}

const LIMIT_ENV: Record<keyof Limits, string> = {
  maxRooms: 'MAX_ROOMS',
  maxConnections: 'MAX_CONNECTIONS',
  maxConnectionsPerIp: 'MAX_CONNECTIONS_PER_IP',
  roomCreatesPerIpPerHour: 'ROOM_CREATES_PER_IP_PER_HOUR',
  failedJoinsPerIpPer5Min: 'FAILED_JOINS_PER_IP_PER_5_MIN',
  eventsPerSocketPer10s: 'EVENTS_PER_SOCKET_PER_10S',
};

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
  }
  return n;
}

/** "https://a.com, https://b.com/" -> ["https://a.com", "https://b.com"] */
export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((o) => {
      let url: URL | null = null;
      try {
        url = new URL(o);
      } catch {
        url = null;
      }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== o) {
        throw new ConfigError(
          `CLIENT_ORIGIN has an entry that isn't a website address like https://example.com: "${o}".`,
        );
      }
      return o;
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const rawOrigins = env.CLIENT_ORIGIN?.trim();
  if (production && !rawOrigins) {
    throw new ConfigError(
      'CLIENT_ORIGIN is required in production. Set it to the address of your website, for example https://my-poker.onrender.com',
    );
  }

  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as (keyof Limits)[]) {
    limits[key] = intFrom(env, LIMIT_ENV[key], DEFAULT_LIMITS[key], 1, 100_000);
  }

  return {
    port: intFrom(env, 'PORT', 3001, 1, 65535),
    origins: rawOrigins ? parseOrigins(rawOrigins) : ['http://localhost:5173'],
    trustProxyHops: intFrom(env, 'TRUST_PROXY_HOPS', 0, 0, 5),
    logClientIps: env.LOG_CLIENT_IPS === 'true',
    limits,
    production,
  };
}