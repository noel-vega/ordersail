import { isLocalDevOrigin, LOCAL_DEV_ORIGIN, normalizeOrigin } from './app-key.util';

describe('normalizeOrigin', () => {
  it('lowercases the scheme and host', () => {
    expect(normalizeOrigin('HTTPS://Shop.Example.com')).toBe('https://shop.example.com');
  });

  it('strips a trailing slash', () => {
    expect(normalizeOrigin('https://shop.example.com/')).toBe('https://shop.example.com');
  });

  it('strips the default port for the scheme', () => {
    expect(normalizeOrigin('https://shop.example.com:443')).toBe('https://shop.example.com');
    expect(normalizeOrigin('http://shop.example.com:80')).toBe('http://shop.example.com');
  });

  it('rejects a non-http(s) scheme', () => {
    expect(normalizeOrigin('ftp://shop.example.com')).toBeNull();
  });

  it('rejects a non-root path', () => {
    expect(normalizeOrigin('https://shop.example.com/products')).toBeNull();
  });

  it('rejects a query string or hash', () => {
    expect(normalizeOrigin('https://shop.example.com/?a=1')).toBeNull();
    expect(normalizeOrigin('https://shop.example.com/#section')).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(normalizeOrigin('not a url')).toBeNull();
  });
});

describe('isLocalDevOrigin', () => {
  it('allows the local dev origin outside production', () => {
    expect(isLocalDevOrigin(LOCAL_DEV_ORIGIN, 'development')).toBe(true);
    expect(isLocalDevOrigin(LOCAL_DEV_ORIGIN, 'test')).toBe(true);
  });

  it('rejects the local dev origin in production', () => {
    expect(isLocalDevOrigin(LOCAL_DEV_ORIGIN, 'production')).toBe(false);
  });

  it('rejects any other origin regardless of env', () => {
    expect(isLocalDevOrigin('https://shop.example.com', 'development')).toBe(false);
    expect(isLocalDevOrigin('https://shop.example.com', 'production')).toBe(false);
  });
});
