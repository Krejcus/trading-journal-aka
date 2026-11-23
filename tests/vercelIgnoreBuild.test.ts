import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const run = (env: Record<string, string>) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VERCEL_')));
  const result = spawnSync('sh', ['scripts/vercel-ignore-build.sh'], { env: { ...clean, ...env }, encoding: 'utf8' });
  return { code: result.status, out: result.stdout };
};
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

// exit 0 = build PŘESKOČIT, exit 1 = buildit. Chyba směrem „přeskočit“ by nechala produkci bez nasazení.
describe('Vercel: přeskakování buildů', () => {
  it('vedlejší větev se nebuildí', () => {
    expect(run({ VERCEL_GIT_COMMIT_REF: 'claude/neco' }).code).toBe(0);
  });
  it('bez údaje o větvi (ruční deploy, deploy hook) se builduje', () => {
    expect(run({}).code).toBe(1);
    expect(run({ VERCEL_GIT_COMMIT_REF: '' }).code).toBe(1);
  });
  it('main: neznámý předchozí commit i redeploy téhož commitu se buildí', () => {
    expect(run({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: '0000000000000000000000000000000000000000' }).code).toBe(1);
    expect(run({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: head }).code).toBe(1);
  });
});
