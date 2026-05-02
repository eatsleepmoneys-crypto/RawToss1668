// Quick test: ดึงแค่ 3 งวด ก่อนรัน seed จริง
const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArticleBody(html) {
  const m = html.match(/"articleBody"\s*:\s*"([\s\S]+?)"\s*,\s*"author"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch(e) {
    return m[1].replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/&nbsp;/g,' ');
  }
}

async function run() {
  console.log('=== GOV TEST ===');
  for (const [d,m,y] of [[1,3,2026],[16,2,2026],[1,2,2026]]) {
    const thYear = y + 543;
    const url = `https://news.sanook.com/lotto/check/${String(d).padStart(2,'0')}${String(m).padStart(2,'0')}${thYear}`;
    try {
      const r = await axios.get(url, {timeout:10000, headers:{'User-Agent':'Mozilla/5.0'}});
      const body = parseArticleBody(r.data);
      if (body) {
        const first = body.match(/รางวัลที่ 1[^\r\n]*[\r\n]+(\d{6})/);
        const back2 = body.match(/เลขท้าย 2 ตัว[^\r\n]*[\r\n]+(\d{2})/);
        const back3 = body.match(/เลขท้าย 3 ตัว[^\r\n]*[\r\n]+([\d &;nbsp]+)/);
        const front3= body.match(/เลขหน้า 3 ตัว[^\r\n]*[\r\n]+([\d &;nbsp]+)/);
        console.log(`${d}/${m}/${y}: first=${first?.[1]} back2=${back2?.[1]} back3="${back3?.[1]?.trim().slice(0,20)}" front3="${front3?.[1]?.trim().slice(0,20)}"`);
      } else { console.log(`${d}/${m}/${y}: no articleBody`); }
    } catch(e) { console.log(`${d}/${m}/${y}: ERR`, e.message.slice(0,50)); }
    await sleep(1000);
  }

  console.log('\n=== LAO TEST ===');
  for (const [d,m,y] of [[24,3,2026],[21,3,2026],[20,3,2026]]) {
    const thYear = y + 543;
    const url = `https://www.sanook.com/news/archive/laolotto/?date=${String(d).padStart(2,'0')}%2F${String(m).padStart(2,'0')}%2F${thYear}`;
    try {
      const r = await axios.get(url, {timeout:10000, headers:{'User-Agent':'Mozilla/5.0'}});
      const match4 = r.data.match(/เลข\s*4\s*ตัว\s*:\s*(\d{4})/);
      console.log(`${d}/${m}/${y}: 4-digit=${match4?.[1] || 'not found'}`);
    } catch(e) { console.log(`${d}/${m}/${y}: ERR`, e.message.slice(0,50)); }
    await sleep(1000);
  }

  console.log('\n=== HANOI TEST ===');
  for (const [d,m,y] of [[24,3,2026],[21,3,2026]]) {
    const thYear = y + 543;
    const url = `https://www.sanook.com/news/archive/hanoi-lottery/?date=${String(d).padStart(2,'0')}%2F${String(m).padStart(2,'0')}%2F${thYear}`;
    try {
      const r = await axios.get(url, {timeout:10000, headers:{'User-Agent':'Mozilla/5.0'}});
      const matches4 = [...r.data.matchAll(/เลข\s*4\s*ตัว\s*:\s*(\d{4})/g)];
      console.log(`${d}/${m}/${y}: found ${matches4.length} 4-digit numbers:`, matches4.map(m=>m[1]).join(', '));
    } catch(e) { console.log(`${d}/${m}/${y}: ERR`, e.message.slice(0,50)); }
    await sleep(1000);
  }
}

run();
