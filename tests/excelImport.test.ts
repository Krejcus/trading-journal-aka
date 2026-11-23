import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import { formatExcelCell, isLegacyXlsFile, LEGACY_XLS_MESSAGE } from '../services/excelImport';

describe('Excel import compatibility', () => {
  it('odmítá starý binární .xls, ale přijímá .xlsx bez ohledu na velikost písmen', () => {
    expect(isLegacyXlsFile('orders.xls')).toBe(true);
    expect(isLegacyXlsFile('ORDERS.XLS')).toBe(true);
    expect(isLegacyXlsFile('orders.xlsx')).toBe(false);
    expect(LEGACY_XLS_MESSAGE).toContain('ulož ho jako .xlsx');
  });

  it('normalizuje typované buňky na stringy a zachová excelový wall-clock čas', () => {
    expect(formatExcelCell(29461.75)).toBe('29461.75');
    expect(formatExcelCell(true)).toBe('true');
    expect(formatExcelCell(null)).toBe('');
    expect(formatExcelCell(new Date(Date.UTC(2026, 6, 16, 16, 40, 5))))
      .toBe('2026-07-16 16:40:05');
  });
});
