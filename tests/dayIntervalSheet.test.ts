import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { customTimeframeFromDraft, timeframeTitle } from '../components/ChartTimeframePicker';

describe('list intervalů na telefonu', () => {
  it('vlastní interval z formuláře: 60 minut = 1h, mimo limity nic', () => {
    expect(customTimeframeFromDraft('7', 'm')).toBe('7m');
    expect(customTimeframeFromDraft('90', 'm')).toBe('90m');
    expect(customTimeframeFromDraft('120', 'm')).toBe('2h');
    expect(customTimeframeFromDraft('2', 'h')).toBe('2h');
    expect(customTimeframeFromDraft('0', 'm')).toBeNull();
    expect(customTimeframeFromDraft('24', 'h')).toBeNull();
    expect(customTimeframeFromDraft('1.5', 'h')).toBeNull();
    expect(customTimeframeFromDraft('', 'm')).toBeNull();
  });

  it('názvy intervalů pro kolečko', () => {
    expect(timeframeTitle('1m')).toBe('1 minuta');
    expect(timeframeTitle('4h')).toBe('4 hodiny');
    expect(timeframeTitle('7m')).toBe('7 minut');
  });

  it('klepnutí na čip intervalu otevře list, nepřepíná na další interval', () => {
    const source = readFileSync(new URL('../components/day/DayFullscreenChart.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/onTap=\{\(\) => setIntervalSheet\(true\)\}/);
    expect(source).not.toMatch(/onChange\(cycleDayChartTimeframe\(value, 1\)\)/);
    expect(source).toMatch(/<DayIntervalSheet/);
  });
});
