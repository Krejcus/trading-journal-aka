import { NextResponse } from 'next/server';
// Use require to avoid ESM/CJS interop issues
const pkg = require('yahoo-finance2');
// Try to get the class or instance
const YahooFinance = pkg.default || pkg;

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'NQ=F';
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const interval = searchParams.get('interval') || '15m';

    if (!from || !to) {
        return NextResponse.json({ error: 'Missing from/to parameters' }, { status: 400 });
    }

    try {
        const queryOptions = {
            period1: new Date(parseInt(from) * 1000), // Convert seconds to Date
            period2: new Date(parseInt(to) * 1000),
            interval: interval as any, // 1m, 2m, 5m, 15m, 1d, etc.
        };

        // Attempt to instantiate if it's a class, or use as instance
        let yf;
        try {
            yf = new YahooFinance();
        } catch (e) {
            // If it's not a constructor, it might be the instance already
            yf = YahooFinance;
        }

        const result = await yf.chart(symbol, queryOptions);

        if (!result || !result.quotes) {
            return NextResponse.json({ error: 'No data found' }, { status: 404 });
        }

        // Map to Lightweight Charts format
        const candles = result.quotes.map((quote: any) => ({
            time: Math.floor(new Date(quote.date).getTime() / 1000), // UNIX timestamp in seconds
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.close,
        })).filter((c: any) => c.open !== null); // Filter out incomplete candles

        return NextResponse.json({ candles });
    } catch (error: any) {
        console.error('Yahoo Finance Error:', error);
        // If it's the specific "Call new YahooFinance()" error, try one more fallback
        if (error.message && error.message.includes('new YahooFinance')) {
            return NextResponse.json({ error: 'Library initialization error. Please restart server.' }, { status: 500 });
        }
        return NextResponse.json({ error: error.message || 'Failed to fetch data' }, { status: 500 });
    }
}
