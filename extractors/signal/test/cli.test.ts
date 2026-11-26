import { describe, expect, test } from 'bun:test';
import { isJavaOptionsNote, SIGNAL_CLI_JAVA_OPTIONS, signalCliEnv } from '../src/cli.ts';

describe('signal-cli JVM options', () => {
  test('a frugal heap by default, in JDK_JAVA_OPTIONS', () => {
    const env = signalCliEnv({ PATH: '/bin' });
    expect(env.JDK_JAVA_OPTIONS).toBe(SIGNAL_CLI_JAVA_OPTIONS);
    expect(SIGNAL_CLI_JAVA_OPTIONS).toContain('-Xmx256m');
    expect(env.PATH).toBe('/bin');
  });

  test('SIGNAL_CLI_JAVA_OPTIONS replaces them, and empty leaves the JVM its defaults', () => {
    expect(signalCliEnv({ SIGNAL_CLI_JAVA_OPTIONS: '-Xmx512m' }).JDK_JAVA_OPTIONS).toBe('-Xmx512m');
    expect('JDK_JAVA_OPTIONS' in signalCliEnv({ SIGNAL_CLI_JAVA_OPTIONS: '' })).toBe(false);
  });

  test('options already in JDK_JAVA_OPTIONS come last, so they win', () => {
    expect(signalCliEnv({ JDK_JAVA_OPTIONS: '-Xmx1g' }).JDK_JAVA_OPTIONS).toBe(`${SIGNAL_CLI_JAVA_OPTIONS} -Xmx1g`);
    expect(signalCliEnv({ SIGNAL_CLI_JAVA_OPTIONS: '', JDK_JAVA_OPTIONS: '-Xmx1g' }).JDK_JAVA_OPTIONS).toBe('-Xmx1g');
  });

  test("java's note about the options is not an error line", () => {
    expect(isJavaOptionsNote('NOTE: Picked up JDK_JAVA_OPTIONS: -Xmx256m')).toBe(true);
    expect(isJavaOptionsNote('ERROR App - User +15550100 is not registered.')).toBe(false);
  });
});
