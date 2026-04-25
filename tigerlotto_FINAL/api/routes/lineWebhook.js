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
    const secret   = creds.botEnabled ? (await query("SELECT value FROM settings WHERE `key`='line_bot_secret' LIMIT 1"))[0]?.value || '' : '';
    const botToken = creds.botToken || '';

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
        await query(
          `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES ('line_group_id',?,?,?)
           ON DUPLICATE KEY UPDATE value=?`,
          [groupId, 'string', 'line', groupId]
        ).catch(() => {});

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

module.exports = router;
