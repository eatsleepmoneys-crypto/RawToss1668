const axios = require('axios');

async function run() {
  // ลอง Sanook laolotto - หาบทความ
  try {
    const r = await axios.get('https://www.sanook.com/news/archive/laolotto/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
    });
    
    // หา URLs บทความข่าว
    const links = r.data.match(/href="(https?:\/\/www\.sanook\.com\/news\/\d+\/)"/g);
    console.log('Article links:', links?.slice(0,5));
    
    // หา pattern ต่างๆ 
    const text = r.data.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    // หา 4-digit
    const matches4 = text.match(/\bเลข 4 ตัว\s*:\s*(\d{4})\b/g);
    console.log('4-digit patterns:', matches4?.slice(0,3));
    
    // ลอง URL อื่น
    const urls2test = [
      'https://www.sanook.com/horoscope/lotto/laolotto/',
      'https://www.sanook.com/news/9837000/',
    ];
    for (const url of urls2test) {
      try {
        const r2 = await axios.get(url, {timeout:8000, headers:{'User-Agent':'Mozilla/5.0'}});
        const m4 = r2.data.match(/เลข\s*4\s*ตัว\s*:\s*(\d{4})/);
        console.log(url, '=> 4-digit:', m4?.[1] || 'not found', '| status:', r2.status);
      } catch(e2) { console.log(url, '=> FAIL:', e2.message.slice(0,40)); }
    }
  } catch(e) { console.error(e.message); }

  // ลอง API ใหม่ - หวยลาว direct
  const laourls = [
    'https://laosassociationlottery.com/en/results/',
    'https://laosassociationlottery.com/en/history/',
    'https://www.laolottery.live/',
  ];
  for (const url of laourls) {
    try {
      const r = await axios.get(url, {timeout:8000, headers:{'User-Agent':'Mozilla/5.0'}});
      const dates = r.data.match(/\d{1,2}\s+\w+\s+\d{4}/g);
      console.log(`\n${url} => dates:`, dates?.slice(0,3), '| len:', r.data.length);
    } catch(e) { console.log(`${url} => FAIL: ${e.message.slice(0,40)}`); }
  }
}
run();
