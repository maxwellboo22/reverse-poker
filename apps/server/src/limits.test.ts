import { describe, it, expect } from 'vitest';
import { SlidingWindow, clientIp } from './limits';

describe('SlidingWindow', () => {
  it('allows up to the maximum, then refuses until the window passes', () => {
    const w = new SlidingWindow(3, 1000);
    expect(w.allow('a', 0)).toBe(true);
    expect(w.allow('a', 100)).toBe(true);
    expect(w.allow('a', 200)).toBe(true);
    expect(w.allow('a', 300)).toBe(false);
    expect(w.allow('b', 300)).toBe(true); // other keys are separate
    expect(w.allow('a', 1001)).toBe(true); // the first hit has expired
  });

  it('refused attempts do not extend the block', () => {
    const w = new SlidingWindow(2, 1000);
    expect(w.allow('a', 0)).toBe(true);
    expect(w.allow('a', 600)).toBe(true);
    expect(w.allow('a', 700)).toBe(false);
    expect(w.allow('a', 1001)).toBe(true);
  });

  it('record() and isFull() work without allow()', () => {
    const w = new SlidingWindow(2, 1000);
    w.record('a', 0);
    expect(w.isFull('a', 10)).toBe(false);
    w.record('a', 20);
    expect(w.isFull('a', 30)).toBe(true);
    expect(w.isFull('a', 1500)).toBe(false);
  });

  it('forgets keys and prunes expired entries', () => {
    const w = new SlidingWindow(2, 1000);
    w.record('a', 0);
    w.record('b', 0);
    w.forget('a');
    expect(w.size).toBe(1);
    w.prune(5000);
    expect(w.size).toBe(0);
  });
});

describe('clientIp', () => {
  const xff = (v: string) => ({ 'x-forwarded-for': v });

  it('ignores the header unless proxies are trusted', () => {
    expect(clientIp(xff('1.2.3.4'), '10.0.0.1', 0)).toBe('10.0.0.1');
  });

  it('takes the entry the trusted proxy added, counted from the end', () => {
    expect(clientIp(xff('6.6.6.6, 1.2.3.4'), '10.0.0.1', 1)).toBe('1.2.3.4'); // 6.6.6.6 was forged
    expect(clientIp(xff('1.2.3.4, 5.6.7.8'), '10.0.0.1', 2)).toBe('1.2.3.4');
  });

  it('falls back to the connection address when the header is missing or too short', () => {
    expect(clientIp({}, '10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientIp(xff('1.2.3.4'), '10.0.0.1', 3)).toBe('10.0.0.1');
  });

  it('cleans up IPv6-mapped addresses and handles no address at all', () => {
    expect(clientIp({}, '::ffff:127.0.0.1', 0)).toBe('127.0.0.1');
    expect(clientIp({}, undefined, 0)).toBe('unknown');
  });
});