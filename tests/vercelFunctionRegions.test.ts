import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Funkce u databáze (arn1, Stockholm) nesmí volat Tradovate API — to běží
 * v USA (iad1). Hlídá se tranzitivně přes relativní importy: soubor, který
 * volá token/REST Tradovate, z funkce udělá „Tradovate“, pokud není na
 * allowlistu s důvodem (oponentura copier-design-critic 25. 10. 2026).
 */
const root = resolve(__dirname, '..');
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as {
  functions: Record<string, { regions?: string[]; maxDuration?: number }>;
};
const TRADOVATE_CALL = /\b(getValidTradovateAccessToken|tradovateApiBaseUrl|loadNativeLiveActivityBrokerSnapshot|refreshTradovateAccessToken|tickNativeLiveActivitiesWithinBudget|createNativeBrokerSnapshotLoader)\s*\(/;
const DEFINERS = new Set(['server/tradovateOAuthStore.ts', 'server/tradovateOAuth.ts', 'server/nativeLiveActivityBrokerSnapshot.ts']);
const ALLOWED_TRADOVATE_IN_ARN1: Record<string, string> = {
  // Live Activity tik běží jen v pruhu background-v2 (max 1× za 5 s, rozpočet 2,5 s, jen čtení);
  // vyzvednutí příkazů (poll-v2), ACK a heartbeat jsou čistě DB a ty se mají zrychlit.
  'api/tradovate/oauth/copier-relay.ts': 'Live Activity tik jen čte, mimo cestu příkazů',
};

const resolveImport = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(candidate => existsSync(candidate)) ?? null;
};
const tradovateCallers = (entry: string): string[] => {
  const seen = new Set<string>();
  const stack = [resolve(root, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, match[1]);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return [...seen].map(file => file.slice(root.length + 1))
    .filter(file => !DEFINERS.has(file) && TRADOVATE_CALL.test(readFileSync(resolve(root, file), 'utf8')));
};

describe('regiony Vercel funkcí', () => {
  const arn1 = Object.entries(config.functions).filter(([, value]) => value.regions?.includes('arn1')).map(([name]) => name);

  it('relay kopírky a funkce nad DB běží u databáze', () => {
    expect(arn1).toEqual(expect.arrayContaining(['api/tradovate/oauth/copier-relay.ts', 'api/tradovate/oauth/status.ts']));
  });

  it.each(arn1)('%s v arn1 nevolá Tradovate (nebo je na allowlistu s důvodem)', name => {
    const callers = tradovateCallers(name);
    if (ALLOWED_TRADOVATE_IN_ARN1[name]) return;
    expect(callers).toEqual([]);
  });

  it('pilot-lease (token workeru) a hlídač send-alerts zůstávají mimo arn1', () => {
    for (const name of ['api/tradovate/oauth/pilot-lease.ts', 'api/cron/send-alerts.ts']) {
      expect(config.functions[name]?.regions ?? []).not.toContain('arn1');
      expect(tradovateCallers(name).length).toBeGreaterThan(0);
    }
  });

  it('journal-import si drží rozpočet 300 s', () => {
    expect(config.functions['api/cron/journal-import.ts']?.maxDuration).toBe(300);
    expect(config.functions['api/tradovate/oauth/journal-import.ts']?.maxDuration).toBe(300);
  });
});
