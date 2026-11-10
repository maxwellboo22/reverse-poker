import { describe, it, expect } from 'vitest';
import { ConfigError, DEFAULT_LIMITS, loadConfig, parseOrigins } from './config';

describe('loadConfig', () => {
  it('uses development defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3001,
      origins: ['http://localhost:5173'],
      trustProxyHops: 0,
      logClientIps: false,
      limits: DEFAULT_LIMITS,
      production: false,
    });
  });

  it('refuses to start in production without CLIENT_ORIGIN', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CLIENT_ORIGIN/);
  });

  it('reads production settings', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      CLIENT_ORIGIN: 'https://a.example.com/, https://b.example.com',
      PORT: '10000',
      TRUST_PROXY_HOPS: '1',
      MAX_ROOMS: '50',
      LOG_CLIENT_IPS: 'true',
    });
    expect(c.production).toBe(true);
    expect(c.origins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(c.port).toBe(10000);
    expect(c.trustProxyHops).toBe(1);
    expect(c.limits.maxRooms).toBe(50);
    expect(c.limits.maxConnections).toBe(DEFAULT_LIMITS.maxConnections);
    expect(c.logClientIps).toBe(true);
  });

  it('rejects bad values with a message that names the setting', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ MAX_ROOMS: '0' })).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ TRUST_PROXY_HOPS: '9' })).toThrow(/TRUST_PROXY_HOPS/);
  });
});

describe('parseOrigins', () => {
  it('accepts addresses and strips trailing slashes', () => {
    expect(parseOrigins('https://a.com/')).toEqual(['https://a.com']);
    expect(parseOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('rejects things that are not a bare website address', () => {
    for (const bad of ['not a url', 'https://a.com/path', 'ftp://a.com', 'a.com']) {
      expect(() => parseOrigins(bad)).toThrow(ConfigError);
    }
  });
});