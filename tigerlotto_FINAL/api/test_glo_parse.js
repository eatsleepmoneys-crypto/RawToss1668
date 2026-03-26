const axios = require('axios');

async function run() {
  const r = await axios.get('https://www.glo.or.th/result/lotterynumber', {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
      'Accept': 'text/html',
      'Referer': 'https://www.glo.or.th/'
    }
  });

  const html = r.data;

  // หา JSON data ใน Nuxt page
  // pattern 1: __NUXT_DATA__
  let dataBlock = null;
  const nuxtMatch = html.match(/\{[^{}]*"prizeFirst"[^{}]*\}/);
  if (nuxtMatch) {
    console.log('nuxt block:', nuxtMatch[0].slice(0, 300));
  }

  // pattern 2: หา JSON array ที่มีเลขรางวัล
  const jsonBlocks = html.match(/\["\d{6}"[^\]]*\]/g);
  if (jsonBlocks) {
    console.log('json arrays with 6-digit:', jsonBlocks.slice(0, 3));
  }

  // pattern 3: หา data-* attributes ที่มีเลข
  const dataAttrs = html.match(/data-[a-z]+="(\d{6})"/g);
  if (dataAttrs) console.log('data attrs:', dataAttrs.slice(0, 5));

  // pattern 4: หา class ที่มักใช้กับผลหวย
  const lotto1st = html.match(/class="[^"]*prize[^"]*"[^>]*>\s*(\d{6})/g);
  if (lotto1st) console.log('prize class:', lotto1st.slice(0, 3));

  // snippet รอบๆ เลข 6 หลักที่เจอ
  const allNums6 = [...new Set(html.match(/\b\d{6}\b/g) || [])];
  console.log('\nAll unique 6-digit numbers:', allNums6.slice(0, 10));

  // หา context รอบๆ เลขแรก
  for (const num of allNums6.slice(0, 3)) {
    const idx = html.indexOf(num);
    const context = html.slice(Math.max(0, idx - 100), idx + 100).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    console.log(`\nContext around ${num}:`, context);
  }
}

run().catch(e => console.error(e.message));
