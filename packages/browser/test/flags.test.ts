import { describe, expect, test } from 'bun:test';
import { MEMORY_DISABLED_FEATURES, mergeFeatureFlags } from '../src/flags.ts';

describe('mergeFeatureFlags', () => {
  test('folds every --disable-features and --enable-features into one each, in place of the first', () => {
    const flags = mergeFeatureFlags([
      '--user-data-dir=/tmp/p',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--disable-features=${MEMORY_DISABLED_FEATURES.join(',')}`,
      '--no-first-run',
      '--enable-features=Vulkan,VulkanFromANGLE',
      '--disable-features=SpareRendererForSitePerProcess,Translate',
      '--enable-features=Vulkan,DefaultANGLEVulkan',
    ]);
    expect(flags).toEqual([
      '--user-data-dir=/tmp/p',
      `--disable-features=${['DisableLoadExtensionCommandLineSwitch', ...MEMORY_DISABLED_FEATURES, 'Translate'].join(',')}`,
      '--no-first-run',
      '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
    ]);
  });

  test('leaves a command line with no feature switches as it is', () => {
    expect(mergeFeatureFlags(['--a', '--b=1'])).toEqual(['--a', '--b=1']);
  });

  test('keeps site isolation: no switch that turns it off', () => {
    for (const f of ['SitePerProcess', 'IsolateOrigins', 'SiteIsolationForCrossOriginOpenerPolicy']) expect(MEMORY_DISABLED_FEATURES).not.toContain(f);
  });
});
