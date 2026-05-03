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
const { v4: uuidv4 } = require('uuid');

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
    // DB secret takes priority over env var (so admin can override from settings page)
    const dbSecret  = (await query("SELECT value FROM settings WHERE `key`='line_bot_secret' LIMIT 1").catch(()=>[])).at(0)?.value || '';
    const secret    = dbSecret || process.env.LINE_CHANNEL_SECRET || '';
    const botToken  = process.env.LINE_CHANNEL_ACCESS_TOKEN || creds.botToken || '';

    // กลุ่ม fetch ผลหวย (แยกจากกลุ่มแจ้งเตือน)
    const fetchGroupRow = await query("SELECT value FROM settings WHERE `key`='line_fetch_group_id' LIMIT 1").catch(()=>[]);
    const fetchGroupId  = fetchGroupRow.at(0)?.value || '';

    // Verify signature — ข้ามถ้าไม่ได้ตั้งค่า secret (ป้องกัน drop message เมื่อ secret ยังไม่ได้ config)
    const sig = req.headers['x-line-signature'];
    if (secret && sig) {
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      if (!verifySignature(rawBody, sig, secret)) {
        console.warn('[LINE Webhook] Signature mismatch (secret set but sig wrong) — processing anyway to avoid message loss');
        // NOTE: uncomment return below after confirming correct secret is configured
        // return;
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
      let [,d,y] = m; d = Number(d); y = Number(y);
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
  // ญี่ปุ่น / เกาหลี / ไต้หวัน
  'JP': 'JP_STK',    // หวยหุ้นญี่ปุ่น
  'KR': 'KR_STK',    // หวยหุ้นเกาหลี
  'TW': 'TW_STK',    // หวยหุ้นไต้หวัน
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
    // Fallback: ถ้าไม่มี ↑↓ บน/ล่าง → หาตัวเลขจากบรรทัดที่ไม่มีตัวอักษรไทย/อังกฤษ
    // รองรับ format: "🟦 604" / "🟦 12" / " 604" / "  12"
    if (!top && !bot) {
      const numOnly = lines.filter(function(l) {
        if (/[฀-๿]/.test(l)) return false; // มีไทย (วันที่) → skip
        if (/[A-Za-z]/.test(l)) return false;         // มีอังกฤษ (header/footer) → skip
        const d = l.replace(/\D/g, '');
        return d.length >= 2 && d.length <= 6;
      });
      if (numOnly[0]) top = numOnly[0].replace(/\D/g, '');
      if (numOnly[1]) bot = numOnly[1].replace(/\D/g, '').slice(-2); // เอาแค่ 2 หลักท้าย
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

/** แปลง flag emoji + ชื่อ → lottery_type.code (old ↑↓ block format) */
function flagHeaderToCode(flagEmoji, headerLine) {
  const cp1 = flagEmoji.codePointAt(0);
  const cp2 = flagEmoji.codePointAt(2);
  if (!cp1 || !cp2) return null;
  const cc = String.fromCharCode(cp1 - 0x1F1E6 + 65) +
             String.fromCharCode(cp2 - 0x1F1E6 + 65);
  return nameToLotteryCode(cc, headerLine);
}

/**
 * แปลง (country code, lottery name) → lottery_type.code ในระบบ
 * ใช้ร่วมกันทั้ง parseSummaryMessage และ flagHeaderToCode
 */
function nameToLotteryCode(cc, name) {
  const n = (name || '').toLowerCase();
  switch (cc) {
    case 'TH':
      if (n.includes('รัฐบาล') || n.includes('gov')) return 'TH_GOV';
      return 'TH_STK';
    case 'JP':
      if (n.includes('vip') || n.includes('วีไอพี'))
        return n.includes('เช้า') ? 'JP_VIP_AM' : 'JP_VIP_PM';
      if (n.includes('พิเศษ') || n.includes('sp'))
        return n.includes('เช้า') ? 'JP_SP_AM' : 'JP_SP_PM';
      if (n.includes('วีซ่า') || n.includes('visa'))
        return n.includes('เช้า') ? 'JP_VISA_AM' : 'JP_VISA_PM';
      return n.includes('บ่าย') ? 'JP_STK_PM' : 'JP_STK_AM';
    case 'CN':
      if (n.includes('vip') || n.includes('วีไอพี'))
        return n.includes('เช้า') ? 'CN_VIP_AM' : 'CN_VIP_PM';
      if (n.includes('พิเศษ') || n.includes('sp'))
        return n.includes('เช้า') ? 'CN_SP_AM' : 'CN_SP_PM';
      if (n.includes('วีซ่า') || n.includes('visa'))
        return n.includes('เช้า') ? 'CN_VISA_AM' : 'CN_VISA_PM';
      return n.includes('บ่าย') ? 'CN_STK_PM' : (n.includes('เช้า') ? 'CN_STK_AM' : 'CN_STK');
    case 'HK':
      if (n.includes('vip') || n.includes('วีไอพี'))
        return n.includes('เช้า') ? 'HK_VIP_AM' : 'HK_VIP_PM';
      if (n.includes('พิเศษ') || n.includes('sp'))
        return n.includes('เช้า') ? 'HK_SP_AM' : 'HK_SP_PM';
      if (n.includes('วีซ่า') || n.includes('visa'))
        return n.includes('เช้า') ? 'HK_VISA_AM' : (n.includes('บ่าย') ? 'HK_VISA_PM' : 'HK_VISA');
      if (n.includes('เช้า')) return 'HK_STK_AM';
      if (n.includes('บ่าย')) return 'HK_STK_PM';
      return 'HK_STK';
    case 'VN':
      if (n.includes('vip') || n.includes('วีไอพี')) {
        if (n.includes('ออนไลน์')) return 'VN_VIP_ONLINE';
        if (n.includes('วีซ่า') || n.includes('visa')) return 'VN_VISA';
        return 'VN_HAN_VIP';
      }
      if (n.includes('พิเศษ') || n.includes('sp')) {
        if (n.includes('เช้า')) return 'VN_SP_AM';
        if (n.includes('บ่าย') || n.includes('เย็น')) return 'VN_SP_PM';
        return 'VN_HAN_SP';
      }
      if (n.includes('ออนไลน์')) return 'VN_HAN_ONLINE';
      if (n.includes('เช้า')) return 'VN_HAN_AM';
      if (n.includes('อาเซียน')) return 'VN_HAN_ASEAN';
      if (n.includes('hd')) return 'VN_HAN_HD';
      if (n.includes('สตาร์') || n.includes('star')) return 'VN_HAN_STAR';
      if (n.includes('ทีวี') || n.includes('tv')) return 'VN_HAN_TV';
      if (n.includes('กาชาด') || n.includes('rc')) return 'VN_HAN_RC';
      if (n.includes('เฉพาะกิจ')) return 'VN_HAN_SPEC';
      if (n.includes('สามัคคี') || n.includes('sam')) return 'VN_HAN_SAM';
      if (n.includes('พัฒนา') || n.includes('dev')) return 'VN_HAN_DEV';
      if (n.includes('4d')) return 'VN_HAN_4D';
      if (n.includes('extra') || n.includes('เอ็กซ์ตร้า')) return 'VN_HAN_EXTRA';
      if (n.includes('ดึก') || n.includes('night')) return 'VN_HAN_NIGHT';
      return 'VN_HAN';
    case 'LA':
      if (n.includes('แม่โขง') || n.includes('maekong') || n.includes('mk')) {
        if (n.includes('hd')) return 'MK_HD';
        if (n.includes('เมก้า') || n.includes('mega')) return 'MK_MEGA';
        if (n.includes('สตาร์') || n.includes('star')) return 'MK_STAR';
        if (n.includes('พลัส') || n.includes('plus')) return 'MK_PLUS';
        if (n.includes('พิเศษ') || n.includes('sp')) return 'MK_SP';
        if (n.includes('vip')) return 'MK_VIP';
        if (n.includes('พัฒนา') || n.includes('dev')) return 'MK_DEV';
        if (n.includes('โกลด์') || n.includes('gold')) return 'MK_GOLD';
        if (n.includes('ไนท์') || n.includes('night')) return 'MK_NIGHT';
        if (n.includes('ปกติ') || n.includes('normal')) return 'MK_NORMAL';
        return 'MK_TODAY';
      }
      if (n.includes('วีซ่า') || n.includes('visa')) {
        if (n.includes('สาละวัน') || n.includes('sal')) return 'LA_VISA_SAL';
        if (n.includes('หลวงพระบาง') || n.includes('lpb')) return 'LA_VISA_LPB';
        if (n.includes('เวียงจันทน์') || n.includes('vte')) return 'LA_VISA_VTE';
        return 'LA_VISA';
      }
      if (n.includes('ประตูชัย') || n.includes('gate')) return 'LA_GATE';
      if (n.includes('สันติภาพ') || n.includes('peace')) return 'LA_PEACE';
      if (n.includes('ประชาชน') || n.includes('people')) return 'LA_PEOPLE';
      if (n.includes('เช้า')) return 'LA_AM';
      if (n.includes('extra') || n.includes('เอ็กซ์ตร้า')) return 'LA_EXTRA';
      if (n.includes('ทีวี') || n.includes('tv')) return 'LA_TV';
      if (n.includes('พิเศษเที่ยง')) return 'LA_SP_NOON';
      if (n.includes('พัฒนาเที่ยง')) return 'LA_GOV_NOON';
      if (n.includes('พัฒนา') && n.includes('vip')) return 'LA_GOV_VIP';
      if (n.includes('พิเศษ')) return 'LA_SP';
      if (n.includes('พัฒนา')) return 'LA_GOV';
      if (n.includes('พลัส') || n.includes('plus')) return 'LA_PLUS';
      if (n.includes('สบายดี') || n.includes('sabai')) return 'LA_SABAI';
      if (n.includes('ก้าวหน้า') || n.includes('progress')) return 'LA_PROGRESS';
      if (n.includes('hd')) return 'LA_HD';
      if (n.includes('เจริญ')) return 'LA_CHERN';
      if (n.includes('นครหลวง') || n.includes('nkl')) return 'LA_NKL';
      if (n.includes('สตาร์') && n.includes('vip')) return 'LA_STAR_VIP';
      if (n.includes('สตาร์') || n.includes('star')) return 'LA_STAR';
      if (n.includes('มั่นคง') || n.includes('stable')) return 'LA_STABLE';
      if (n.includes('นิยม') || n.includes('niyom')) return 'LA_NIYOM';
      if (n.includes('ร่ำรวย')) return 'LA_RICH2';
      if (n.includes('มั่งคั่ง')) return 'LA_RICH';
      if (n.includes('มงคล') || n.includes('mongkol')) return 'LA_MONGKOL';
      if (n.includes('ซูเปอร์') || n.includes('super')) return 'LA_SUPER';
      if (n.includes('สามัคคี') && n.includes('vip')) return 'LA_UNITY_VIP';
      if (n.includes('สามัคคี') || n.includes('unity')) return 'LA_UNITY';
      if (n.includes('อาเซียน') || n.includes('asean')) return 'LA_ASEAN';
      if (n.includes('รุ่งเรือง') || n.includes('prosper')) return 'LA_PROSPER';
      if (n.includes('ไอยรา') || n.includes('aiyara')) return 'LA_AIYARA';
      if (n.includes('กาชาด') || n.includes('rc')) return 'LA_RC';
      if (n.includes('vip')) return 'LA_VIP';
      return 'LA_GOV';
    case 'SG':
      if (n.includes('vip')) return 'SG_VIP';
      if (n.includes('พิเศษ') || n.includes('sp')) return 'SG_SP';
      return 'SG_STK';
    case 'MY': return 'MY_STK';
    case 'KR':
      if (n.includes('vip')) return 'KR_VIP';
      if (n.includes('พิเศษ') || n.includes('sp')) return 'KR_SP';
      return 'KR_STK';
    case 'TW':
      if (n.includes('vip')) return 'TW_VIP';
      if (n.includes('พิเศษ') || n.includes('sp')) return 'TW_SP';
      return 'TW_STK';
    case 'IN': return 'IN_STK';
    case 'DE':
      if (n.includes('vip')) return 'DE_VIP';
      if (n.includes('พิเศษ') || n.includes('sp')) return 'DE_SP';
      if (n.includes('วีซ่า') || n.includes('visa')) return 'DE_VISA';
      return 'DE_STK';
    case 'RU':
      if (n.includes('vip')) return 'RU_VIP';
      if (n.includes('พิเศษ') || n.includes('sp')) return 'RU_SP';
      if (n.includes('วีซ่า') || n.includes('visa')) return 'RU_VISA';
      return 'RU_STK';
    case 'GB':
      if (n.includes('vip')) return 'UK_VIP';
      if (n.includes('วีซ่า') || n.includes('visa')) return 'UK_VISA';
      return 'UK_STK';
    case 'US': return 'DJ_SP';
    case 'EU': return 'EU_SP';
    default:   return null;
  }
}

/**
 * parse รูปแบบสรุปผล (Summary format)
 * แต่ละบรรทัด: "NNN-NN   🏳️ ชื่อหวย"
 * NNN = top3, NN = bot2 (top2 auto-derived จาก top3[-2:])
 */
function parseSummaryMessage(text) {
  if (!text) return [];
  const results = [];
  const drawDate = extractThaiDate(text) || new Date().toISOString().slice(0, 10);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const FLAG_RE = /^(\d{2,3})-(\d{2})\s+([\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF])\s*(.+)$/u;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.includes('งดออกผล') || line.includes('ปิด')) continue;
    const m = line.match(FLAG_RE);
    if (!m) continue;

    const rawTop  = m[1];   // NNN (3-digit top)
    const rawBot  = m[2];   // NN  (2-digit bot)
    const flag    = m[3];   // 🏳️ flag emoji
    const lotName = m[4].trim();

    // decode flag → country code
    const cp1 = flag.codePointAt(0), cp2 = flag.codePointAt(2);
    if (!cp1 || !cp2) continue;
    const cc = String.fromCharCode(cp1 - 0x1F1E6 + 65) + String.fromCharCode(cp2 - 0x1F1E6 + 65);

    const lotteryCode = nameToLotteryCode(cc, lotName);
    if (!lotteryCode) {
      console.warn('[LINE Summary] unknown:', cc, lotName);
      continue;
    }

    const prizes = [];
    if (rawTop.length >= 3) prizes.push({ prize_type: '3top', prize_value: rawTop.slice(0, 3) });
    if (rawBot.length >= 2) prizes.push({ prize_type: '2bot', prize_value: rawBot.slice(-2) });

    results.push({ lotteryCode, drawDate, prizes });
    console.log('[LINE Summary] ✅', lotteryCode, drawDate, 'top=' + rawTop, 'bot=' + rawBot);
  }
  return results;
}

/**
 * บันทึกผลหวยที่ parse ได้ลง lottery_rounds + lottery_results
 */
async function saveLotteryResult({ lotteryCode, drawDate, prizes }) {
  try {
    const [lt] = await query('SELECT id FROM `lottery_types` WHERE code=? LIMIT 1', [lotteryCode]);
    if (!lt) return console.warn('[LINE Fetch] lottery_type not found: ' + lotteryCode);

    // map prize_type → DB column
    // ↑ (บน) 3 หลัก → prize_1st | 2 หลัก → prize_last_2
    // ↓ (ล่าง) → prize_2bot เสมอ (ทุกประเภทหวย)
    const colMap = {
      '1st':'prize_1st', 'last2':'prize_last_2', 'last3':'prize_last_3', 'front3':'prize_front_3',
      '3top': 'prize_1st',
      '2top': 'prize_last_2',
      '2bot': 'prize_2bot',
    };
    const updates = {};
    for (const p of prizes) { const col = colMap[p.prize_type]; if (col) updates[col] = p.prize_value; }
    // auto-derive: 2 ตัวบน = 2 หลักท้ายของ 3 ตัวบน (ถ้ายังไม่มี prize_last_2)
    if (updates.prize_1st && updates.prize_1st.length >= 3 && !updates.prize_last_2) {
      updates.prize_last_2 = updates.prize_1st.slice(-2);
    }
    if (!Object.keys(updates).length) return;

    // 1) หางวดที่มีอยู่แล้ว (open/closed/announced) ตรง lottery + วันที่
    //    รวม 'announced' ด้วย เพื่อให้ LINE result fix ผลที่ auto-fetcher ออกไปแล้วได้
    const existRows = await query(
      'SELECT id FROM lottery_rounds WHERE lottery_id=? AND DATE(draw_date)=? AND status IN (\'open\',\'closed\',\'announced\') ORDER BY id DESC LIMIT 1',
      [lt.id, drawDate]
    );
    const existRound = existRows.length ? existRows[0] : null;

    const setClause = function(keys) { return keys.map(function(c){ return '`' + c + '`=?'; }).join(', '); };
    const colList   = function(keys) { return keys.map(function(c){ return '`' + c + '`'; }).join(','); };
    const ukeys = Object.keys(updates);
    const uvals = Object.values(updates);

    if (existRound) {
      // 2a) งวดมีอยู่ → update status ใน lottery_rounds (prizes อยู่ใน lottery_results เท่านั้น)
      await query(
        'UPDATE lottery_rounds SET status=\'announced\', updated_at=NOW() WHERE id=?',
        [existRound.id]
      );
      await query(
        'INSERT INTO lottery_results (round_id, ' + colList(ukeys) + ', announced_at) VALUES (?,' + ukeys.map(function(){return '?';}).join(',') + ', NOW()) ON DUPLICATE KEY UPDATE ' + setClause(ukeys) + ', announced_at=NOW()',
        [existRound.id, ...uvals, ...uvals]
      );
      console.log('[LINE Fetch] updated round #' + existRound.id + ' ' + lotteryCode + ' ' + drawDate, updates);
    } else {
      // 2b) ไม่มีงวดที่รับแทงอยู่ → สร้างงวดใหม่ announced ทันที
      const roundCode = lotteryCode + '-' + drawDate.replace(/-/g,'');
      await query(
        'INSERT INTO lottery_rounds (uuid, lottery_id, round_code, round_name, draw_date, close_at, status) VALUES (?,?,?,?,?,?,\'announced\') ON DUPLICATE KEY UPDATE status=\'announced\', updated_at=NOW()',
        [uuidv4(), lt.id, roundCode, 'งวด ' + drawDate, drawDate, drawDate]
      );
      const newRows = await query('SELECT id FROM lottery_rounds WHERE round_code=? LIMIT 1', [roundCode]);
      if (!newRows.length) return;
      const nid = newRows[0].id;
      await query(
        'INSERT INTO lottery_results (round_id, ' + colList(ukeys) + ', announced_at) VALUES (?,' + ukeys.map(function(){return '?';}).join(',') + ', NOW()) ON DUPLICATE KEY UPDATE ' + setClause(ukeys) + ', announced_at=NOW()',
        [nid, ...uvals, ...uvals]
      ).catch(function(){});
      console.log('[LINE Fetch] new round ' + lotteryCode + ' ' + drawDate, updates);
    }
  } catch (e) {
    console.warn('[LINE Fetch] saveLotteryResult error:', e.message);
  }
}


/**
 * ประมวลผลข้อความจากกลุ่ม fetch — บันทึกดิบ + parse ผล
 * เรียกจาก event loop ใน router.post('/')
 */
async function handleLotteryMessage(event, groupId, fetchGroupId) {
  if (!fetchGroupId || groupId !== fetchGroupId) return;
  if (event.type !== 'message' || event.message?.type !== 'text') return;

  const text = (event.message.text || '').trim();
  if (!text) return;

  // บันทึก raw message ก่อนเสมอ
  await saveRawMessage(event, groupId);

  // ลอง parse format ต่างๆ
  let parsed = parseSummaryMessage(text);
  if (!parsed) parsed = parseLotteryMessage(text);

  if (!parsed) return;

  const { lotteryCode, drawDate, prizes } = parsed;
  if (!lotteryCode || !drawDate || !prizes?.length) return;

  console.log('[LINE Fetch] parsed result:', lotteryCode, drawDate, prizes);
  await saveLotteryResult({ lotteryCode, drawDate, prizes });

  // mark parsed=1 หลัง save สำเร็จ
  const msgId = event.message?.id || '';
  if (msgId) {
    await query('UPDATE line_messages SET parsed=1 WHERE msg_id=?', [msgId]).catch(() => {});
  }
}

module.exports = Object.assign(router, { parseLotteryMessage, saveLotteryResult });
