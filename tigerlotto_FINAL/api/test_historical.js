const axios = require('axios');

async function run() {
  // ทดสอบหวยลาวย้อนหลัง - laosassociationlottery.com มี pagination
  try {
    const r = await axios.get('https://laosassociationlottery.com/en/home/?page=2', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TigerLottoBot/1.0)' }
    });
    const html = r.data;
    // หา date+result rows ในตาราง
    const rows = html.match(/(\w+day,\s+\d+\s+\w+\s+\d{4})[\s\S]{0,500}?(\d)\s*<\/span>[\s\S]{0,30}?(\d)\s*<\/span>[\s\S]{0,30}?(\d)\s*<\/span>[\s\S]{0,30}?(\d)\s*<\/span>/gi);
    console.log('Lao page 2 rows count:', rows?.length);
    // หา date pattern
    const dates = html.match(/\w+day,\s+\d+\s+\w+\s+\d{4}/g);
    console.log('Lao dates found:', dates?.slice(0, 5));
  } catch(e) { console.log('Lao historical:', e.message); }

  // ทดสอบหวยรัฐบาลจาก GLO ย้อนหลัง
  try {
    const r = await axios.post('https://www.glo.or.th/api/checking/getcheckLotteryResult',
      { number: [{ lottery_num: '000001' }], period_date: '2026-01-01' },
      { timeout: 10000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    console.log('\nGov API test:', JSON.stringify(r.data).slice(0, 200));
  } catch(e) { console.log('Gov API:', e.message); }

  // ทดสอบ Hanoi ย้อนหลัง sanook
  try {
    const r = await axios.get('https://www.sanook.com/news/9830000/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    console.log('\nSanook hanoi historical status:', r.status);
  } catch(e) { console.log('Sanook hanoi historical:', e.message); }
}
run();
