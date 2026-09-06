import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8').toLowerCase();

describe('mac companion read-only safety boundary', () => {
  it('keeps status code free of broker, OAuth and copier-command dependencies', () => {
    const statusApi = source('api/mac-companion/status.ts');
    const statusServer = source('server/macCompanionStatus.ts');
    const combined = `${statusApi}\n${statusServer}`;
    for (const forbidden of [
      'tradovateoauth',
      'getvalidtradovateaccesstoken',
      'nativeliveactivitybrokersnapshot',
      'copiercommandrelay',
      'enqueuecopiercommand',
      'pilot-lease',
      'liquidateposition',
      'flatten-group',
      'arm-live',
    ]) expect(combined).not.toContain(forbidden);
    expect(statusServer).not.toMatch(/\bfetch\s*\(/);
  });

  it('uses an auth scheme that cannot be mistaken for the execution worker', () => {
    const auth = source('server/macCompanionAuth.ts');
    expect(auth).toContain('alphatradecompanion ');
    expect(auth).not.toMatch(/\^device\s/);
  });

  it('never imports the broker-backed widget snapshot endpoint', () => {
    for (const path of [
      'api/mac-companion/status.ts',
      'server/macCompanionStatus.ts',
      'lib/macCompanionContract.ts',
    ]) expect(source(path)).not.toContain('native-widget-snapshot');
  });

  it('gates the public pairing start with a persistent server-side limiter', () => {
    const start = source('api/mac-companion/pairing/start.ts');
    expect(start).toContain('consumemaccompanionpairingstartlimit');
    expect(start.indexOf('consumemaccompanionpairingstartlimit'))
      .toBeLessThan(start.indexOf('startmaccompanionpairing({'));
    expect(start).toContain("res.status(429)");
    expect(start).toContain("res.setheader('retry-after'");
  });
});
