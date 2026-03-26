// test แค่ 3 วัน ก่อนรัน seed จริง
const axios = require('axios');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchGovResult(dd, mm, yyyy) {
  const thYear = yyyy + 543;
  const url = `https://news.sanook.com/lotto/check/${String(dd).padStart(2,'0')}${String(mm).padStart(2,'0')}${thYear}`;
  const r = await axios.get(url, { timeout:12000, headers:{'User-Agent':'Mozilla/5.0'} });
  const text = r.data.replace(/<[^>]+>/g, '\n');
  const firstMatch = text.match(/รางวัลที่ 1[^\n]*\n+(\d{6})/);
  const back2Match  = text.match(/เลขท้าย 2 ตัว[^\n]*\n+(\d{2})/);
  const back3Match  = text.match(/เลขท้าย 3 ตัว[^\n]*\n+(\d{3})/);
  const front3Match = text.match(/เลขหน้า 3 ตัว[^\n]*\n+(\d{3})[^\n]*\n+(\d{3})/);
  if (!firstMatch) return null;
  return {
    result_first: firstMatch[1],
    result_2_back: back2Match?.[1] || firstMatch[1].slice(-2),
    result_3_back1: back3Match?.[1] || null,
    result_3_front1: front3Match?.[1] || null,
    result_3_front2: front3Match?.[2] || null,
  };
}

async function fetchLaoResult(dd, mm, yyyy) {
  const thYear = yyyy + 543;
  const url = `https://www.sanook.com/news/archive/laolotto/?date=${String(dd).padStart(2,'0')}%2F${String(mm).padStart(2,'0')}%2F${thYear}`;
  const r = await axios.get(url, { timeout:12000, headers:{'User-Agent':'Mozilla/5.0'} });
  const html = r.data;
  const match4 = html.match(/เลข\s*4\s*ตัว\s*:\s*(\d{4})/);
  if (!match4) return null;
  const first = match4[1];
  return { result_first: first, result_2_back: first.slice(-2), result_3_back1: first.slice(-3) };
}

async function run() {
  // ทดสอบหวยรัฐบาล งวดล่าสุด
  console.log('=== GOV TEST ===');
  for (const [d,m,y] of [[16,3,2026],[1,3,2026],[16,2,2026]]) {
    try {
      const res = await fetchGovResult(d,m,y);
      console.log(`${d}/${m}/${y}:`, res ? `✅ ${res.result_first} | back2=${res.result_2_back} | back3=${res.result_3_back1} | front3=${res.result_3_front1},${res.result_3_front2}` : '❌ no result');
    } catch(e) { console.log(`${d}/${m}/${y}: ❌`, e.message.slice(0,50)); }
    await sleep(1000);
  }

  // ทดสอบหวยลาว
  console.log('\n=== LAO TEST ===');
  for (const [d,m,y] of [[24,3,2026],[21,3,2026],[20,3,2026]]) {
    try {
      const res = await fetchLaoResult(d,m,y);
      console.log(`${d}/${m}/${y}:`, res ? `✅ ${res.result_first}` : '❌ no result');
    } catch(e) { console.log(`${d}/${m}/${y}: ❌`, e.message.slice(0,50)); }
    await sleep(1000);
  }
}

run();
