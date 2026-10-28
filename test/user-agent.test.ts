import { describe, expect, it } from 'vitest';
import { deviceInfo } from '../src/auth/user-agent.js';

const NO_HINTS = { platform: null, mobile: null, brands: null };

describe('deviceInfo', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { browser: 'Chrome 131', os: 'Windows 10/11', device: 'desktop' }
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
      { browser: 'Edge 131', os: 'Windows 10/11', device: 'desktop' }
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      { browser: 'Safari 18', os: 'iOS 18.1', device: 'mobile' }
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      { browser: 'Chrome 131', os: 'Android 14', device: 'mobile' }
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { browser: 'Chrome 131', os: 'Android 13', device: 'tablet' }
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
      { browser: 'Firefox 132', os: 'macOS 10.15', device: 'desktop' }
    ],
    ['curl/8.5.0', { browser: null, os: null, device: 'bot' }]
  ])('reads %s', (userAgent, expected) => {
    expect(deviceInfo(userAgent, NO_HINTS)).toEqual(expected);
  });

  it('fills in from the client hints what the user agent leaves out', () => {
    expect(
      deviceInfo(null, {
        platform: '"Windows"',
        mobile: false,
        brands: '"Brave";v="131", "Chromium";v="131", "Not_A Brand";v="24"'
      })
    ).toEqual({ browser: 'Brave 131', os: 'Windows', device: 'desktop' });
    expect(deviceInfo(null, NO_HINTS)).toEqual({ browser: null, os: null, device: null });
  });
});
