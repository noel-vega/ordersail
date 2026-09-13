import { normalizeOrigin } from './storefront-origins.util';

describe('normalizeOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(normalizeOrigin('https://shop.example.com')).toEqual(
      'https://shop.example.com',
    );
  });

  it('accepts a bare http origin (local dev)', () => {
    expect(normalizeOrigin('http://localhost:3002')).toEqual(
      'http://localhost:3002',
    );
  });

  it('drops a trailing slash', () => {
    expect(normalizeOrigin('https://shop.example.com/')).toEqual(
      'https://shop.example.com',
    );
  });

  it('rejects a URL with a path', () => {
    expect(normalizeOrigin('https://shop.example.com/store')).toBeNull();
  });

  it('rejects a URL with a query string', () => {
    expect(normalizeOrigin('https://shop.example.com?ref=1')).toBeNull();
  });

  it('rejects a URL with a hash', () => {
    expect(normalizeOrigin('https://shop.example.com#top')).toBeNull();
  });

  it('rejects a non-http(s) scheme', () => {
    expect(normalizeOrigin('ftp://shop.example.com')).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(normalizeOrigin('not-a-url')).toBeNull();
  });
});
