import { CandlestickData, Time } from 'lightweight-charts';

type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | 'D';

export const aggregateCandles = (data: CandlestickData[], timeframe: Timeframe): CandlestickData[] => {
    if (timeframe === '1m') return data;

    const minutesMap: Record<Timeframe, number> = {
        '1m': 1,
        '5m': 5,
        '15m': 15,
        '1h': 60,
        '4h': 240,
        'D': 1440
    };

    const periodSeconds = minutesMap[timeframe] * 60;
    const aggregated: CandlestickData[] = [];

    let currentBucketStart: number | null = null;
    let bucket: CandlestickData[] = [];

    // Assuming data is sorted by time
    data.forEach((candle) => {
        const time = candle.time as number; // Assuming timestamp in seconds

        // Calculate bucket start (floor to nearest period)
        const bucketStart = Math.floor(time / periodSeconds) * periodSeconds;

        if (currentBucketStart === null) {
            currentBucketStart = bucketStart;
        }

        if (bucketStart !== currentBucketStart) {
            // Process previous bucket
            if (bucket.length > 0) {
                aggregated.push(buildCandle(bucket, currentBucketStart));
            }
            // Start new bucket
            currentBucketStart = bucketStart;
            bucket = [candle];
        } else {
            bucket.push(candle);
        }
    });

    // Process last bucket
    if (bucket.length > 0 && currentBucketStart !== null) {
        aggregated.push(buildCandle(bucket, currentBucketStart));
    }

    return aggregated;
};

const buildCandle = (candles: CandlestickData[], time: number): CandlestickData => {
    const open = candles[0].open;
    const close = candles[candles.length - 1].close;
    let high = -Infinity;
    let low = Infinity;

    candles.forEach(c => {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
    });

    return {
        time: time as Time,
        open,
        high,
        low,
        close
    };
};
