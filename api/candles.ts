import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getHistoricRates, Config } from 'dukascopy-node';

export default async function handler(
    request: VercelRequest,
    response: VercelResponse
) {
    try {
        const { instrument, date, timeframe = 'm1' } = request.query;

        if (!instrument || !date) {
            return response.status(400).json({ error: 'Missing instrument or date' });
        }

        const tradeDate = new Date(String(date));
        if (isNaN(tradeDate.getTime())) {
            return response.status(400).json({ error: 'Invalid date format' });
        }

        // Define time window: 2 hours before, 4 hours after
        const fromDate = new Date(tradeDate.getTime() - 2 * 60 * 60 * 1000);
        const toDate = new Date(tradeDate.getTime() + 4 * 60 * 60 * 1000);

        // Map instrument to Dukascopy format if needed
        // Simple mapping for common indices, can be expanded
        let dukaInstrument = String(instrument).toLowerCase().replace('/', '').replace('-', '');

        // Explicit mapping for common instruments in the app
        const map: Record<string, string> = {
            'nq': 'usatechidxusd',
            'mnq': 'usatechidxusd',
            'es': 'usa500idxusd',
            'mes': 'usa500idxusd',
            'eurusd': 'eurusd',
            'gbpusd': 'gbpusd',
            'xauusd': 'xauusd',
            'gold': 'xauusd',
            'btc': 'btcusd',
            'btcusd': 'btcusd',
        };

        if (map[dukaInstrument]) {
            dukaInstrument = map[dukaInstrument];
        }

        console.log(`Fetching data for ${dukaInstrument} from ${fromDate.toISOString()} to ${toDate.toISOString()}`);

        const config: Config = {
            instrument: dukaInstrument as any,
            dates: {
                from: fromDate,
                to: toDate,
            },
            timeframe: 'm1', // Always m1 for replay precision
            format: 'json',
            useCache: false
        };

        const data = await getHistoricRates(config);

        // Transform to lightweight-charts format
        const candles = data.map((d: any) => ({
            time: d.timestamp / 1000, // Unix timestamp in seconds
            open: d.open,
            high: d.high,
            low: d.low,
            close: d.close,
            volume: d.tickVolume
        }));

        return response.status(200).json(candles);

    } catch (error: any) {
        console.error('Dukascopy fetch error:', error);
        return response.status(500).json({
            error: 'Failed to fetch data',
            details: error.message
        });
    }
}
