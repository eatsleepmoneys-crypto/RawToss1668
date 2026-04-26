const { query, queryOne } = require('../config/db');

// HD Schedule: ICT times (UTC+7) mapped by lottery code
const HD_SCHEDULE = {
  // Thai stocks
  thai_am:      { name: 'หุ้นไทยเช้า',       openH:  9, openM: 30, closeH: 11, closeM: 30, emoji: '📈' },
  thai_noon:    { name: 'หุ้นไทยเที่ยง',      openH: 11, openM: 30, closeH: 14, closeM:  0, emoji: '📈' },
  thai_pm:      { name: 'หุ้นไทยบ่าย',        openH: 14, openM:  0, closeH: 15, closeM:  0, emoji: '📈' },
  thai_eve:     { name: 'หุ้นไทยเย็น',        openH: 15, openM:  0, closeH: 16, closeM: 30, emoji: '📈' },
  // Bank lotteries
  bank_stock:   { name: 'หวยธกส.',            openH:  9, openM:  0, closeH: 15, closeM:  0, emoji: '🏦' },
  gsb:          { name: 'หวยออมสิน',          openH:  9, openM:  0, closeH: 15, closeM:  0, emoji: '🏦' },
  // Foreign stocks
  stock_nk_am:  { name: 'หุ้นนิเคอิเช้า',     openH:  8, openM:  0, closeH: 11, closeM: 30, emoji: '🇯🇵' },
  stock_nk_pm:  { name: 'หุ้นนิเคอิบ่าย',     openH: 11, openM: 30, closeH: 14, closeM: 30, emoji: '🇯🇵' },
  stock_hk_am:  { name: 'หุ้นฮั่งเส็งเช้า',   openH:  9, openM:  0, closeH: 12, closeM: 30, emoji: '🇭🇰' },
  stock_hk_pm:  { name: 'หุ้นฮั่งเส็งบ่าย',   openH: 12, openM: 30, closeH: 15, closeM: 30, emoji: '🇭🇰' },
  stock_cn_am:  { name: 'หุ้นจีนเช้า',        openH:  9, openM:  0, closeH: 12, closeM: 30, emoji: '🇨🇳' },
  stock_cn_pm:  { name: 'หุ้นจีนบ่าย',        openH: 12, openM: 30, closeH: 15, closeM: 30, emoji: '🇨🇳' },
  stock_tw:     { name: 'หุ้นไต้หวัน',        openH:  8, openM:  0, closeH: 13, closeM: 30, emoji: '🇹🇼' },
  stock_kr:     { name: 'หุ้นเกาหลี',         openH:  8, openM:  0, closeH: 15, closeM: 30, emoji: '🇰🇷' },
  stock_sg:     { name: 'หุ้นสิงคโปร์',       openH:  9, openM:  0, closeH: 17, closeM:  0, emoji: '🇸🇬' },
  stock_eg:     { name: 'หุ้นอียิปต์',         openH: 13, openM:  0, closeH: 16, closeM:  0, emoji: '🇪🇬' },
  stock_de:     { name: 'หุ้นเยอรมัน',        openH: 15, openM:  0, closeH: 22, closeM:  0, emoji: '🇩🇪' },
  stock_ru:     { name: 'หุ้นรัสเซีย',         openH: 15, openM:  0, closeH: 22, closeM:  0, emoji: '🇷🇺' },
  stock_in:     { name: 'หุ้นอินเดีย',         openH: 11, openM: 30, closeH: 17, closeM:  0, emoji: '🇮🇳' },
  stock_dj:     { name: 'หุ้นดาวโจนส์',       openH: 20, openM:  0, closeH: 28, closeM: 30, emoji: '🇺🇸' }, // closeH:28 = next day 04:30
  stock_my:     { name: 'หุ้นมาเลย์',          openH:  9, openM:  0, closeH: 18, closeM: 30, emoji: '🇲🇾' },
  stock_uk:     { name: 'หุ้นอังกฤษ',         openH: 15, openM:  0, closeH: 30, closeM: 30, emoji: '🇬🇧' }, // closeH:30 = next day 06:30
  // Customs (เลขชุด)
  lao_set:      { name: 'หวยลาว (เลขชุด)',    openH:  9, openM:  0, closeH: 20, closeM: 25, emoji: '🇱🇦' },
  hanoi_set:    { name: 'หวยฮานอย (เลขชุด)', openH:  9, openM:  0, closeH: 18, closeM: 30, emoji: '🇻🇳' },
  malay_set:    { name: 'หวยมาเลย์ (เลขชุด)', openH:  9, openM:  0, closeH: 18, closeM: 30, emoji: '🇲🇾' },
};

/**
 * Convert ICT (UTC+7) time to UTC Date object
 * @param {number} year - YYYY
 * @param {number} month - 1-12
 * @param {number} day - 1-31
 * @param {number} hour - hour in ICT (0-30, where >24 means next day)
 * @param {number} minute - minute (0-59)
 * @returns {Date} UTC Date object
 */
function ictToUTC(year, month, day, hour, minute) {
  let closeDay = day;
  let closeHour = hour;

  // If hour >= 24, move to next calendar day
  if (closeHour >= 24) {
    closeHour -= 24;
    closeDay += 1;
  }

  // Convert ICT to UTC: UTC = ICT - 7 hours
  let utcHour = closeHour - 7;
  let utcDay = closeDay;

  // If UTC hour < 0, move back to previous day
  if (utcHour < 0) {
    utcHour += 24;
    utcDay -= 1;
  }

  return new Date(Date.UTC(year, month - 1, utcDay, utcHour, minute));
}

/**
 * Auto-create a lottery round for a given lottery type and date
 * @param {Object} lotteryType - { id, code, name }
 * @param {string} dateStr - 'YYYY-MM-DD' in ICT
 * @returns {Promise<Object|null>} { id, round_code, round_name } or null if failed
 */
async function autoCreateHdRound(lotteryType, dateStr) {
  const schedule = HD_SCHEDULE[lotteryType.code];

  if (!schedule) {
    console.warn(
      `[HD CREATOR] No schedule found for lottery type: ${lotteryType.code}`
    );
    return null;
  }

  // Parse dateStr (YYYY-MM-DD)
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  // Build round_code: HD-{CODE}-{YYYYMMDD}
  const codeUpper = lotteryType.code.toUpperCase().replace(/_/g, '-');
  const yyyymmdd = `${yearStr}${monthStr}${dayStr}`;
  const round_code = `HD-${codeUpper}-${yyyymmdd}`;

  // Build round_name: "{sched.name} {DD}/{MM}/{YYYY}"
  const dd = dayStr.padStart(2, '0');
  const mm = monthStr.padStart(2, '0');
  const round_name = `${schedule.name} ${dd}/${mm}/${yearStr}`;

  // Calculate openAt and closeAt in UTC
  const openAt = ictToUTC(
    year,
    month,
    day,
    schedule.openH,
    schedule.openM
  );
  const closeAt = ictToUTC(
    year,
    month,
    day,
    schedule.closeH,
    schedule.closeM
  );

  // Check if round_code already exists
  const existing = await queryOne(
    'SELECT id FROM lottery_rounds WHERE round_code = ?',
    [round_code]
  );

  if (existing) {
    console.log(`[HD CREATOR] Round ${round_code} already exists (id: ${existing.id})`);
    return { id: existing.id, round_code, round_name };
  }

  // Insert new round
  try {
    const result = await query(
      `INSERT INTO lottery_rounds
        (lottery_type_id, round_code, round_name, open_at, close_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'open', NULL)`,
      [lotteryType.id, round_code, round_name, openAt, closeAt]
    );

    const insertId = result.insertId;
    console.log(`[HD CREATOR] Created round ${round_code} (id: ${insertId})`);

    return { id: insertId, round_code, round_name };
  } catch (err) {
    console.error(`[HD CREATOR] Error creating round ${round_code}:`, err.message);
    return null;
  }
}

/**
 * Auto-create all HD rounds for a given date
 * @param {string} dateStr - 'YYYY-MM-DD' in ICT
 * @returns {Promise<Object>} { created: [], skipped: [], errors: [] }
 */
async function autoCreateAllHdRoundsForDate(dateStr) {
  const result = {
    created: [],
    skipped: [],
    errors: [],
  };

  for (const code of Object.keys(HD_SCHEDULE)) {
    try {
      // Find lottery type by code
      const lotteryType = await queryOne(
        "SELECT id, code, name FROM lottery_types WHERE code = ? AND status != 'maintenance'",
        [code]
      );

      if (!lotteryType) {
        result.skipped.push(`${code} (no active lottery type found)`);
        continue;
      }

      // Check if round already exists for this date
      const [yearStr, monthStr, dayStr] = dateStr.split('-');
      const yyyymmdd = `${yearStr}${monthStr}${dayStr}`;
      const codeUpper = code.toUpperCase().replace(/_/g, '-');
      const round_code = `HD-${codeUpper}-${yyyymmdd}`;

      const existingRound = await queryOne(
        'SELECT id FROM lottery_rounds WHERE round_code = ?',
        [round_code]
      );

      if (existingRound) {
        result.skipped.push(`${code} (round already exists)`);
        continue;
      }

      // Create round
      const roundResult = await autoCreateHdRound(lotteryType, dateStr);
      if (roundResult) {
        result.created.push(code);
      } else {
        result.errors.push(`${code} (creation failed)`);
      }
    } catch (err) {
      console.error(`[HD CREATOR] Error processing ${code}:`, err.message);
      result.errors.push(`${code} (${err.message})`);
    }
  }

  console.log(
    `[HD CREATOR] Summary for ${dateStr}: Created ${result.created.length}, ` +
    `Skipped ${result.skipped.length}, Errors ${result.errors.length}`
  );

  return result;
}

module.exports = {
  autoCreateHdRound,
  autoCreateAllHdRoundsForDate,
  HD_SCHEDULE,
};
