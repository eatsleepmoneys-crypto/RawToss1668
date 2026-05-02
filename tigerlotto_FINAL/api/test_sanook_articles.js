const axios = require('axios');

async function run() {
  // เข้าบทความโดยตรง
  const articleUrls = [
    'https://www.sanook.com/news/9878546/',
    'https://www.sanook.com/news/9878482/',
    'https://www.sanook.com/news/9767794/',
  ];
  
  for (const url of articleUrls) {
    try {
      const r = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }
      });
      const html = r.data;
      const match4 = html.match(/เลข\s*4\s*ตัว\s*[:\s]*(\d{4})/);
      const title = html.match(/<title>([^<]+)<\/title>/);
      console.log(`\n${url}`);
      console.log('  title:', title?.[1]?.slice(0,60));
      console.log('  4-digit:', match4?.[1] || 'not found');
      
      // หา articleBody
      const bodyMatch = html.match(/"articleBody"\s*:\s*"([\s\S]{0,500})/);
      if (bodyMatch) {
        console.log('  articleBody snippet:', bodyMatch[1].slice(0,200).replace(/\\r\\n/g,' '));
      }
    } catch(e) { console.log(url, 'FAIL:', e.message.slice(0,40)); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
run();
