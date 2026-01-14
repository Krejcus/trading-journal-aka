
async function verify() {
    const url = 'https://alphatrade-mentor-15.vercel.app/api/candles?instrument=NQ&from=2024-12-01&to=2024-12-30&cacheOnly=true';
    console.log(`Testing URL: ${url}`);

    try {
        const start = Date.now();
        const res = await fetch(url);
        const data = await res.json();
        const end = Date.now();

        console.log(`Status: ${res.status}`);
        console.log(`Candles returned: ${data.length}`);
        console.log(`Time taken: ${end - start}ms`);

        if (data.length > 1000) {
            console.log('✅ SUCCESS: API returned more than 1000 rows!');
        } else {
            console.log('❌ FAILURE: API still limited to 1000 rows or no data found.');
        }
    } catch (e) {
        console.error('Fetch error:', e);
    }
}

verify();
