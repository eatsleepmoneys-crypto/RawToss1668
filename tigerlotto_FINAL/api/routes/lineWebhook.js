'use strict';
/**
 * lineWebhook.js — รับ Webhook จาก LINE และเก็บ Group ID อัตโนมัติ
 *
 * ตั้งค่า Webhook URL ใน LINE Developers Console:
 *   https://<your-domain>/api/webhooks/line
 *
 * เมื่อใครพิมพ์ในกลุ่ม หรือ Bot ถูกเพิ่มเข้ากลุ่ม
 * → ระบบจะเก็บ Group ID ไว้ใน settings อัตโนมัติ
 * → Admin เห็น Group ID ใน หน้า LINE Settings ทันที
 */

const router = require('express').Router();
const { query } = require('../config/db');
const crypto   = require('crypto');

// ── Verify LINE Signature ─────────────────────────────────────────────────
function verifySignature(body, signature, secret) {
  if (!secret) return true; // ถ้าไม่มี secret ข้ามตรวจ (development)
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  return hmac === signature;
}

// ── POST /api/webhooks/line ───────────────────────────────────────────────
// LINE ส่ง events มาที่นี่ทุกครั้ง
router.post('/', async (req, res) => {
  // ตอบ 200 ทันทีก่อน (LINE ต้องการ response ภายใน 30 วินาที)
  res.sendStatus(200);

  try {
    const events = req.body?.events || [];
    if (!events.length) return;

    // ดึง Channel Secret สำหรับ verify (optional)
    const rows = await query("SELECT value FROM settings WHERE `key`='line_bot_secret' LIMIT 1");
    const secret = rows[0]?.value || '';

    // Verify signature ถ้ามี secret
    const sig = req.headers['x-line-signature'];
    if (secret && sig) {
      const rawBody = JSON.stringify(req.body);
      if (!verifySignature(rawBody, sig, secret)) {
        console.warn('[LINE Webhook] Signature mismatch — ignored');
        return;
      }
    }

    const detectedGroups = new Set();

    for (const event of events) {
      const source   = event.source || {};
      const groupId  = source.groupId  || source.roomId || null;
      const userId   = source.userId   || null;
      const type     = event.type      || '';
      const text     = event.message?.text || '';

      console.log(`[LINE Webhook] event:${type} groupId:${groupId || '-'} userId:${userId || '-'}`);

      if (groupId) {
        detectedGroups.add(groupId);

        // เก็บ Group ID ล่าสุดที่เจอ
        await query(
          `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES ('line_group_id',?,?,?)
           ON DUPLICATE KEY UPDATE value=?`,
          [groupId, 'string', 'line', groupId]
        );

        // เก็บ log ล่าสุด (สูงสุด 20 รายการ)
        await query(
          `INSERT INTO settings (\`key\`,value,type,\`group\`) VALUES ('line_webhook_log',?,?,?)
           ON DUPLICATE KEY UPDATE value=?`,
          [
            JSON.stringify({
              groupId,
              userId,
              type,
              text: text.slice(0, 100),
              at: new Date().toISOString(),
            }),
            'json', 'line',
            JSON.stringify({
              groupId,
              userId,
              type,
              text: text.slice(0, 100),
              at: new Date().toISOString(),
            }),
          ]
        );
      }
    }

    if (detectedGroups.size > 0) {
      console.log('[LINE Webhook] Detected Group IDs:', [...detectedGroups].join(', '));
    }
  } catch (err) {
    console.error('[LINE Webhook] Error:', err.message);
  }
});

// ── GET /api/webhooks/line/status — ตรวจสอบ webhook พร้อมใช้งาน ─────────
// LINE Developers Console จะ ping endpoint นี้ด้วย GET
router.get('/', (req, res) => {
  res.json({ ok: true, service: 'TigerLotto LINE Webhook', ts: new Date().toISOString() });
});

module.exports = router;
