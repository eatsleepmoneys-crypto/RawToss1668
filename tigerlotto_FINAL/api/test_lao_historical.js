const axios = require('axios');

async function testLaoHistorical() {
  // ลอง fetch หลายๆ page จาก laosassociationlottery.com
  for (let page = 1; page <= 3; page++) {
    try {
      const url = page === 1 
        ? 'https://laosassociationlottery.com/en/home/'
        : `https://laosassociationlottery.com/en/home/?page=${page}`;
      
      const r = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TigerLottoBot/1.0)' }
      });
      
      const html = r.data;
      const dates = html.match(/\w+day,\s+\d+\s+\w+\s+\d{4}/g);
      console.log(`Page ${page}: ${dates?.length || 0} dates:`, dates?.slice(0, 3));
      
      // หา pattern ตาราง: Date | 1st | 2nd | 3rd
      // pattern: date row ใน table
      const tableRows = html.match(/<tr[\s\S]{0,1000}?<\/tr>/g);
      if (tableRows) {
        console.log(`  Table rows: ${tableRows.length}`);
        // หาแถวที่มี date + เลข
        const dataRows = tableRows.filter(r => r.match(/\d{4}/) && r.match(/\w+day/));
        console.log(`  Data rows: ${dataRows.length}`);
        if (dataRows[0]) {
          const sample = dataRows[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          console.log(`  Sample row: ${sample.slice(0, 150)}`);
        }
      }
    } catch(e) {
      console.log(`Page ${page} failed:`, e.message);
    }
  }
}

testLaoHistorical();
