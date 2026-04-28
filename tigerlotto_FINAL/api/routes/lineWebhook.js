'use strict';
/**
 * lineWebhook.js — LINE Bot Webhook + Auto-reply
 *
 * คำสั่งที่รองรับ (พิมพ์ใน DM กับ Bot หรือในกลุ่ม):
 *   ยอด         → แสดงยอดเงินคงเหลือ (ต้องผูกบัญชีก่อน)
 *   ผล          → ผลหวยล่าสุด (ใครก็ใช้ได้)
 *   ผูก <เบอร์> → ผูก LINE กับบัญชีสมาชิก (DM เท่านั้น)
 *   ยกเลิกผูก  → ยกเลิกการผูกบัญชี
 *   ช่วย        → แสดงคำสั่งทั้งหมด
 */

const router  = require('express').Router();
const { query } = require('../config/db');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { replyMessage, getLineCredentials, fmt, thaiTime } = require('../services/lineService');

// ── Verify LINE Signature ─────────────────────────────────────────────────
function verifySignature(body, signature, secret) {
  if (!secret) return true;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  return hmac === signature;
}

// ── Safe reply (ไม่ throw ถ้าส่งไม่ได้) ─────────────────────────────────
async function safeReply(replyToken, botToken, text) {
  if (!replyToken || !botToken) return;
  try {
    await replyMessage(replyToken, botToken, text);
  } catch (e) {
    console.warn('[LINE Bot] reply error:', e.response?.data?.message || e.message);
  }
}

// ── Command: ยอด ──────────────────────────────────────────────────────────
async function cmdBalance(lineUserId, replyToken, botToken) {
  const [member] = await query(
    'SELECT name, phone, balance, bonus_balance FROM members WHERE line_user_id=? AND is_active=1 LIMIT 1',
    [lineUserId]
  );
  if (!member) {
    return safeReply(replyToken, botToken,
      '❌ ยังไม่ได้ผูกบัญชี\n\nพิมพ์: ผูก <เบอร์มือถือ>\nเช่น: ผูก 0812345678\n(ใช้ได้เฉพาะ DM กับ Bot)');
  }
  const msg = [
    `💰 ยอดเงินของคุณ`,
    `ชื่อ: ${member.name}`,
    `เบอร์: ${member.phone}`,
    `──────────────`,
    `💵 เงินหลัก:  ฿${fmt(member.balance)}`,
    `🎁 โบนัส:    ฿${fmt(member.bonus_balance)}`,
    `──────────────`,
    `⏰ ${thaiTime()}`,
  ].join('\n');
  return safeReply(replyToken, botToken, msg);
}

// ── Command: ผล ───────────────────────────────────────────────────────────
async function cmdResult(replyToken, botToken) {
  const [round] = await query(`
    SELECT lr.round_name, lr.draw_date,
           lr.prize_1st, lr.prize_last_2, lr.prize_front_3, lr.prize_last_3,
           lt.name AS lottery_name, lt.code
    FROM lottery_rounds lr
    JOIN lottery_types lt ON lt.id = lr.lottery_id
    WHERE lr.status='announced' AND lr.prize_1st IS NOT NULL AND lr.prize_1st != ''
    ORDER BY lr.draw_date DESC, lr.announced_at DESC
    LIMIT 1
  `);
  if (!round) {
    return safeReply(replyToken, botToken, '⏳ ยังไม่มีผลหวยล่าสุด');
  }
  const last3 = (() => {
    try {
      const arr = JSON.parse(round.prize_last_3 || '[]');
      return Array.isArray(arr) && arr.length ? arr.join(', ') : '-';
    } catch { return round.prize_last_3 || '-'; }
  })();
  const front3 = (() => {
    try {
      const arr = JSON.parse(round.prize_front_3 || '[]');
      return Array.isArray(arr) && arr.length ? arr.join(', ') : '-';
    } catch { return round.prize_front_3 || '-'; }
  })();
  const lines = [
    `🏆 ผลหวยล่าสุด`,
    `${round.lottery_name} — ${round.round_name}`,
    `──────────────`,
    `🥇 รางวัลที่ 1:    ${round.prize_1st || '-'}`,
  ];
  if (round.prize_last_2) lines.push(`🔢 เลขท้าย 2 ตัว: ${round.prize_last_2}`);
  if (last3 !== '-')      lines.push(`🔢 เลขท้าย 3 ตัว: ${last3}`);
  if (front3 !== '-')     lines.push(`🔢 เลขหน้า 3 ตัว: ${front3}`);
  lines.push(`──────────────`);
  lines.push(`⏰ ${thaiTime()}`);
  return safeReply(replyToken, botToken, lines.join('\n'));
}

// ── Command: ผูก <เบอร์> ─────────────────────────────────────────────────
async function cmdLink(lineUserId, phone, replyToken, botToken, isDM) {
  if (!isDM) {
    return safeReply(replyToken, botToken,
      '⚠️ กรุณาผูกบัญชีใน DM (ส่วนตัว) กับ Bot เท่านั้น\nเพื่อความปลอดภัยของบัญชีคุณ');
  }
  if (!phone || !/^0[0-9]{8,9}$/.test(phone)) {
    return safeReply(replyToken, botToken,
      '❌ เบอร์โทรไม่ถูกต้อง\nรูปแบบ: ผูก 0812345678');
  }
  const [member] = await query(
    'SELECT id, name, line_user_id FROM members WHERE phone=? AND is_active=1 LIMIT 1',
    [phone]
  );
  if (!member) {
    return safeReply(replyToken, botToken,
      `❌ ไม่พบบัญชีเบอร์ ${phone}\nกรุณาตรวจสอบเบอร์โทร`);
  }
  if (member.line_user_id && member.line_user_id !== lineUserId) {
    return safeReply(replyToken, botToken,
      `⚠️ เบอร์ ${phone} ผูกกับ LINE อื่นอยู่แล้ว\nกรุณาติดต่อแอดมิน`);
  }
  if (member.line_user_id === lineUserId) {
    return safeReply(replyToken, botToken,
      `✅ บัญชี ${member.name} (${phone}) ผูกกับ LINE ของคุณอยู่แล้ว\nพิมพ์ "ยอด" เพื่อเช็คยอดเงิน`);
  }
  // ตรวจว่า LINE นี้ผูกกับ member อื่นอยู่ไหม
  const [existingLink] = await query(
    'SELECT id, name FROM members WHERE line_user_id=? LIMIT 1',
    [lineUserId]
  );
  if (existingLink) {
    return safeReply(replyToken, botToken,
      `⚠️ LINE ของคุณผูกกับบัญชี ${existingLink.name} อยู่แล้ว\nพิมพ์ "ยกเลิกผูก" ก่อน แล้วค่อยผูกบัญชีใหม่`);
  }
  await query('UPDATE members SET line_user_id=? WHERE id=?', [lineUserId, member.id]);
  return safeReply(replyToken, botToken,
    `✅ ผูกบัญชีสำเร็จ!\nชื่อ: ${member.name}\nเบอร์: ${phone}\n\nพิมพ์ "ยอด" เพื่อเช็คยอดเงินได้เลย 💰`);
}

// ── Command: ยกเลิกผูก ────────────────────────────────────────────────────
async function cmdUnlink(lineUserId, replyToken, botToken) {
  const [member] = await query(
    'SELECT id, name, phone FROM members WHERE line_user_id=? LIMIT 1',
    [lineUserId]
  );
  if (!member) {
    return safeReply(replyToken, botToken, '❌ ไม่พบบัญชีที่ผูกกับ LINE ของคุณ');
  }
  await query('UPDATE members SET line_user_id=NULL WHERE id=?', [member.id]);
  return safeReply(replyToken, botToken,
    `✅ ยกเลิกการผูกบัญชี ${member.name} (${member.phone}) แล้ว`);
}

// ── Command: ช่วย ─────────────────────────────────────────────────────────
async function cmdHelp(replyToken, botToken) {
  const msg = [
    `🐯 RawToss1668 Bot`,
    `──────────────────`,
    `📋 คำสั่งที่ใช้ได้:`,
    ``,
    `ยอด        → เช็คยอดเงินของฉัน`,
    `ผล         → ผลหวยล่าสุด`,
    `ช่วย        → แสดงคำสั่ง`,
    ``,
    `🔗 ผูกบัญชี (DM เท่านั้น):`,
    `ผูก 0812345678`,
    `ยกเลิกผูก`,
    ``,
    `🌐 เว็บไซต์: rawtoss1668.com`,
  ].join('\n');
  return safeReply(replyToken, botToken, msg);
}

// ── POST /api/webhooks/line ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // ตอบ LINE ทันที

  try {
    const events = req.body?.events || [];
    if (!events.length) return;

    const creds = await getLineCredentials();
    const secret   = process.env.LINE_CHANNEL_SECRET ||
                     (creds.botEnabled ? (await query("SELECT value FROM settings WHERE `key`='line_bot_secret' LIMIT 1").catch(()=>[])).at(0)?.value || '' : '');
    const botToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || creds.botToken || '';

    // กลุ่ม fetch ผลหวย (แยกจากกลุ่มแจ้งเตือน)
    const fetchGroupRow = await query("SELECT value FROM settings WHERE `key`='line_fetch_group_id' LIMIT 1").catch(()=>[]);
    const fetchGroupId  = fetchGroupRow.at(0)?.value || '';

    // Verify signature
    const sig = req.headers['x-line-signature'];
    if (secret && sig) {
      if (!verifySignature(JSON.stringify(req.body), sig, secret)) {
        console.warn('[LINE Webhook] Signature mismatch — ignored');
        return;
      }
    }

    for (const event of events) {
      const source     = event.source || {};
      const groupId    = source.groupId || source.roomId || null;
      const userId     = source.userId  || null;
      const type       = event.type     || '';
      const replyToken = event.replyToken || null;
      const isDM       = source.type === 'user'; // 1-on-1 chat กับ Bot

      // ── เก็บ Group ID อัตโนมัติ ─────────────────────────────────────
      if (groupId) {
        // บันทึก line_group_id (กลุ่มแจ้งเตือน) เฉพาะถ้า NOT fetch group
        if (groupId !== fetchGroupId) {
          await query(
            `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES ('line_group_id',?,?,?)
             ON DUPLICATE KEY UPDATE value=?`,
            [groupId, 'string', 'line', groupId]
          ).catch(() => {});
        }

        // เก็บ webhook log ล่าสุด
        const logVal = JSON.stringify({
          groupId, userId, type,
          text: (event.message?.text || '').slice(0, 100),
          at: new Date().toISOString(),
        });
        await query(
          `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES ('line_webhook_log',?,?,?)
           ON DUPLICATE KEY UPDATE value=?`,
          [logVal, 'json', 'line', logVal]
        ).catch(() => {});

        console.log(`[LINE Webhook] event:${type} groupId:${groupId} userId:${userId || '-'}`);
      }

      // ── Lottery auto-fetch (กลุ่มแยก) ─────────────────────────────
      if (groupId) {
        await handleLotteryMessage(event, groupId, fetchGroupId).catch(e =>
          console.warn('[LINE Fetch] handleLotteryMessage error:', e.message));
      }

      // ── Handle text message (bot commands) ───────────────────────────
      if (type !== 'message' || event.message?.type !== 'text') continue;
      if (!botToken || !creds.botEnabled) continue;
      if (!userId) continue;

      const raw  = (event.message.text || '').trim();
      const text = raw.replace(/\s+/g, ' ');
      const cmd  = text.toLowerCase();

      console.log(`[LINE Bot] cmd="${text}" from userId:${userId} isDM:${isDM}`);

      if (cmd === 'ยอด' || cmd === 'balance' || cmd === 'เงิน') {
        await cmdBalance(userId, replyToken, botToken);

      } else if (cmd === 'ผล' || cmd === 'result' || cmd === 'หวย') {
        await cmdResult(replyToken, botToken);

      } else if (cmd.startsWith('ผูก ') || cmd.startsWith('link ')) {
        const parts = text.split(' ');
        const phone = parts[1] || '';
        await cmdLink(userId, phone, replyToken, botToken, isDM);

      } else if (cmd === 'ยกเลิกผูก' || cmd === 'unlink') {
        await cmdUnlink(userId, replyToken, botToken);

      } else if (cmd === 'ช่วย' || cmd === 'help' || cmd === '?' || cmd === 'คำสั่ง') {
        await cmdHelp(replyToken, botToken);

      } else if (isDM) {
        // DM ที่ไม่รู้จัก → แนะนำ
        await safeReply(replyToken, botToken,
          `ไม่เข้าใจคำสั่ง "${text}"\nพิมพ์ "ช่วย" เพื่อดูคำสั่งทั้งหมด`);
      }
      // ในกลุ่ม: ไม่ตอบถ้าไม่รู้จักคำสั่ง (ไม่รบกวนการสนทนา)
    }
  } catch (err) {
    console.error('[LINE Webhook] Error:', err.message);
  }
});

// ── GET /api/webhooks/line — LINE console ping ────────────────────────────
router.get('/', (req, res) => {
  res.json({ ok: true, service: 'TigerLotto LINE Webhook', ts: new Date().toISOString() });
});


// ─────────────────────────────────────────────────────────────────────────────
// LOTTERY AUTO-FETCH — บันทึกข้อความดิบ + parse ผลหวยจากกลุ่ม LINE แยก
// ─────────────────────────────────────────────────────────────────────────────

/**
 * บันทึกข้อความดิบลง line_messages
 */
async function saveRawMessage(event, groupId) {
  try {
    const msgId   = event.message?.id || '';
    const text    = (event.message?.text || '').trim();
    const senderId = event.source?.userId || '';
    if (!msgId || !text) return;
    await query(
      `INSERT IGNORE INTO \`line_messages\` (msg_id, source_id, sender_id, message_text, received_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [msgId, groupId, senderId, text]
    );
  } catch (e) {
    console.warn('[LINE Fetch] saveRawMessage error:', e.message);
  }
}

/**
 * แปลง วันเดือนปี ภาษาไทย/พุทธศักราช → YYYY-MM-DD
 */
function extractThaiDate(text) {
  const MONTHS = {
    'มกราคม':1,'กุมภาพันธ์':2,'มีนาคม':3,'เมษายน':4,
    'พฤษภาคม':5,'มิถุนายน':6,'กรกฎาคม':7,'สิงหาคม':8,
    'กันยายน':9,'ตุลาคม':10,'พฤศจิกายน':11,'ธันวาคม':12,
    'ม.ค.':1,'ก.พ.':2,'มี.ค.':3,'เม.ย.':4,'พ.ค.':5,'มิ.ย.':6,
    'ก.ค.':7,'ส.ค.':8,'ก.ย.':9,'ต.ค.':10,'พ.ย.':11,'ธ.ค.':12,
  };
  // รูปแบบ: วันที่ DD/MM/YYYY หรือ DD เดือน YYYY(พ.ศ.)
  const ddmmyyyy = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ddmmyyyy) {
    let [,d,m,y] = ddmmyyyy.map(Number);
    if (y > 2400) y -= 543;
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  for (const [mName, mNum] of Object.entries(MONTHS)) {
    const re = new RegExp(`(\\d{1,2})\\s*${mName}\\s*(\\d{4})`);
    const m = text.match(re);
    if (m) {
      let [,d,,y] = m; d = Number(d); y = Number(y);
      if (y > 2400) y -= 543;
      return `${y}-${String(mNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }
  // fallback → วันนี้
  return new Date().toISOString().slice(0, 10);
}

/**
 * แปลงข้อความ LINE → { lotteryCode, drawDate, prizes }
 * prizes = [ { prize_type, prize_value }, ... ]
 *
 * รองรับ: หวยรัฐบาล, หวยลาว, ฮานอย, ยี่กี
 */
// แผนที่ code จากบอท → lottery_type.code ในระบบ
// รองรับทุก code ที่บอทส่ง (2-3 ตัวอักษร)
const BOT_CODE_MAP = {
  // ไทย
  'TH': 'TH_GOV',    // หวยรัฐบาลไทย
  'THS': 'TH_STK',   // หวยหุ้นไทย
  // จีน
  'CN': 'CN_STK',    // หวยหุ้นจีน
  // เวียดนาม / ฮานอย
  'HN': 'VN_HAN',    // ฮานอยปกติ
  'VN': 'VN_HAN',    // เวียดนาม (alias)
  'HS': 'VN_HAN_SP', // ฮานอยพิเศษ
  'HV': 'VN_HAN_VIP',// ฮานอย VIP
  // ลาว
  'LA': 'LA_GOV',    // หวยลาว
  // มาเลย์
  'MY': 'MY_STK',    // หวยมาเลย์
  // สิงคโปร์
  'SG': 'SG_STK',    // หวยสิงคโปร์
  // ยี่กี
  'YK': 'YEEKEE',    // หวยยี่กี
  'YG': 'YEEKEE',    // alias
};

/**
 * parse ข้อความบอทแจ้งผลหวย — รองรับหลายหวยในข้อความเดียว
 * format ที่รองรับ:
 *   XX ชื่อ hd XX       ← header line (XX = 2-letter code, "hd" คั่น)
 *   28 เมษายน 2569       ← วันที่ (พ.ศ.)
 *   ↑ 048                ← บน/3 ตัว
 *   ↓ 63                 ← ล่าง/2 ตัว
 *   XXXXX 🔥🔥           ← decoration (ข้าม)
 * @param {string} text
 * @returns {Array<{lotteryCode,drawDate,prizes}>}
 */
function parseLotteryMessage(text) {
  if (!text) return [];
  const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const results = [];

  // ── หา header blocks ทั้ง 2 รูปแบบ ──────────────────────────────────────
  // Format A (ASCII code):  "SG สิงคโปร์พิเศษ SG"  /  "TH ไทยเย็น TH"
  // Format B (flag emoji):  "🇹🇭 ไทยเย็น 🇹🇭"    /  "🇸🇬 สิงคโปร์ 🇸🇬"
  const FLAG_RE  = '[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]';
  const headerA  = new RegExp('^([A-Z]{2,3})\\s+\\S[^\\n]*\\1\\s*$', 'gim');
  const headerB  = new RegExp('^(' + FLAG_RE + ')\\s+[^\\n]+\\1\\s*$', 'gm');

  const blocks = [];
  let hm;
  while ((hm = headerA.exec(t)) !== null)
    blocks.push({ type: 'ascii', code: hm[1], index: hm.index, header: hm[0] });
  while ((hm = headerB.exec(t)) !== null)
    blocks.push({ type: 'flag',  flag: hm[1], index: hm.index, header: hm[0] });

  blocks.sort((a, b) => a.index - b.index);
  if (!blocks.length) return [];

  for (let i = 0; i < blocks.length; i++) {
    const blk       = blocks[i];
    const nextIndex = blocks[i + 1]?.index ?? t.length;
    const blockText = t.slice(blk.index, nextIndex).trim();
    const lines     = blockText.split('\n').map(l => l.trim()).filter(Boolean);

    const drawDate = extractThaiDate(blockText);
    if (!drawDate) continue;

    // หาเลข บน (↑/⬆️) และ ล่าง (↓/⬇️)
    let top = null, bot = null;
    for (const line of lines) {
      if (!top) { const m = line.match(/(?:[↑⬆]️?|บน)[\s:]*(\d+)/u); if (m) { top = m[1]; continue; } }
      if (!bot) { const m = line.match(/(?:[↓⬇]️?|ล่าง)[\s:]*(\d+)/u); if (m) { bot = m[1]; continue; } }
    }
    if (!top && !bot) continue;

    // map → lottery_type.code
    let lotteryCode = null;
    if (blk.type === 'ascii') {
      lotteryCode = BOT_CODE_MAP[blk.code] || null;
    } else {
      lotteryCode = flagHeaderToCode(blk.flag, blk.header);
    }
    if (!lotteryCode) {
      console.warn('[LINE Parser] unknown header: ' + blk.header.slice(0, 40));
      continue;
    }

    const prizes = [];
    if (top) prizes.push({ prize_type: top.length >= 3 ? '3top' : '2top', prize_value: top });
    if (bot) prizes.push({ prize_type: '2bot', prize_value: bot });
    results.push({ lotteryCode, drawDate, prizes });
    console.log('[LINE Parser] ✅', lotteryCode, drawDate, 'top=' + (top||'-'), 'bot=' + (bot||'-'));
  }
  return results;
}

/** แปลง flag emoji + ชื่อ → lottery_type.code */
function flagHeaderToCode(flagEmoji, headerLine) {
  // แปลง flag emoji → 2-letter country code (TH, SG, VN, ...)
  const cp1 = flagEmoji.codePointAt(0);
  const cp2 = flagEmoji.codePointAt(2);
  if (!cp1 || !cp2) return null;
  const cc = String.fromCharCode(cp1 - 0x1F1E6 + 65) +
             String.fromCharCode(cp2 - 0x1F1E6 + 65);

  const n = headerLine.toLowerCase();
  switch (cc) {
    case 'TH':
      if (n.includes('หุ้น') || n.includes('เย็น') || n.includes('บ่าย') || n.includes('เช้า') || n.includes('stk'))
        return 'TH_STK';
      return 'TH_GOV';
    case 'VN':
      if (n.includes('vip') || n.includes('วีไอพี')) return 'VN_HAN_VIP';
      if (n.includes('พิเศษ'))                        return 'VN_HAN_SP';
      return 'VN_HAN';
    case 'LA': return 'LA_GOV';
    case 'SG': return 'SG_STK';
    case 'MY': return 'MY_STK';
    case 'CN': return 'CN_STK';
    case 'KR': return 'KR_STK';
    default:   return null;
  }
}


/**
 * บันทึกผลหวยที่ parse ได้ลง lottery_rounds + lottery_results
 */
async function saveLotteryResult({ lotteryCode, drawDate, prizes }) {
  try {
    // หา lottery_id
    const [lt] = await query('SELECT id FROM `lottery_types` WHERE code=? LIMIT 1', [lotteryCode]);
    if (!lt) return console.warn(`[LINE Fetch] lottery_type not found: ${lotteryCode}`);

    const roundCode = `${lotteryCode}-${drawDate.replace(/-/g,'')}`;
    const roundName = `งวด ${drawDate}`;

    // upsert round
    await query(`
      INSERT INTO \`lottery_rounds\` (lottery_id, round_code, round_name, draw_date, status)
      VALUES (?,?,?,?,'announced')
      ON DUPLICATE KEY UPDATE status='announced', updated_at=NOW()
    `, [lt.id, roundCode, roundName, drawDate]);

    const [round] = await query('SELECT id FROM `lottery_rounds` WHERE round_code=? LIMIT 1', [roundCode]);
    if (!round) return;

    // map prize_type → column
    const colMap = { '1st':'prize_1st', 'last2':'prize_last_2', 'last3':'prize_last_3', 'front3':'prize_front_3', '2top':'prize_1st', '3top':'prize_1st', '2bot':'prize_last_2' };
    const updates = {};
    for (const p of prizes) {
      const col = colMap[p.prize_type];
      if (col) updates[col] = p.prize_value;
    }

    if (Object.keys(updates).length) {
      const setStr = Object.keys(updates).map(c => `\`${c}\`=?`).join(', ');
      await query(
        `INSERT INTO \`lottery_results\` (round_id, lottery_id, ${Object.keys(updates).map(c=>`\`${c}\``).join(',')})
         VALUES (?,?,${Object.keys(updates).map(()=>'?').join(',')})
         ON DUPLICATE KEY UPDATE ${setStr}, updated_at=NOW()`,
        [round.id, lt.id, ...Object.values(updates), ...Object.values(updates)]
      ).catch(() =>
        query(`UPDATE \`lottery_rounds\` SET ${setStr}, status='announced' WHERE id=?`,
          [...Object.values(updates), round.id])
      );
      console.log(`[LINE Fetch] ✅ saved ${lotteryCode} ${drawDate} prizes:`, updates);
    }
  } catch (e) {
    console.warn('[LINE Fetch] saveLotteryResult error:', e.message);
  }
}

/**
 * ประมวลผลข้อความจากกลุ่ม fetch — บันทึกดิบ + parse ผล
 * เรียกจาก event loop สำหรับทุก message event
 */
async function handleLotteryMessage(event, groupId, fetchGroupId) {
  if (!fetchGroupId || groupId !== fetchGroupId) return; // ไม่ใช่กลุ่ม fetch → ข้าม
  if (event.type !== 'message' || event.message?.type !== 'text') return;

  await saveRawMessage(event, groupId);

  const text = (event.message.text || '').trim();
  const results = parseLotteryMessage(text);
  if (results.length > 0) {
    for (const result of results) {
      console.log(`[LINE Fetch] detected ${result.lotteryCode} ${result.drawDate}`);
      await saveLotteryResult(result);
    }
    // mark as parsed
    const msgId = event.message?.id;
    if (msgId) {
      await query('UPDATE `line_messages` SET parsed=1 WHERE msg_id=?', [msgId]).catch(()=>{});
    }
  }
}

module.exports = router;
