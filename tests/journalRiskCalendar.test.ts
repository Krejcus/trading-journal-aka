import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import DashboardCalendar from '../components/DashboardCalendar';
import type { Trade, User } from '../types';

const calendar = (trades: Trade[], pnlFormat: 'usd' | 'rr' = 'rr', resultsHidden = false) => renderToStaticMarkup(React.createElement(DashboardCalendar, {
    trades, preps: [], reviews: [], theme: 'light', accounts: [], initialBalance: 0, emotions: [],
    pnlFormat, resultsHidden, user: { currency: 'USD' } as User, exchangeRates: null,
}));
const trade = (pnl: number, riskAmount?: number, extra: Partial<Trade> = {}): Trade => ({
    id: 'calendar', date: '2026-09-10T13:42:30.123Z', timestamp: Date.parse('2026-09-10T13:42:30.123Z'),
    pnl, riskAmount, ...extra,
} as Trade);

describe('journal R calendar rendering', () => {
    it('renders unknown day, week and month without a fake 0R or dollar fallback', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
            const html = calendar([trade(15.76, 10, { copierTradeId: 'journal:example' })]);
            expect(html).toContain('—');
            expect((html.match(/>—</g) ?? []).length).toBeGreaterThanOrEqual(4);
            expect(html).not.toMatch(/(?:1\.6|1\.58)R/);
            expect(html).not.toContain('$16');
            expect(html).not.toContain('rgba(16, 185, 129');
        } finally { vi.useRealTimers(); }
    });
    it('keeps unknown money neutral without poisoning a known adjacent day', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
            const html = calendar([trade(Number.NaN), trade(25, undefined, {date:'2026-09-11T13:42:30.123Z'})], 'usd');
            expect(html).not.toMatch(/NaN|Infinity|rgba\(244, 63, 94/);
            expect((html.match(/>—</g) ?? []).length).toBeGreaterThanOrEqual(4);
            expect(html).toContain('+$25');
            expect(html).toContain('rgba(16, 185, 129');
        } finally { vi.useRealTimers(); }
    });
    it('does not label empty hidden periods as zero dollars', () => {
        const html = calendar([], 'usd', true);
        expect(html).toContain('—');
        expect(html).not.toContain('$0');
        expect(html).not.toMatch(/NaN|Infinity/);
    });
    it('uses R sign even when money has the opposite sign, excluding missed results', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
            const html = calendar([trade(100, 100), trade(-20, 1), trade(1e6, undefined, { executionStatus: 'Missed' })]);
            expect(html).toContain('-19R');
            expect(html).toContain('rgba(244, 63, 94');
            expect(html).not.toContain('+80R');
        } finally { vi.useRealTimers(); }
    });
});
