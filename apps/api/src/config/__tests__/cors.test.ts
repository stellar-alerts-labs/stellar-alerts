import { describe, it, expect, vi } from 'vitest';
import { createOriginValidator, parseAllowedOrigins } from '../cors';

describe('parseAllowedOrigins', () => {
  it('reads a single origin from APP_URL', () => {
    expect(parseAllowedOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });

  it('reads a comma-separated list and trims whitespace', () => {
    expect(parseAllowedOrigins('https://app.example , https://preview.example')).toEqual([
      'https://app.example',
      'https://preview.example',
    ]);
  });

  it('reduces a URL with a path to its origin', () => {
    expect(parseAllowedOrigins('https://app.example/dashboard/')).toEqual(['https://app.example']);
  });

  it('keeps the port as part of the origin', () => {
    expect(parseAllowedOrigins('http://localhost:3000')).not.toContain('http://localhost');
  });

  it('drops malformed and empty entries', () => {
    expect(parseAllowedOrigins('https://app.example,,not a url')).toEqual(['https://app.example']);
  });

  it('deduplicates repeated origins', () => {
    expect(parseAllowedOrigins('https://app.example,https://app.example/')).toEqual(['https://app.example']);
  });
});

describe('createOriginValidator', () => {
  const validator = createOriginValidator(['https://app.example']);

  it('allows a whitelisted origin', () => {
    const callback = vi.fn();
    validator('https://app.example', callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });

  it('rejects an origin that is not whitelisted', () => {
    const callback = vi.fn();
    validator('https://evil.example', callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });

  it('rejects a look-alike origin on a different port', () => {
    const callback = vi.fn();
    createOriginValidator(['http://localhost:3000'])('http://localhost:3001', callback);
    expect(callback).toHaveBeenCalledWith(null, false);
  });

  it('allows requests without an Origin header', () => {
    const callback = vi.fn();
    validator(undefined, callback);
    expect(callback).toHaveBeenCalledWith(null, true);
  });
});
