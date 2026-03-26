const axios = require('axios');

async function run() {
  // ลอง laosassociationlottery.com ด้วย date filter
  const dates = ['2026-03-21', '2026-03-20', '2026-03-19', '2026-01-01'];
  
  for (const date of dates) {
    const urls = [
      `https://laosassociationlottery.com/en/result/?date=${date}`,
      `https://laosassociationlottery.com/en/home/?date=${date}`,
      `https://laosassociationlottery.com/en/results/?date=${date}`,
    ];
    for (const url of urls) {
      try {
        const r = await axios.get(url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TigerLottoBot/1.0)' }
        });
        const dates_found = r.data.match(/\w+day,\s+\d+\s+\w+\s+\d{4}/g);
        const digits = r.data.match(/>\s*(\d)\s*<\/span>/g);
        console.log(`${url}`);
        console.log(`  dates: ${dates_found?.slice(0,2).join(', ')}`);
        console.log(`  digit spans: ${digits?.length}`);
      } catch(e) { /* silent */ }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  
  // ลอง API endpoint ของ laosassociationlottery
  const apiUrls = [
    'https://laosassociationlottery.com/api/results',
    'https://laosassociationlottery.com/en/api/results',
    'https://laosassociationlottery.com/api/lottery/latest',
  ];
  
  for (const url of apiUrls) {
    try {
      const r = await axios.get(url, {timeout:6000, headers:{'User-Agent':'Mozilla/5.0'}});
      console.log(`API ${url}: status=${r.status}, data=${JSON.stringify(r.data).slice(0,100)}`);
    } catch(e) { console.log(`API ${url}: FAIL`); }
  }
}
run();
