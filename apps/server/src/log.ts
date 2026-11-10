type Level = 'info' | 'warn' | 'error';

/**
 * One JSON line per event. NEVER pass game state (cards, hands, chat text) in `fields`:
 * logs are the one place a hidden card could leak by accident.
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test') return; // keep test output quiet
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function errorFields(e: unknown): Record<string, unknown> {
  return e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) };
}