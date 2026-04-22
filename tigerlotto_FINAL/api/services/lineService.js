/**
 * lineService.js — LINE Notification Service
 * ─────────────────────────────────────────────
 * รองรับ 2 วิธี:
 *
 * 1) LINE Notify  — ง่ายที่สุด แค่ token เดียว
 *    สมัครที่ https://notify-bot.line.me
 *    → เพิ่ม LINE Notify ในกลุ่ม → Generate Token → ใส่ใน Admin Settings
 *
 * 2) LINE Messaging API  — ส่งได้หลายกลุ่ม / rich message
 *    สร้าง LINE Bot ที่ https://developers.line.biz
 *    → เพิ่ม Bot เข้ากลุ่ม → หา Group ID → ใส่ Channel Access Token + Group ID
 */

'use strict';
const axios = require('axios');

// ── Load LINE credentials from DB ─────────────────────────────────────────
async function getLineCredentials() {
  try {
    const { query } = require('../config/db');
    const rows = await query(
      "SELECT `key`, value FROM settings WHERE `key` IN (" +
      "'line_notify_enabled','line_notify_token'," +
      "'line_bot_enabled','line_bot_token','line_group_id'," +
      "'line_notify_deposit','line_notify_withdraw')"
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      notifyEnabled  : map['line_notify_enabled']   === 'true',
      notifyToken    : map['line_notify_token']      || '',
      botEnabled     : map['line_bot_enabled']       === 'true',
      botToken       : map['line_bot_token']         || '',
      groupId        : map['line_group_id']          || '',
      notifyDeposit  : map['line_notify_deposit']    !== 'false', // default true
      notifyWithdraw : map['line_notify_withdraw']   !== 'false', // default true
    };
  } catch {
    return { notifyEnabled: false, botEnabled: false };
  }
}

// ── LINE Notify (POST to notify-api.line.me/api/notify) ──────────────────
async function sendLineNotify(token, message) {
  const params = new URLSearchParams();
  params.append('message', message);
  const resp = await axios.post(
    'https://notify-api.line.me/api/notify',
    params.toString(),
    {
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Content-Type'  : 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    }
  );
  return resp.data;
}

// ── LINE Messaging API push message ──────────────────────────────────────
async function sendLineBotMessage(token, groupId, message) {
  const resp = await axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to      : groupId,
      messages: [{ type: 'text', text: message }],
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type' : 'application/json',
      },
      timeout: 10000,
    }
  );
  return resp.data;
}

// ── Thai number format ────────────────────────────────────────────────────
function fmt(n) {
  return parseFloat(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });
}

// ── Thai time format ──────────────────────────────────────────────────────
function thaiTime() {
  return new Date().toLocaleString('th-TH', {
    timeZone     : 'Asia/Bangkok',
    year         : 'numeric',
    month        : '2-digit',
    day          : '2-digit',
    hour         : '2-digit',
    minute       : '2-digit',
    second       : '2-digit',
    hour12       : false,
  });
}

/**
 * notify(message)
 * ส่งข้อความผ่าน LINE Notify และ/หรือ LINE Messaging API
 * เรียกภายในจาก sendDepositNotif / sendWithdrawNotif
 */
async function notify(message) {
  const creds = await getLineCredentials();
  const results = [];

  if (creds.notifyEnabled && creds.notifyToken) {
    try {
      await sendLineNotify(creds.notifyToken, message);
      results.push({ method: 'notify', success: true });
      console.log('[LINE] Notify sent ✅');
    } catch (e) {
      results.push({ method: 'notify', success: false, error: e.message });
      console.error('[LINE] Notify error:', e.response?.data || e.message);
    }
  }

  if (creds.botEnabled && creds.botToken && creds.groupId) {
    try {
      await sendLineBotMessage(creds.botToken, creds.groupId, message);
      results.push({ method: 'bot', success: true });
      console.log('[LINE] Bot message sent ✅');
    } catch (e) {
      results.push({ method: 'bot', success: false, error: e.message });
      console.error('[LINE] Bot error:', e.response?.data || e.message);
    }
  }

  return results;
}

/**
 * sendDepositNotif(info)
 * แจ้งเตือนเมื่อมีคำขอฝากเงิน
 *
 * info: { name, phone, amount, bank_code, status, slipVerified }
 */
async function sendDepositNotif(info) {
  const creds = await getLineCredentials();
  console.log(`[LINE] sendDepositNotif — notifyEnabled=${creds.notifyEnabled} botEnabled=${creds.botEnabled} notifyDeposit=${creds.notifyDeposit} notifyToken=${creds.notifyToken?'set':'(empty)'} groupId=${creds.groupId?'set':'(empty)'}`);
  if (!creds.notifyDeposit) { console.log('[LINE] skip: notifyDeposit=false'); return; }
  if (!creds.notifyEnabled && !creds.botEnabled) { console.log('[LINE] skip: no channel enabled'); return; }

  const statusTH = info.status === 'approved' ? '✅ อนุมัติแล้ว'
                 : info.status === 'rejected'  ? '❌ ปฏิเสธ'
                 : '⏳ รอตรวจสอบ';
  const icon     = info.status === 'approved' ? '✅' : info.status === 'rejected' ? '❌' : '💰';
  const slipTH   = info.slipVerified === true  ? '✅ สลิปผ่าน'
                 : info.slipVerified === false ? '❌ สลิปไม่ผ่าน'
                 : '';

  const message = [
    `${icon} [ฝากเงิน — ${statusTH}]`,
    `สมาชิก: ${info.name || '-'} (${info.phone || '-'})`,
    `ยอด: ฿${fmt(info.amount)}`,
    `ธนาคาร: ${info.bank_code || '-'}`,
    slipTH                ? `สลิป: ${slipTH}`             : null,
    info.note             ? `หมายเหตุ: ${info.note}`       : null,
    info.adminName        ? `ดำเนินการโดย: ${info.adminName}` : null,
    `เวลา: ${thaiTime()}`,
  ].filter(Boolean).join('\n');

  return notify(message);
}

/**
 * sendWithdrawNotif(info)
 * แจ้งเตือนเมื่อมีคำขอถอนเงิน
 *
 * info: { name, phone, amount, bank_code, bank_account, bank_name, status, method }
 * method: 'pending' | 'auto' | 'kbank'
 */
async function sendWithdrawNotif(info) {
  const creds = await getLineCredentials();
  if (!creds.notifyWithdraw) return;
  if (!creds.notifyEnabled && !creds.botEnabled) return;

  const METHOD_MAP = {
    kbank   : { icon: '🏦', label: 'KBank API (อัตโนมัติ)' },
    auto    : { icon: '🤖', label: 'อนุมัติอัตโนมัติ (รอแอดมินโอน)' },
    approved: { icon: '✅', label: 'แอดมินโอนเงินแล้ว' },
    rejected: { icon: '❌', label: 'ปฏิเสธ / คืนเงินแล้ว' },
    pending : { icon: '⏳', label: 'รอแอดมินโอน' },
  };
  const m = METHOD_MAP[info.method] || METHOD_MAP.pending;

  const message = [
    `${m.icon} [ถอนเงิน — ${m.label}]`,
    `สมาชิก: ${info.name || '-'} (${info.phone || '-'})`,
    `ยอด: ฿${fmt(info.amount)}`,
    `บัญชีปลายทาง: ${info.bank_code || '-'} ${info.bank_account || '-'}`,
    info.bank_name  ? `ชื่อบัญชี: ${info.bank_name}`          : null,
    info.refNo      ? `เลขอ้างอิง: ${info.refNo}`             : null,
    info.note       ? `หมายเหตุ: ${info.note}`                : null,
    info.adminName  ? `ดำเนินการโดย: ${info.adminName}`       : null,
    `เวลา: ${thaiTime()}`,
  ].filter(Boolean).join('\n');

  return notify(message);
}

/**
 * sendAgentDepositNotif(info)
 * แจ้งเตือนเมื่อ Agent ฝากเงิน / Admin อนุมัติ-ปฏิเสธ
 *
 * info: { agentName, phone, amount, bank_code, status, note, adminName }
 */
async function sendAgentDepositNotif(info) {
  const creds = await getLineCredentials();
  if (!creds.notifyDeposit) return;
  if (!creds.notifyEnabled && !creds.botEnabled) return;

  const statusTH = info.status === 'approved' ? '✅ อนุมัติแล้ว'
                 : info.status === 'rejected'  ? '❌ ปฏิเสธ'
                 : '⏳ รอตรวจสอบ';
  const icon = info.status === 'approved' ? '✅' : info.status === 'rejected' ? '❌' : '💰';

  const message = [
    `${icon} [ฝากเงิน Agent — ${statusTH}]`,
    `เอเยนต์: ${info.agentName || '-'} (${info.phone || '-'})`,
    `ยอด: ฿${fmt(info.amount)}`,
    info.bank_code ? `ธนาคาร: ${info.bank_code}` : null,
    info.note      ? `หมายเหตุ: ${info.note}`      : null,
    info.adminName ? `ดำเนินการโดย: ${info.adminName}` : null,
    `เวลา: ${thaiTime()}`,
  ].filter(Boolean).join('\n');

  return notify(message);
}

/**
 * sendAgentWithdrawNotif(info)
 * แจ้งเตือนเมื่อ Agent ถอนเงิน / Admin อนุมัติ-ปฏิเสธ
 *
 * info: { agentName, phone, amount, bank_code, bank_account, bank_name, status, note, adminName }
 */
async function sendAgentWithdrawNotif(info) {
  const creds = await getLineCredentials();
  if (!creds.notifyWithdraw) return;
  if (!creds.notifyEnabled && !creds.botEnabled) return;

  const statusTH = info.status === 'approved' ? '✅ อนุมัติแล้ว'
                 : info.status === 'rejected'  ? '❌ ปฏิเสธ'
                 : '⏳ รอตรวจสอบ';
  const icon = info.status === 'approved' ? '✅' : info.status === 'rejected' ? '❌' : '🏧';

  const message = [
    `${icon} [ถอนเงิน Agent — ${statusTH}]`,
    `เอเยนต์: ${info.agentName || '-'} (${info.phone || '-'})`,
    `ยอด: ฿${fmt(info.amount)}`,
    `บัญชีปลายทาง: ${info.bank_code || '-'} ${info.bank_account || '-'}`,
    info.bank_name ? `ชื่อบัญชี: ${info.bank_name}`          : null,
    info.note      ? `หมายเหตุ: ${info.note}`                : null,
    info.adminName ? `ดำเนินการโดย: ${info.adminName}`       : null,
    `เวลา: ${thaiTime()}`,
  ].filter(Boolean).join('\n');

  return notify(message);
}

/**
 * testNotify()
 * ทดสอบส่งข้อความ
 */
async function testNotify() {
  const creds = await getLineCredentials();
  if (!creds.notifyEnabled && !creds.botEnabled) {
    return { success: false, message: 'ยังไม่ได้เปิดใช้งาน LINE Notify หรือ LINE Bot' };
  }
  if (creds.notifyEnabled && !creds.notifyToken) {
    return { success: false, message: 'กรุณาบันทึก LINE Notify Token ก่อน' };
  }
  if (creds.botEnabled && (!creds.botToken || !creds.groupId)) {
    return { success: false, message: 'กรุณาบันทึก Bot Token และ Group ID ก่อน' };
  }

  const testMsg = `🐯 TigerLotto — ทดสอบการแจ้งเตือน\n✅ ระบบแจ้งเตือน LINE พร้อมใช้งาน\nเวลา: ${thaiTime()}`;
  try {
    const results = await notify(testMsg);
    const anySuccess = results.some(r => r.success);
    if (anySuccess) {
      return { success: true, message: '✅ ส่งข้อความทดสอบสำเร็จ! ตรวจสอบกลุ่ม LINE ของคุณ', results };
    }
    const err = results.find(r => !r.success);
    return { success: false, message: `❌ ส่งไม่สำเร็จ: ${err?.error || 'unknown'}`, results };
  } catch (e) {
    return { success: false, message: `❌ ${e.message}` };
  }
}

module.exports = {
  notify,
  sendDepositNotif,
  sendWithdrawNotif,
  sendAgentDepositNotif,
  sendAgentWithdrawNotif,
  testNotify,
};
