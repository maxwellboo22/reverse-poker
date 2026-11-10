import { ConfigError, loadConfig, type ServerConfig } from './config';
import { errorFields, log } from './log';
import { startGameServer } from './net/server';

function mustLoadConfig(): ServerConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

const config = mustLoadConfig();

// An unexpected error should be logged, not take every room down with it. If they pile up,
// something is badly wrong: exit so the host restarts a clean server.
const crashes: number[] = [];
function noteCrash(kind: string, e: unknown): void {
  log('error', kind, errorFields(e));
  const now = Date.now();
  crashes.push(now);
  while (crashes.length > 0 && now - crashes[0]! > 60_000) crashes.shift();
  if (crashes.length >= 10) {
    log('error', 'too_many_unexpected_errors_exiting');
    process.exit(1);
  }
}
process.on('uncaughtException', (e) => noteCrash('uncaught_exception', e));
process.on('unhandledRejection', (e) => noteCrash('unhandled_rejection', e));

const server = await startGameServer({
  port: config.port,
  clientOrigin: config.origins,
  limits: config.limits,
  trustProxyHops: config.trustProxyHops,
  logClientIps: config.logClientIps,
});
log('info', 'server_started', {
  port: server.port,
  production: config.production,
  origins: config.origins,
  trustProxyHops: config.trustProxyHops,
  limits: config.limits,
});

// Hosts send SIGTERM when they replace or stop the server.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting_down', { signal });
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref();
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));