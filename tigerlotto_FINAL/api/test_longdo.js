const axios = require('axios');

async function run() {
  const urls = [
    'https://check.longdo.com/lotto/',
    'https://data.longdo.com/api/lottery/latest',
    'https://check.longdo.com/lotto/api/latest',
    'https://check.longdo.com/lotto/result.json',
  ];

  for (const url of urls) {
    try {
      const r = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const text = typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300);
      console.log(`✅ ${url} =>`, text);
    } catch (e) {
      console.log(`❌ ${url} =>`, e.message.slice(0, 60));
    }
  }

  // ลอง check.longdo.com/lotto/ แบบ scrape
  try {
    const r = await axios.get('https://check.longdo.com/lotto/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
    });
    const html = r.data;
    // หา pattern ผลรางวัล
    const first = html.match(/รางวัลที่ 1[\s\S]{0,200}/);
    if (first) console.log('\nfirst prize section:', first[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));

    // หา 6 digit ใน context ที่เกี่ยวกับหวย
    const idx = html.indexOf('รางวัล');
    if (idx > -1) {
      const section = html.slice(idx, idx + 2000);
      const nums6 = section.match(/\b\d{6}\b/g);
      console.log('6-digit in lottery section:', [...new Set(nums6 || [])].slice(0, 10));
    }
  } catch (e) {
    console.log('longdo scrape failed:', e.message);
  }
}

run();
