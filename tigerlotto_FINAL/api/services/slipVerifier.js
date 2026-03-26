const fs   = require('fs');
const axios = require('axios');
const FormData = require('form-data');

/**
 * verifySlip(filePath, expectedAmount)
 * ส่งสลิปไปตรวจกับ SlipOK API
 * @returns {{ valid: boolean, reason: string, skip?: boolean, data?: object }}
 */
async function verifySlip(filePath, expectedAmount) {
  const apiKey  = process.env.SLIPOK_API_KEY;
  const branchId = process.env.SLIPOK_BRANCH_ID;

  if (!apiKey || !branchId) {
    return { valid: false, reason: 'NO_API_KEY', skip: true };
  }

  try {
    const form = new FormData();
    form.append('files', fs.createReadStream(filePath));
    form.append('amount', String(expectedAmount));
    form.append('log', 'true');

    const response = await axios.post(
      `https://api.slipok.com/api/line/apikey/${branchId}`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'x-authorization': apiKey,
        },
        timeout: 15000,
      }
    );

    const body = response.data;
    if (!body?.success || !body?.data?.success) {
      return { valid: false, reason: 'SLIP_INVALID', data: body?.data };
    }

    const slipData = body.data;

    // ตรวจสอบยอดเงิน (±1 บาท tolerance)
    const slipAmount = parseFloat(slipData.amount);
    const expected   = parseFloat(expectedAmount);
    if (Math.abs(slipAmount - expected) > 1) {
      return { valid: false, reason: 'AMOUNT_MISMATCH', data: slipData };
    }

    // ตรวจสอบเวลา (ไม่เกิน 30 นาที)
    const transTime    = new Date(slipData.transTimestamp);
    const diffMinutes  = (Date.now() - transTime.getTime()) / 60000;
    if (diffMinutes > 30) {
      return { valid: false, reason: 'SLIP_EXPIRED', data: slipData };
    }

    return { valid: true, reason: 'OK', data: slipData };
  } catch (err) {
    return { valid: false, reason: 'API_ERROR', error: err.message };
  }
}

module.exports = { verifySlip };
