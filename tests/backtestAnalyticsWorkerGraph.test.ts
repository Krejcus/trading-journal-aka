import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';

describe('standalone analytics worker dependency boundary', () => {
  it('bundles for the browser without UI, auth, storage or transport modules', async () => {
    const result = await build({ entryPoints: ['services/backtestAnalytics.worker.ts'], bundle: true,
      write: false, metafile: true, format: 'esm', platform: 'browser', logLevel: 'silent' });
    const paths = Object.keys(result.metafile!.inputs);
    expect(paths.some(path => path.endsWith('backtestIntel.ts'))).toBe(true);
    expect(paths.filter(path => /supabase|storageService|idb-keyval|react|components\//i.test(path))).toEqual([]);
    expect(result.outputFiles[0].text).not.toMatch(/\b(?:fetch|XMLHttpRequest|indexedDB|localStorage)\s*\(/);
  });
});
