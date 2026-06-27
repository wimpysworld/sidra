import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { signParams, scrobbleThresholdMs } from '../src/integrations/lastfm';

describe('signParams', () => {
  it('sorts params by name, concatenates name+value, appends secret, then MD5', () => {
    const expected = createHash('md5').update('a1b2secret', 'utf8').digest('hex');
    expect(signParams({ b: '2', a: '1' }, 'secret')).toBe(expected);
  });

  it('is independent of insertion order', () => {
    const secret = 'shh';
    const a = signParams({ method: 'auth.getToken', api_key: 'k' }, secret);
    const b = signParams({ api_key: 'k', method: 'auth.getToken' }, secret);
    expect(a).toBe(b);
  });
});

describe('scrobbleThresholdMs', () => {
  it('returns null for tracks shorter than 30 seconds', () => {
    expect(scrobbleThresholdMs(20)).toBeNull();
  });

  it('returns half the duration for typical tracks', () => {
    expect(scrobbleThresholdMs(180)).toBe(90_000);
  });

  it('caps at 4 minutes for long tracks', () => {
    expect(scrobbleThresholdMs(1200)).toBe(240_000);
  });

  it('falls back to the 4 minute cap when duration is unknown', () => {
    expect(scrobbleThresholdMs(0)).toBe(240_000);
  });
});
