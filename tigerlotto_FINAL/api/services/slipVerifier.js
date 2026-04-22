const fs      = require('fs');
const axios   = require('axios');
const FormData = require('form-data');

/**
 * getSlipOKCredentials()
 * อ่าน API Key จาก settings table ก่อน แล้ว fallback ไป .env
 */
async function getSlipOKCredentials() {
  try {
    const { query } = require('../config/db');
    const rows = await query(
      "SELECT `key`, value FROM settings WHERE `key` IN ('slipok_api_key','slipok_branch_id','slipok_enabled')"
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      apiKey   : map['slipok_api_key']   || process.env.SLIPOK_API_KEY    || '',
      branchId : map['slipok_branch_id'] || process.env.SLIPOK_BRANCH_ID  || '',
      enabled  : map['slipok_enabled'] !== undefined
                   ? map['slipok_enabled'] === 'true'
                   : (process.env.SLIPOK_ENABLED !== 'false'),
    };
  } catch {
    return {
      apiKey  : process.env.SLIPOK_API_KEY   || '',
      branchId: process.env.SLIPOK_BRANCH_ID || '',
      enabled : process.env.SLIPOK_ENABLED !== 'false',
    };
  }
}

/**
 * checkDuplicateRef(transRef)
 * ตรวจว่า transaction reference นี้ถูกใช้ฝากซ้ำไปแล้วหรือไม่
 */
async function checkDuplicateRef(transRef) {
  if (!transRef) return false;
  try {
    const { query } = require('../config/db');
    const rows = await query(
      "SELECT id FROM deposits WHERE slip_ref_id=? AND status IN ('pending','approved') LIMIT 1",
      [transRef]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ── Bank code mapping (SlipOK numeric → our code) ─────────────────────────
const BANK_CODE_MAP = {
  '002':'BBL','004':'KBANK','006':'KTB','007':'IBANK','008':'TBANK',
  '011':'TMB','014':'SCB', '025':'BAY', '030':'GSB', '033':'GHB',
  '034':'BAAC','035':'UOB','066':'CIMB','067':'TISCO','069':'KKP',
  '073':'LH',  '098':'PROMPTPAY',
  // passthrough ถ้า SlipOK ส่งชื่อมาแล้ว
  'BBL':'BBL','KBANK':'KBANK','KTB':'KTB','TMB':'TMB','SCB':'SCB',
  'BAY':'BAY','GSB':'GSB','BAAC':'BAAC','UOB':'UOB','CIMB':'CIMB',
  'TISCO':'TISCO','TBANK':'TBANK','KKP':'KKP','LH':'LH',
};

function normalizeBankCode(code) {
  if (!code) return '';
  return BANK_CODE_MAP[String(code)] || BANK_CODE_MAP[String(code).toUpperCase()] || String(code).toUpperCase();
}

/**
 * accountsMatch(slipAccountStr, registeredAccount)
 * เปรียบเทียบเลขบัญชีจากสลิป (มาสก์บางส่วน) กับบัญชีที่ลงทะเบียน
 * คืน true=ตรง, false=ไม่ตรง, null=ตรวจไม่ได้ (ถูก mask มากเกิน)
 */
function accountsMatch(slipAccountStr, registeredAccount) {
  // ดึงตัวเลขที่มองเห็นได้จากสลิป (ไม่ใช่ x หรือ -)
  const visible = String(slipAccountStr || '').replace(/[xX\-\s\.]/g, '');
  const regDigits = String(registeredAccount || '').replace(/[^0-9]/g, '');
  if (!visible || visible.length < 3) return null; // mask มากเกิน ตรวจไม่ได้
  if (!regDigits) return null;
  // ตรวจว่าเลขที่ visible เป็น substring ของบัญชีลงทะเบียน
  return regDigits.includes(visible) || regDigits.endsWith(visible);
}

/**
 * verifySenderAccount(slipData, memberInfo)
 * ตรวจว่าผู้โอนในสลิปตรงกับบัญชีลงทะเบียนของสมาชิกหรือไม่
 * คืน { ok, senderAccount, senderBank }
 */
function verifySenderAccount(slipData, memberInfo) {
  const sender = slipData?.sender || slipData?.payerProxy || null;
  if (!sender) return { ok: null, reason: 'NO_SENDER_INFO' }; // SlipOK ไม่ส่งข้อมูลผู้โอน

  const senderAccVal  = sender?.account?.value || sender?.accountNo || sender?.proxy?.value || '';
  const senderBankRaw = sender?.bank?.code || sender?.bank?.name || sender?.bankCode || '';
  const senderBank    = normalizeBankCode(senderBankRaw);
  const regBank       = normalizeBankCode(memberInfo.bank_code || '');
  const regAccount    = memberInfo.bank_account || '';

  const match = accountsMatch(senderAccVal, regAccount);
  if (match === null) return { ok: null, reason: 'CANNOT_VERIFY', senderAccount: senderAccVal, senderBank };

  // ถ้าธนาคารมีข้อมูล ตรวจด้วย
  if (senderBank && regBank && senderBank !== regBank) {
    return { ok: false, senderAccount: senderAccVal, senderBank };
  }
  return { ok: match, senderAccount: senderAccVal, senderBank };
}

/**
 * verifySlip(filePath, expectedAmount, memberInfo?)
 * ส่งสลิปไปตรวจกับ SlipOK API
 *
 * Return:
 *   { valid, reason, skip?, data?, transRef? }
 *
 * Reasons:
 *   OK              — ผ่านทุกอย่าง
 *   NOT_ENABLED     — ปิดระบบตรวจสลิป (skip=true)
 *   NO_CREDENTIALS  — ไม่ได้ตั้งค่า API Key / Branch ID (skip=true)
 *   SLIP_INVALID    — SlipOK บอกว่าสลิปไม่ถูกต้อง
 *   AMOUNT_MISMATCH — ยอดในสลิปไม่ตรงกับที่แจ้ง
 *   SLIP_EXPIRED    — สลิปเกิน 30 นาที
 *   DUPLICATE_SLIP  — สลิปนี้เคยใช้ฝากแล้ว
 *   API_ERROR       — เรียก SlipOK ไม่ได้ / timeout
 */
async function verifySlip(filePath, expectedAmount, memberInfo = null) {
  const creds = await getSlipOKCredentials();

  if (!creds.enabled) {
    return { valid: false, reason: 'NOT_ENABLED', skip: true };
  }
  if (!creds.apiKey || !creds.branchId) {
    return { valid: false, reason: 'NO_CREDENTIALS', skip: true };
  }

  try {
    const form = new FormData();
    form.append('files', fs.createReadStream(filePath));
    form.append('amount', String(parseFloat(expectedAmount)));
    form.append('log', 'true');

    const response = await axios.post(
      `https://api.slipok.com/api/line/apikey/${creds.branchId}`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-authorization': creds.apiKey,
        },
        timeout: 20000,
      }
    );

    const body = response.data;

    // SlipOK อาจ return success:false พร้อม code
    if (!body?.success) {
      const code = body?.code || '';
      const msg  = body?.message || body?.msg || 'SLIP_INVALID';
      // code DUPE = duplicate
      if (code === 'DUPE' || String(msg).toUpperCase().includes('DUPLI')) {
        return { valid: false, reason: 'DUPLICATE_SLIP', data: body };
      }
      return { valid: false, reason: 'SLIP_INVALID', code, message: msg, data: body };
    }

    const slipData = body.data || body;

    // ตรวจ transRef ซ้ำ
    const transRef = slipData.transRef || slipData.referenceNo || slipData.transactionId || null;
    if (transRef) {
      const isDup = await checkDuplicateRef(transRef);
      if (isDup) {
        return { valid: false, reason: 'DUPLICATE_SLIP', data: slipData, transRef };
      }
    }

    // ตรวจยอดเงิน (±1 บาท tolerance)
    const slipAmount = parseFloat(slipData.amount);
    const expected   = parseFloat(expectedAmount);
    if (isNaN(slipAmount) || Math.abs(slipAmount - expected) > 1) {
      return { valid: false, reason: 'AMOUNT_MISMATCH', slipAmount, expected, data: slipData, transRef };
    }

    // ตรวจเวลา (ไม่เกิน 60 นาที)
    const transTime   = slipData.transTimestamp ? new Date(slipData.transTimestamp) : null;
    if (transTime && !isNaN(transTime.getTime())) {
      const diffMinutes = (Date.now() - transTime.getTime()) / 60000;
      if (diffMinutes > 60) {
        return { valid: false, reason: 'SLIP_EXPIRED', diffMinutes: Math.round(diffMinutes), data: slipData, transRef };
      }
    }

    // ── ตรวจบัญชีผู้โอน (ถ้าเปิดใช้งาน) ─────────────────────────
    if (memberInfo && memberInfo.bank_account) {
      try {
        const [row] = await require('../config/db').query(
          "SELECT value FROM settings WHERE `key`='slipok_verify_sender' LIMIT 1"
        );
        if (row?.value === 'true') {
          const senderCheck = verifySenderAccount(slipData, memberInfo);
          if (senderCheck.ok === false) {
            return {
              valid            : false,
              reason           : 'WRONG_SENDER_ACCOUNT',
              data             : slipData,
              transRef,
              senderAccount    : senderCheck.senderAccount,
              senderBank       : senderCheck.senderBank,
              registeredAccount: memberInfo.bank_account,
              registeredBank   : normalizeBankCode(memberInfo.bank_code || ''),
            };
          }
        }
      } catch { /* ถ้า query ล้มเหลว ข้ามตรวจผู้โอน */ }
    }

    return { valid: true, reason: 'OK', data: slipData, transRef };

  } catch (err) {
    const status = err.response?.status;
    const errData = err.response?.data;

    // 401 = wrong api key
    if (status === 401) return { valid: false, reason: 'BAD_API_KEY', error: 'API Key ไม่ถูกต้อง', skip: true };
    // 400 = bad request / invalid slip
    if (status === 400) return { valid: false, reason: 'SLIP_INVALID', error: errData?.message || err.message };
    // timeout
    if (err.code === 'ECONNABORTED') return { valid: false, reason: 'API_TIMEOUT', error: 'SlipOK timeout', skip: true };

    return { valid: false, reason: 'API_ERROR', error: err.message, skip: true };
  }
}

/**
 * REASON_TH — คำอธิบายภาษาไทย
 */
const REASON_TH = {
  OK                  : '✅ ตรวจสลิปผ่าน',
  WRONG_SENDER_ACCOUNT: '❌ บัญชีผู้โอนไม่ตรงกับที่ลงทะเบียน',
  NOT_ENABLED     : '⚙️ ปิดระบบตรวจสลิปอัตโนมัติ',
  NO_CREDENTIALS  : '⚙️ ยังไม่ได้ตั้งค่า SlipOK',
  SLIP_INVALID    : '❌ สลิปไม่ถูกต้องหรือปลอมแปลง',
  AMOUNT_MISMATCH : '❌ ยอดเงินในสลิปไม่ตรง',
  SLIP_EXPIRED    : '❌ สลิปหมดอายุ (เกิน 60 นาที)',
  DUPLICATE_SLIP  : '❌ สลิปนี้เคยใช้ฝากเงินแล้ว',
  BAD_API_KEY     : '❌ API Key ผิด — กรุณาตรวจสอบการตั้งค่า',
  API_TIMEOUT     : '⚠️ SlipOK ไม่ตอบสนอง (timeout)',
  API_ERROR       : '⚠️ เรียก SlipOK ไม่ได้',
};

module.exports = { verifySlip, getSlipOKCredentials, checkDuplicateRef, REASON_TH, normalizeBankCode, accountsMatch };
