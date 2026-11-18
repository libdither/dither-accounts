/** Chromium's own stderr noise left out of an account's log and counted (src/noise.ts); everything else kept. */
import { expect, test } from 'bun:test';
import { ChromiumNoise, NOISE_SUMMARY_MS } from '../src/noise.ts';

// Shaped after Chromium's own lines, with made-up pids and times.
const GCM_DEPRECATED = '[1234:1250:1117/101436.123456:ERROR:google_apis/gcm/engine/registration_request.cc:291] Registration response error message: DEPRECATED_ENDPOINT';
const GCM_QUOTA = '[1234:1250:1117/101437.123456:ERROR:google_apis/gcm/engine/registration_request.cc:291] Registration response error message: QUOTA_EXCEEDED';
const GTK = 'Gtk-Message: 10:14:36.123: Failed to load module "colorreload-gtk-module"';
const X_GONE = '[1234:1234:1117/101500.000001:ERROR:ui/gfx/x/connection.cc:64] X connection error received.';
const REAL = '[1234:1234:1117/101501.000001:ERROR:content/browser/renderer_host/render_process_host_impl.cc:5000] Terminating render process';

test('the noise is counted, anything else is kept, line by line', () => {
  const n = new ChromiumNoise(0);
  expect(n.keep([GCM_DEPRECATED, GTK, REAL, GCM_QUOTA, '', X_GONE, GCM_DEPRECATED].join('\n'))).toEqual([REAL]);
  expect(n.keep('Fontconfig error: no such file')).toEqual(['Fontconfig error: no such file']);
  // A line that only mentions the words, from elsewhere, is kept.
  expect(n.keep('DEPRECATED_ENDPOINT seen in a page')).toEqual(['DEPRECATED_ENDPOINT seen in a page']);
});

test('one count line now and then, and none when there was no noise', () => {
  const n = new ChromiumNoise(0);
  n.keep([GCM_DEPRECATED, GCM_DEPRECATED, GTK].join('\n'));
  expect(n.summary(NOISE_SUMMARY_MS - 1)).toBeNull();
  expect(n.summary(NOISE_SUMMARY_MS)).toBe("left out Chromium's own noise in the last 10 min: push registration, DEPRECATED_ENDPOINT ×2, GTK module not found ×1");
  // Counted afresh after each line.
  expect(n.summary(2 * NOISE_SUMMARY_MS)).toBeNull();
  n.keep(X_GONE);
  // At the sandbox's stop, whatever is left, at once.
  expect(n.summary(2 * NOISE_SUMMARY_MS + 60_000, true)).toBe("left out Chromium's own noise in the last 11 min: X connection error at shutdown ×1");
});
