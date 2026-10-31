import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  barsContractConflicts,
  barsContractMatchesSymbol,
  mergeLiveBarsFile,
  normalizeBarsContract,
  pickTvBars,
  validateTvBarsCapture,
  type TvBar,
} from '../lib/tradingViewBars';

const NOW = Date.UTC(2026, 9, 28, 14, 0, 0);
const minute = (offset: number) => Math.floor(NOW / 60_000) * 60 + offset * 60;
const bar = (offset: number, close: number, volume = 10): TvBar => [minute(offset), close, close + 1, close - 1, close, volume];
const file = (source: string, contract: string | null, bars: TvBar[]) => ({ at: NOW, source, contract, bars });

describe('soubor živých svíček dne — kontrakt a zdroj', () => {
  it('kontrakt: jen formát MNQZ2026; shoda s kontraktem obchodu podle rodiny, měsíce a roku', () => {
    expect(normalizeBarsContract('mnqz2026')).toBe('MNQZ2026');
    expect(normalizeBarsContract('MNQZ6')).toBeNull();
    expect(normalizeBarsContract(42)).toBeNull();
    expect(barsContractMatchesSymbol('MNQZ2026', 'MNQZ6')).toBe(true);
    expect(barsContractMatchesSymbol('MNQZ2026', 'NQZ6')).toBe(true);
    expect(barsContractMatchesSymbol('MNQZ2026', 'MNQH7')).toBe(false);
    expect(barsContractMatchesSymbol('MNQZ2026', 'ESZ6')).toBe(false);
    expect(barsContractMatchesSymbol(null, 'MNQZ6')).toBe(false);
    // Konflikt jen když jsou obě strany známé a liší se.
    expect(barsContractConflicts('MNQH2027', 'MNQZ6')).toBe(true);
    expect(barsContractConflicts('MNQZ2026', 'MNQZ6')).toBe(false);
    expect(barsContractConflicts(null, 'MNQZ6')).toBe(false);
    expect(barsContractConflicts('MNQH2027', 'MNQ')).toBe(false);
  });

  it('server přijme a normalizuje kontrakt; chybějící = null', () => {
    const body = { root: 'MNQ', at: NOW, source: 'IBKR:MNQZ2026', contract: 'MNQZ2026', bars: [bar(-2, 100), bar(-1, 101)] };
    expect(validateTvBarsCapture(body, NOW).contract).toBe('MNQZ2026');
    expect(validateTvBarsCapture({ ...body, contract: 'evil' }, NOW).contract).toBeNull();
    expect(validateTvBarsCapture({ ...body, contract: undefined }, NOW).contract).toBeNull();
  });

  it('graf TV vrací i front_contract', () => {
    const picked = pickTvBars([{ symbol: 'CME_MINI:MNQ1!', contract: 'MNQZ2026', bars: [bar(-1, 100)] }], 'MNQ', NOW);
    expect(picked).toMatchObject({ source: 'CME_MINI:MNQ1!', contract: 'MNQZ2026' });
  });

  it('roll: jiný kontrakt soubor nahradí (žádná řada ze dvou kontraktů)', () => {
    const ibkrZ = file('IBKR:MNQZ2026', 'MNQZ2026', [bar(-3, 100), bar(-2, 101)]);
    const ibkrH = file('IBKR:MNQH2027', 'MNQH2027', [bar(-1, 400)]);
    expect(mergeLiveBarsFile(ibkrZ, ibkrH)).toEqual([bar(-1, 400)]);
    const tvZ = file('CME_MINI:MNQ1!', 'MNQZ2026', [bar(-1, 101.25)]);
    expect(mergeLiveBarsFile(ibkrH, tvZ)).toEqual([bar(-1, 101.25)]);
  });

  it('TV do souboru z IBKR (stejný kontrakt) jen doplní chybějící minuty, svíčky IBKR nepřepíše', () => {
    const ibkr = file('IBKR:MNQZ2026', 'MNQZ2026', [bar(-3, 100, 50), bar(-2, 101, 60)]);
    const tv = file('CME_MINI:MNQ1!', 'MNQZ2026', [bar(-2, 999, 1), bar(-1, 102, 5)]);
    expect(mergeLiveBarsFile(ibkr, tv)).toEqual([bar(-3, 100, 50), bar(-2, 101, 60), bar(-1, 102, 5)]);
  });

  it('IBKR po TV (stejný kontrakt): pozdější čtení vyhrává', () => {
    const tv = file('CME_MINI:MNQ1!', 'MNQZ2026', [bar(-3, 100, 1), bar(-2, 101, 1)]);
    const ibkr = file('IBKR:MNQZ2026', 'MNQZ2026', [bar(-2, 101.5, 60), bar(-1, 102, 70)]);
    expect(mergeLiveBarsFile(tv, ibkr)).toEqual([bar(-3, 100, 1), bar(-2, 101.5, 60), bar(-1, 102, 70)]);
  });

  it('neznámý kontrakt při změně zdroje = nahradit; TV↔TV bez kontraktu = dnešní slučování', () => {
    const oldTv = file('CME_MINI:MNQ1!', null, [bar(-3, 100), bar(-2, 101)]);
    const ibkr = file('IBKR:MNQZ2026', 'MNQZ2026', [bar(-1, 102)]);
    expect(mergeLiveBarsFile(oldTv, ibkr)).toEqual([bar(-1, 102)]);
    const ibkrFile = file('IBKR:MNQZ2026', 'MNQZ2026', [bar(-3, 100)]);
    const tvUnknown = file('CME_MINI:MNQ1!', null, [bar(-1, 500)]);
    expect(mergeLiveBarsFile(ibkrFile, tvUnknown)).toEqual([bar(-1, 500)]);
    const tvNext = file('CME_MINI:MNQ1!', null, [bar(-2, 101.25), bar(-1, 102)]);
    expect(mergeLiveBarsFile(oldTv, tvNext)).toEqual([bar(-3, 100), bar(-2, 101.25), bar(-1, 102)]);
    expect(mergeLiveBarsFile(null, ibkr)).toEqual([bar(-1, 102)]);
  });
});

describe('INV-UI-04: soubory předběžných svíček (tv-live, tv-bars) jen pro graf dne a hodnocení', () => {
  it('zapisuje jen server relaye a čtou jen loadery grafu dne a hodnocení obchodu', () => {
    const files = execFileSync('git', ['grep', '-l', '-E', 'tvLiveBarsStoragePath|tvBarsFolder|tvBarsStoragePath|loadLiveCandles|loadProvisionalCandles|useLiveCandles'], {
      cwd: join(__dirname, '..'), encoding: 'utf8',
    }).trim().split('\n').filter(file => !file.startsWith('tests/') && !file.startsWith('docs/'));
    expect(files.sort()).toEqual([
      'components/LiveTradingScreenSlot.tsx',
      'components/TradeMarketChart.tsx',
      'hooks/useDayChartData.ts',
      'hooks/useLiveCandles.ts',
      'lib/tradingViewBars.ts',
      'server/copierSnapshotStore.ts',
      'services/liveCandles.ts',
      'services/provisionalCandles.ts',
    ].sort());
  }, 30_000);
});
