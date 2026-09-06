import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';

describe('getProductInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses the runtime display name and keeps the other package details', async () => {
    vi.resetModules();
    vi.spyOn(app, 'getName').mockReturnValue('Test Player');
    const { getProductInfo } = await import('../src/paths');
    const pkg = await import('../package.json');

    expect(getProductInfo()).toEqual({
      productName: 'Test Player',
      description: pkg.description,
      author: pkg.author.split('<')[0].trim(),
      license: pkg.license,
    });
    expect(getProductInfo()).toBe(getProductInfo());
  });
});
