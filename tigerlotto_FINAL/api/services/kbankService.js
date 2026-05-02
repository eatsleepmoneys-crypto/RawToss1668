/**
 * kbankService.js — KBank Open API Fund Transfer
 * ─────────────────────────────────────────────
 * รองรับ:
 *  - OAuth2 Client Credentials (token caching อัตโนมัติ)
 *  - PromptPay (เบอร์โทร / เลขบัตรประชาชน)
 *  - โอนตรงบัญชีธนาคาร (inter-bank หรือ same-bank)
 *  - Sandbox และ Production environment
 *
 * เอกสารอ้างอิง:
 *  https://apiportal.kasikornbank.com
 *
 * วิธีสมัคร (Production):
 *  1. สมัครที่ https://apiportal.kasikornbank.com
 *  2. เลือก Product: "Fund Transfer" / "Corporate Payment"
 *  3. รับ Consumer Key (client_id) + Consumer Secret (client_secret)
 *  4. รับ Certificate (.pem) สำหรับ mTLS (เฉพาะ Production)
 *  5. ตั้งค่าใน Admin → ตั้งค่าระบบ → KBank API
 */

'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ── Base URLs ──────────────────────────────────────────────────────────────
const URL_SANDBOX    = 'https://openapi-sandbox.kasikornbank.com';
const URL_PRODUCTION = 'https://openapi.kasikornbank.com';

// ── Token cache (in-memory) ────────────────────────────────────────────────
let _tokenCache = { token: null, expireAt: 0 };

// ── Load credentials from DB settings ─────────────────────────────────────
async function getKBankCredentials() {
  try {
    const { query } = require('../config/db');
    const rows = await query(
      "SELECT `key`, value FROM settings WHERE `key` IN " +
      "('kbank_enabled','kbank_sandbox','kbank_client_id','kbank_client_secret'," +
      "'kbank_account_no','kbank_account_name')"
    );
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return {
      enabled     : map['kbank_enabled']       === 'true',
      sandbox     : map['kbank_sandbox']        !== 'false', // default sandbox=true
      clientId    : map['kbank_client_id']      || process.env.KBANK_CLIENT_ID    || '',
      clientSecret: map['kbank_client_secret']  || process.env.KBANK_CLIENT_SECRET || '',
      accountNo   : map['kbank_account_no']     || process.env.KBANK_ACCOUNT_NO   || '',
      accountName : map['kbank_account_name']   || process.env.KBANK_ACCOUNT_NAME || '',
    };
  } catch {
    return {
      enabled     : false,
      sandbox     : true,
      clientId    : process.env.KBANK_CLIENT_ID    || '',
      clientSecret: process.env.KBANK_CLIENT_SECRET || '',
      accountNo   : process.env.KBANK_ACCOUNT_NO   || '',
      accountName : process.env.KBANK_ACCOUNT_NAME || '',
    };
  }
}

// ── Get OAuth2 Access Token (with caching) ────────────────────────────────
async function getAccessToken(creds) {
  const now = Date.now();
  // Return cached token if still valid (with 60s buffer)
  if (_tokenCache.token && _tokenCache.expireAt > now + 60000) {
    return _tokenCache.token;
  }

  const baseUrl = creds.sandbox ? URL_SANDBOX : URL_PRODUCTION;

  const params = new URLSearchParams();
  params.append('grant_type',    'client_credentials');
  params.append('client_id',     creds.clientId);
  params.append('client_secret', creds.clientSecret);

  const resp = await axios.post(
    `${baseUrl}/oauth/token`,
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    }
  );

  const { access_token, expires_in } = resp.data;
  _tokenCache = {
    token   : access_token,
    expireAt: now + (parseInt(expires_in) || 1800) * 1000,
  };

  console.log('[KBank] Access token refreshed, expires in', expires_in, 's');
  return access_token;
}

// ── Helper: Thai date-time string ─────────────────────────────────────────
function thaiDateTime() {
  return new Date().toISOString().replace('Z', '+07:00');
}

// ── Detect proxy type from value ───────────────────────────────────────────
function detectProxyType(value) {
  const v = String(value || '').replace(/[^0-9]/g, '');
  if (v.length === 10) return 'MSISDN';   // เบอร์โทร 10 หลัก
  if (v.length === 13) return 'NATID';    // เลขบัตรประชาชน 13 หลัก
  return 'MSISDN';                         // default
}

/**
 * transferPromptPay(opts)
 * โอนเงินผ่าน PromptPay
 *
 * opts:
 *  amount       - จำนวนเงิน (number)
 *  proxyValue   - เบอร์โทร หรือ เลขบัตรประชาชน
 *  proxyType    - 'MSISDN' | 'NATID' (auto-detect ถ้าไม่ระบุ)
 *  recipientName - ชื่อผู้รับ (optional)
 *  ref          - reference string (optional, auto-generated ถ้าไม่ระบุ)
 *
 * Returns: { success, transactionId, refId, data }
 */
async function transferPromptPay({ amount, proxyValue, proxyType, recipientName = '', ref } = {}) {
  const creds = await getKBankCredentials();
  if (!creds.enabled) return { success: false, reason: 'KBANK_DISABLED' };
  if (!creds.clientId || !creds.clientSecret) return { success: false, reason: 'NO_CREDENTIALS' };

  const token   = await getAccessToken(creds);
  const baseUrl = creds.sandbox ? URL_SANDBOX : URL_PRODUCTION;
  const rqUID   = uuidv4();
  const rqDt    = thaiDateTime();
  const refId   = ref || ('WD-' + Date.now());
  const pType   = proxyType || detectProxyType(proxyValue);

  console.log(`[KBank] PromptPay transfer | amount:${amount} | proxy:${pType}:${proxyValue} | ref:${refId} | sandbox:${creds.sandbox}`);

  const body = {
    rqUID,
    rqDt,
    transferType : 'PROMPTPAY',
    debitAccount : { acctNo: creds.accountNo },
    creditProxy  : {
      type : pType,
      value: String(proxyValue).replace(/[^0-9]/g, ''),
    },
    amount: {
      value   : parseFloat(amount).toFixed(2),
      currency: 'THB',
    },
    recipientName,
    refId,
  };

  const resp = await axios.post(
    `${baseUrl}/v2/fund-transfer/proxy`,
    body,
    {
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Content-Type'  : 'application/json',
        'x-api-version' : '2.0',
        'x-request-uid' : rqUID,
      },
      timeout: 30000,
    }
  );

  const d = resp.data;
  console.log(`[KBank] PromptPay response: status=${resp.status} txId=${d?.transactionId || d?.txnId || '-'}`);

  return {
    success      : true,
    transactionId: d?.transactionId || d?.txnId || rqUID,
    refId,
    data         : d,
  };
}

/**
 * transferBankAccount(opts)
 * โอนเงินตรงบัญชีธนาคาร
 *
 * opts:
 *  amount        - จำนวนเงิน (number)
 *  bankCode      - รหัสธนาคารปลายทาง (e.g. 'KBANK','SCB','BBL')
 *  accountNo     - เลขบัญชีปลายทาง
 *  accountName   - ชื่อบัญชีปลายทาง
 *  ref           - reference string (optional)
 *
 * Returns: { success, transactionId, refId, data }
 */
async function transferBankAccount({ amount, bankCode, accountNo, accountName = '', ref } = {}) {
  const creds = await getKBankCredentials();
  if (!creds.enabled) return { success: false, reason: 'KBANK_DISABLED' };
  if (!creds.clientId || !creds.clientSecret) return { success: false, reason: 'NO_CREDENTIALS' };

  const token   = await getAccessToken(creds);
  const baseUrl = creds.sandbox ? URL_SANDBOX : URL_PRODUCTION;
  const rqUID   = uuidv4();
  const rqDt    = thaiDateTime();
  const refId   = ref || ('WD-' + Date.now());

  // ── Normalize bank code → KBank numeric code ──────────────────────────
  const BANK_NUMERIC = {
    'BBL':'002','KBANK':'004','KTB':'006','TBANK':'008',
    'TMB':'011','SCB':'014','BAY':'025','GSB':'030',
    'GHB':'033','BAAC':'034','UOB':'035','CIMB':'066',
    'TISCO':'067','KKP':'069','LH':'073',
  };
  const numericCode = BANK_NUMERIC[String(bankCode).toUpperCase()] || bankCode;

  console.log(`[KBank] BankAccount transfer | amount:${amount} | bank:${bankCode}(${numericCode}) | acct:${accountNo} | ref:${refId} | sandbox:${creds.sandbox}`);

  const body = {
    rqUID,
    rqDt,
    transferType  : 'SMART',
    debitAccount  : { acctNo: creds.accountNo },
    creditAccount : {
      bankCode: numericCode,
      acctNo  : String(accountNo).replace(/[^0-9]/g, ''),
    },
    beneficiaryName: accountName,
    amount: {
      value   : parseFloat(amount).toFixed(2),
      currency: 'THB',
    },
    refId,
  };

  const resp = await axios.post(
    `${baseUrl}/v2/fund-transfer/domestic`,
    body,
    {
      headers: {
        'Authorization' : `Bearer ${token}`,
        'Content-Type'  : 'application/json',
        'x-api-version' : '2.0',
        'x-request-uid' : rqUID,
      },
      timeout: 30000,
    }
  );

  const d = resp.data;
  console.log(`[KBank] BankAccount response: status=${resp.status} txId=${d?.transactionId || d?.txnId || '-'}`);

  return {
    success      : true,
    transactionId: d?.transactionId || d?.txnId || rqUID,
    refId,
    data         : d,
  };
}

/**
 * transfer(amount, memberInfo, ref)
 * Smart transfer — เลือก PromptPay หรือ bank account โดยอัตโนมัติ
 * ตามข้อมูล bank_account / bank_code ที่ member ลงทะเบียนไว้
 *
 * memberInfo: { bank_code, bank_account, bank_name, phone? }
 */
async function transfer(amount, memberInfo, ref) {
  const bankCode  = String(memberInfo.bank_code  || '').toUpperCase();
  const acctNo    = String(memberInfo.bank_account || '').replace(/[^0-9]/g, '');
  const acctName  = memberInfo.bank_name || '';

  // ถ้าบัญชีเป็น PROMPTPAY หรือเลขบัญชีดูเหมือน proxy (10-13 หลัก, ไม่มีรหัสธนาคาร)
  if (bankCode === 'PROMPTPAY' || bankCode === '' && (acctNo.length === 10 || acctNo.length === 13)) {
    return transferPromptPay({ amount, proxyValue: acctNo, recipientName: acctName, ref });
  }

  return transferBankAccount({ amount, bankCode, accountNo: acctNo, accountName: acctName, ref });
}

/**
 * testConnection()
 * ทดสอบ credentials ว่า token ได้ไหม
 */
async function testConnection() {
  const creds = await getKBankCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    return { success: false, message: 'กรุณาบันทึก Client ID และ Client Secret ก่อนทดสอบ' };
  }
  try {
    _tokenCache = { token: null, expireAt: 0 }; // force refresh
    const token = await getAccessToken(creds);
    return {
      success  : true,
      message  : `✅ เชื่อมต่อสำเร็จ! (${creds.sandbox ? 'Sandbox' : 'Production'})`,
      sandbox  : creds.sandbox,
      accountNo: creds.accountNo,
    };
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data?.error_description || err.response?.data?.message || err.message;
    if (status === 401) return { success: false, message: `❌ Client ID / Secret ไม่ถูกต้อง (401)` };
    if (status === 400) return { success: false, message: `❌ ข้อมูล request ไม่ถูกต้อง: ${detail}` };
    return { success: false, message: `⚠️ ทดสอบล้มเหลว: ${detail || err.message}` };
  }
}

module.exports = {
  getKBankCredentials,
  transferPromptPay,
  transferBankAccount,
  transfer,
  testConnection,
};
