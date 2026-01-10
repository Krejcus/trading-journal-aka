
import { getHistoricRates } from 'dukascopy-node';

async function testFetch() {
    try {
        const instrument = 'usatechidxusd';
        const dateStr = '2025-01-09T15:00:00.000Z'; // Jan 9th, 2025
        const tradeDate = new Date(dateStr);

        const fromDate = new Date(tradeDate.getTime() - 2 * 60 * 60 * 1000);
        const toDate = new Date(tradeDate.getTime() + 4 * 60 * 60 * 1000);

        console.log(`Fetching ${instrument} from ${fromDate.toISOString()} to ${toDate.toISOString()}`);

        const data = await getHistoricRates({
            instrument: instrument,
            dates: { from: fromDate, to: toDate },
            timeframe: 'm1',
            format: 'json',
            useCache: false
        });

        console.log(`Received ${data.length} candles.`);
        if (data.length > 0) {
            console.log('First candle:', data[0]);
            console.log('Last candle:', data[data.length - 1]);
        }

        // Validate sorting
        let isSorted = true;
        for (let i = 1; i < data.length; i++) {
            if (data[i].timestamp <= data[i - 1].timestamp) {
                isSorted = false;
                console.error(`Unsorted data at index ${i}: ${data[i - 1].timestamp} >= ${data[i].timestamp}`);
                break;
            }
        }
        console.log('Is sorted:', isSorted);

    } catch (error) {
        console.error('Error:', error);
    }
}

testFetch();
