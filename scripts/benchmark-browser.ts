import type { BrowserContextOptions, LaunchOptions, devices } from 'playwright';

export const BENCHMARK_DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

export type BenchmarkBrowser = 'chromium' | 'chrome' | 'edge';

export const BENCHMARK_BROWSER_OPTION_NAMES = ['browser', 'device'] as const;

export interface BenchmarkBrowserOptions {
  browser: BenchmarkBrowser;
  device: string | undefined;
}

export type BenchmarkOptionValues = ReadonlyMap<string, string>;

/** Parse one complete runner argv against the runner's declared option names. */
export function parseBenchmarkOptions(
  argv: readonly string[],
  allowedOptions: readonly string[],
): BenchmarkOptionValues {
  const allowed = new Set(allowedOptions);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--') || token === '--') {
      throw new Error(`unexpected argument: ${token ?? '<missing>'}`);
    }
    if (token.includes('=')) throw new Error(`unsupported option spelling: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: ${token}`);
    if (values.has(name)) throw new Error(`duplicate option: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    values.set(name, value);
  }
  return values;
}

export function benchmarkBrowserOptionsFromValues(values: BenchmarkOptionValues): BenchmarkBrowserOptions {
  const requestedBrowser = values.get('browser') ?? 'chromium';
  if (requestedBrowser !== 'chromium' && requestedBrowser !== 'chrome' && requestedBrowser !== 'edge') {
    throw new Error('--browser accepts only chromium, chrome, or edge');
  }
  return { browser: requestedBrowser, device: values.get('device') };
}

export function parseBenchmarkBrowserOptions(
  argv: readonly string[],
  allowedOptions: readonly string[] = BENCHMARK_BROWSER_OPTION_NAMES,
): BenchmarkBrowserOptions {
  return benchmarkBrowserOptionsFromValues(parseBenchmarkOptions(argv, allowedOptions));
}

export interface BenchmarkBrowserReport {
  channel: BenchmarkBrowser;
  device: string | null;
  userAgent: string | null;
  viewport: { width: number; height: number };
  screen: { width: number; height: number } | null;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface ResolvedBenchmarkBrowser {
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  report: BenchmarkBrowserReport;
}

export function resolveBenchmarkBrowser(
  browser: BenchmarkBrowser,
  deviceName: string | undefined,
  registry: typeof devices,
): ResolvedBenchmarkBrowser {
  const launchOptions: LaunchOptions =
    browser === 'chrome' ? { channel: 'chrome' } : browser === 'edge' ? { channel: 'msedge' } : {};
  if (deviceName === undefined) {
    return {
      launchOptions,
      contextOptions: { viewport: BENCHMARK_DESKTOP_VIEWPORT },
      report: {
        channel: browser,
        device: null,
        userAgent: null,
        viewport: BENCHMARK_DESKTOP_VIEWPORT,
        screen: null,
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    };
  }

  const descriptor = registry[deviceName];
  if (descriptor === undefined) throw new Error(`unknown Playwright device: ${deviceName}`);
  const { defaultBrowserType, ...contextOptions } = descriptor;
  if (defaultBrowserType !== 'chromium') {
    throw new Error(`Playwright device ${deviceName} requires ${defaultBrowserType}, not chromium`);
  }
  const screen = (descriptor as typeof descriptor & { screen?: { width: number; height: number } }).screen ?? null;
  return {
    launchOptions,
    contextOptions,
    report: {
      channel: browser,
      device: deviceName,
      userAgent: descriptor.userAgent,
      viewport: descriptor.viewport,
      screen,
      deviceScaleFactor: descriptor.deviceScaleFactor,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
    },
  };
}
