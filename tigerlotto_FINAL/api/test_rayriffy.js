const axios = require('axios');

async function run() {
  const base = 'https://lotto.api.rayriffy.com';
  
  // test latest
  try {
    const r = await axios.get(`${base}/latest`, { timeout: 10000 });
    console.log('latest:', JSON.stringify(r.data).slice(0, 300));
  } catch(e) { console.log('latest failed:', e.message); }

  // test by date - หวยไทยงวด 1 มี.ค. 69 = 2026-03-01
  const dates = ['2026-03-01', '2026-02-16', '2026-02-01', '2026-01-16', '2026-01-01'];
  for (const d of dates) {
    try {
      const r = await axios.get(`${base}/${d}`, { timeout: 8000 });
      const first = r.data?.response?.prizes?.find(p => p.id === 'prizeFirst');
      console.log(`${d}: prizeFirst = ${first?.number?.[0]}`);
    } catch(e) { console.log(`${d}: FAIL - ${e.message.slice(0,40)}`); }
  }
}
run();
