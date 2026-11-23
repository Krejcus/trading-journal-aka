import { describe,it,expect } from 'vitest';
import { explicitCmeTradeDate,cmeDisplayTradeDate } from '../lib/cmeDisplayDay';
describe('display trade date',()=>{
 it('rolls at Chicago session boundary, independent of browser midnight',()=>{
  expect(cmeDisplayTradeDate(Date.parse('2026-09-10T21:59:59Z'))).toBe('2026-09-10');
  expect(cmeDisplayTradeDate(Date.parse('2026-09-10T22:00:00Z'))).toBe('2026-09-11');
  expect(cmeDisplayTradeDate(Date.parse('2026-09-11T01:00:00Z'))).toBe('2026-09-11');
  expect(cmeDisplayTradeDate(Date.parse('2026-01-10T22:59:59Z'))).toBe('2026-01-10');
  expect(cmeDisplayTradeDate(Date.parse('2026-01-10T23:00:00Z'))).toBe('2026-01-11');
 });
 it('requires a real explicit broker date',()=>{
  expect(explicitCmeTradeDate({year:2026,month:2,day:30})).toBeNull();
  expect(explicitCmeTradeDate(undefined)).toBeNull();
  expect(explicitCmeTradeDate({year:2026,month:9,day:11})).toBe('2026-09-11');
 });
});
