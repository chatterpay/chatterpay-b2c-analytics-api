/** Kind of device a browser runs on; `bot` for crawlers and HTTP clients. */
export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot';

/** Browser, operating system and device read from a user agent and its client hints. */
export interface DeviceInfo {
  /** Browser name and major version, e.g. `Chrome 131`; `null` when unknown. */
  browser: string | null;
  /** Operating system and version when the user agent tells it, e.g. `Android 14`. */
  os: string | null;
  device: DeviceType | null;
}

/** Client hints a Chromium browser sends by default. */
export interface ClientHints {
  /** `Sec-CH-UA-Platform`, e.g. `Windows`. */
  platform: string | null;
  /** `Sec-CH-UA-Mobile`. */
  mobile: boolean | null;
  /** `Sec-CH-UA`, the brand list with major versions. */
  brands: string | null;
}

const BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|httpclient|postman|headless/i;

// First match wins, so browsers built on Chromium come before Chrome and Chrome before Safari.
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/YaBrowser\/(\d+)/, 'Yandex'],
  [/Firefox\/(\d+)|FxiOS\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)|Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//, 'Safari']
];

function browserOf(userAgent: string, brands: string | null): string | null {
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match !== null) {
      const version = match.slice(1).find((group) => group !== undefined);
      return version === undefined ? name : `${name} ${version}`;
    }
  }
  // Without a known token, the first real brand of the client hints, e.g. `"Brave";v="131"`.
  const brand = brands
    ?.split(',')
    .map((item) => /"([^"]+)";v="(\d+)"/.exec(item))
    .find((match) => match !== null && !/Not.?A.?Brand|Chromium/i.test(match[1] ?? ''));
  return brand ? `${brand[1]} ${brand[2]}` : null;
}

function osOf(userAgent: string, platform: string | null): string | null {
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)(?:_(\d+))?/.exec(userAgent);
  if (ios !== null) {
    return `iOS ${ios[1]}${ios[2] === undefined ? '' : `.${ios[2]}`}`;
  }
  const android = /Android (\d+(?:\.\d+)?)/.exec(userAgent);
  if (android !== null) {
    return `Android ${android[1]}`;
  }
  if (/Windows NT 10\.0/.test(userAgent)) {
    // Windows 11 reports itself as NT 10.0 too; only the client hints tell them apart.
    return 'Windows 10/11';
  }
  const windows = /Windows NT (\d+\.\d+)/.exec(userAgent);
  if (windows !== null) {
    return `Windows NT ${windows[1]}`;
  }
  const mac = /Mac OS X (\d+)[_.](\d+)/.exec(userAgent);
  if (mac !== null) {
    return `macOS ${mac[1]}.${mac[2]}`;
  }
  if (/CrOS/.test(userAgent)) {
    return 'ChromeOS';
  }
  if (/Linux/.test(userAgent)) {
    return 'Linux';
  }
  return platform;
}

function deviceOf(userAgent: string, mobile: boolean | null): DeviceType | null {
  if (BOT.test(userAgent)) {
    return 'bot';
  }
  if (/iPad|Tablet/.test(userAgent) || (/Android/.test(userAgent) && !/Mobile/.test(userAgent))) {
    return 'tablet';
  }
  if (mobile === true || /Mobi|iPhone|iPod/.test(userAgent)) {
    return 'mobile';
  }
  if (/Windows|Macintosh|X11|CrOS|Linux/.test(userAgent) || mobile === false) {
    return 'desktop';
  }
  return null;
}

/**
 * Reads the browser, operating system and device from a user agent. Heuristic: user agents are
 * free text a client can forge, so the result describes what the client claims, not a verified
 * device. The client hints fill in what a reduced user agent leaves out.
 *
 * @param userAgent - `User-Agent` of the browser; `null` when not sent.
 * @param hints - Client hints of the browser.
 * @returns The device data; every field `null` without a user agent or hints.
 */
export function deviceInfo(userAgent: string | null, hints: ClientHints): DeviceInfo {
  const platform = hints.platform?.replaceAll('"', '') || null;
  if (userAgent === null) {
    return {
      browser: browserOf('', hints.brands),
      os: platform,
      device: hints.mobile === null ? null : hints.mobile ? 'mobile' : 'desktop'
    };
  }
  return {
    browser: browserOf(userAgent, hints.brands),
    os: osOf(userAgent, platform),
    device: deviceOf(userAgent, hints.mobile)
  };
}
