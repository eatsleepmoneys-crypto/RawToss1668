const axios = require('axios');

async function run() {
  const url = 'https://news.sanook.com/lotto/check/01032569';
  const r = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
  });
  const html = r.data;
  
  // หา JSON data ใน page
  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  if (scriptMatches) {
    for (const s of scriptMatches) {
      if (s.includes('prize') || s.includes('number') || s.includes('lotto')) {
        console.log('Found script with prize/number:', s.slice(0, 300));
        break;
      }
    }
  }
  
  // หาตัวเลข 6 หลักในส่วนที่น่าจะเป็น prize
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const idx = text.indexOf('รางวัล');
  if (idx > -1) {
    console.log('\nPrize section:', text.slice(idx, idx + 500));
  }
  
  // หา 6 digit ทั้งหมด
  const nums = html.match(/\b\d{6}\b/g);
  console.log('\nAll 6-digit:', [...new Set(nums || [])].slice(0, 10));
  
  // หา pattern JSON-like
  const jsonLike = html.match(/"number"\s*:\s*"(\d{6})"/g);
  console.log('\nJSON number patterns:', jsonLike?.slice(0, 5));
  
  // ดู HTML ส่วนผล
  const prizeSection = html.match(/class="[^"]*prize[^"]*"[\s\S]{0,500}/g);
  if (prizeSection) {
    console.log('\nPrize CSS class:', prizeSection[0].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,200));
  }
}

run().catch(e => console.error(e.message));
