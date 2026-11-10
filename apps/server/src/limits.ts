import type { IncomingHttpHeaders } from 'node:http';

/** "At most `max` events per `windowMs` for each key." In memory only. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(readonly max: number, readonly windowMs: number) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  isFull(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  /** Records an attempt and returns true, or returns false (recording nothing) if over the limit. */
  allow(key: string, now = Date.now()): boolean {
    if (this.isFull(key, now)) return false;
    this.record(key, now);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }

  /** Drops expired entries so the map can't grow forever. */
  prune(now = Date.now()): void {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * The visitor's address. Behind a proxy, every connection arrives from the proxy itself, so the
 * real address is in X-Forwarded-For. Each proxy appends to that list, so the entry
 * `trustedHops` from the end is the one our own proxy added. Anything earlier could be forged
 * by the visitor. With trustedHops = 0 the header is ignored completely.
 */
export function clientIp(
  headers: IncomingHttpHeaders,
  remote: string | undefined,
  trustedHops: number,
): string {
  let ip: string | undefined;
  if (trustedHops > 0) {
    const raw = headers['x-forwarded-for'];
    const joined = Array.isArray(raw) ? raw.join(',') : raw;
    if (joined) {
      const parts = joined.split(',').map((p) => p.trim()).filter(Boolean);
      ip = parts[parts.length - trustedHops];
    }
  }
  ip ??= remote;
  if (!ip) return 'unknown';
  return ip.replace(/^::ffff:/i, '');
}