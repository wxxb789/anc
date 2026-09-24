import { describe, expect, it } from 'vitest';
import { devices } from 'playwright';

import {
  benchmarkBrowserOptionsFromValues,
  parseBenchmarkBrowserOptions,
  parseBenchmarkOptions,
  resolveBenchmarkBrowser,
} from '../scripts/benchmark-browser.ts';

describe('benchmark browser configuration', () => {
  it('maps Chrome and Edge to their installed browser channels', () => {
    expect(resolveBenchmarkBrowser('chrome', undefined, devices).launchOptions).toEqual({ channel: 'chrome' });
    expect(resolveBenchmarkBrowser('edge', undefined, devices).launchOptions).toEqual({ channel: 'msedge' });
    expect(resolveBenchmarkBrowser('chromium', undefined, devices).launchOptions).toEqual({});
  });

  it('records the complete Pixel 7 identity in the browser report', () => {
    const resolved = resolveBenchmarkBrowser('edge', 'Pixel 7', devices);

    expect(resolved.launchOptions).toEqual({ channel: 'msedge' });
    expect(resolved.contextOptions).toEqual({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Mobile Safari/537.36',
      viewport: { width: 412, height: 839 },
      screen: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
    expect(resolved.report).toEqual({
      channel: 'edge',
      device: 'Pixel 7',
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Mobile Safari/537.36',
      viewport: { width: 412, height: 839 },
      screen: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
  });

  it('keeps the desktop viewport when no device profile is requested', () => {
    const resolved = resolveBenchmarkBrowser('chromium', undefined, devices);

    expect(resolved.launchOptions).toEqual({});
    expect(resolved.contextOptions).toEqual({ viewport: { width: 1280, height: 800 } });
    expect(resolved.report.device).toBeNull();
  });

  it('defaults an empty argv to desktop Chromium', () => {
    expect(parseBenchmarkBrowserOptions([])).toEqual({ browser: 'chromium', device: undefined });
  });

  it('rejects an unknown or non-Chromium device profile', () => {
    expect(() => resolveBenchmarkBrowser('edge', 'Not a device', devices)).toThrow(/unknown Playwright device/);
    expect(() => resolveBenchmarkBrowser('edge', 'iPhone 15', devices)).toThrow(/not chromium/);
  });

  it('parses the shared browser and device CLI options', () => {
    expect(parseBenchmarkBrowserOptions(['--browser', 'edge', '--device', 'Pixel 7'])).toEqual({
      browser: 'edge',
      device: 'Pixel 7',
    });
    expect(() => parseBenchmarkBrowserOptions(['--browser', 'safari'])).toThrow(/chromium, chrome, or edge/);
    expect(() => parseBenchmarkBrowserOptions(['--device'])).toThrow(/--device needs a value/);
  });

  it('rejects unknown, positional, duplicate, and silently re-spelled options', () => {
    expect(() => parseBenchmarkBrowserOptions(['--devcie', 'Pixel 7'])).toThrow(/unknown option: --devcie/);
    expect(() => parseBenchmarkBrowserOptions(['Pixel 7'])).toThrow(/unexpected argument: Pixel 7/);
    expect(() => parseBenchmarkBrowserOptions(['--browser', 'edge', '--browser', 'chrome'])).toThrow(
      /duplicate option: --browser/,
    );
    expect(() => parseBenchmarkBrowserOptions(['--browser=edge'])).toThrow(/unsupported option spelling/);
  });

  it('supports one strict parse for a runner-specific complete option set', () => {
    const values = parseBenchmarkOptions(
      ['--sizes', '100', '--browser', 'edge', '--device', 'Pixel 7', '--out', 'report.json'],
      ['sizes', 'topologies', 'samples', 'throttle', 'cli', 'seed', 'browser', 'device', 'out'],
    );

    expect(values).toEqual(
      new Map([
        ['sizes', '100'],
        ['browser', 'edge'],
        ['device', 'Pixel 7'],
        ['out', 'report.json'],
      ]),
    );
    expect(benchmarkBrowserOptionsFromValues(values)).toEqual({ browser: 'edge', device: 'Pixel 7' });
  });

  it('keeps benchmark-limits restricted to browser and device options', () => {
    expect(() => parseBenchmarkBrowserOptions(['--sizes', '100'])).toThrow(/unknown option: --sizes/);
  });
});
