const axios = require('axios');

async function run() {
  // ลอง glo.or.th
  try {
    const r = await axios.get('https://www.glo.or.th/result/lotterynumber', {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html',
        'Referer': 'https://www.glo.or.th/'
      }
    });
    const html = r.data;
    const nums6 = html.match(/\b\d{6}\b/g);
    console.log('glo 6-digit:', nums6 ? [...new Set(nums6)].slice(0, 5) : 'none');
    // หา first prize
    const m = html.match(/"prizeFirst"\s*:\s*"(\d+)"/);
    const m2 = html.match(/"first"\s*:\s*"(\d+)"/);
    const m3 = html.match(/รางวัลที่ 1[\s\S]{0,100}/);
    console.log('prizeFirst:', m?.[1]);
    console.log('first:', m2?.[1]);
    console.log('snippet:', m3?.[0]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 100));
  } catch (e) {
    console.error('glo failed:', e.message);
  }

  // ลอง API อื่น
  const apis = [
    'https://api.checklotterythai.com/latest',
    'https://lotto-api.th-lottery.com/latest',
  ];
  for (const url of apis) {
    try {
      const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      console.log(url, '=>', JSON.stringify(r.data).slice(0, 200));
    } catch (e) {
      console.log(url, '=> FAIL:', e.message.slice(0, 50));
    }
  }
}
run();
