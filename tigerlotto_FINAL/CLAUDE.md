# TigerLotto / RawToss1668 — Project Context

## URLs
- **Production**: https://rawtoss1668.com
- **Railway (direct)**: https://rawtoss1668-production.up.railway.app
- **Admin Panel**: https://rawtoss1668.com/admin/
- **Agent Portal**: https://rawtoss1668.com/agent/
- **GitHub**: https://github.com/eatsleepmoneys-crypto/RawToss1668
- **Health check**: https://rawtoss1668.com/api/health

## Deploy
- **Platform**: Railway (auto-deploy จาก GitHub `main` branch)
- **Push แล้ว deploy อัตโนมัติ** — ไม่ต้องทำอะไรเพิ่ม
- **DB**: MySQL บน Railway (ตัวแปร MYSQLDATABASE, MYSQLHOST ฯลฯ)
- **TZ**: Asia/Bangkok (set ใน server.js บรรทัดแรก)

## Project Structure
```
tigerlotto_FINAL/
├── api/                    # Node.js / Express backend
│   ├── server.js           # Entry point, middleware, routes, cron
│   ├── config/db.js        # MySQL connection pool
│   ├── middleware/
│   │   ├── auth.js         # JWT: authMember, authAdmin, authAgent
│   │   └── rbac.js         # requirePerm('resource.action')
│   ├── routes/             # API routes
│   │   ├── auth.js         # /api/auth — login/register/OTP
│   │   ├── members.js      # /api/members
│   │   ├── bets.js         # /api/bets
│   │   ├── transactions.js # /api/transactions — deposit/withdraw
│   │   ├── lottery.js      # /api/lottery — rounds/results/payout-rates
│   │   ├── admin.js        # /api/admin — admin management
│   │   ├── agent.js        # /api/agent — agent portal
│   │   ├── settings.js     # /api/settings — LINE/KBank/SlipOK/favicon
│   │   ├── promotions.js   # /api/promotions
│   │   ├── numberLimits.js # /api/number-limits
│   │   └── lineWebhook.js  # /api/webhooks/line — LINE Bot + auto-reply
│   ├── services/
│   │   ├── lineService.js  # LINE Notify + Messaging API + replyMessage
│   │   ├── kbankService.js # KBank OAuth2 + fund transfer
│   │   ├── slipVerifier.js # SlipOK API
│   │   ├── roundManager.js # Yeekee auto-open/close/announce (cron)
│   │   └── lotteryFetcher.js # TH/LA/VN auto-fetch results (cron)
│   └── database/
│       ├── migrate.js      # Auto-migration (idempotent, runs on startup)
│       └── schema.sql      # Full DB schema reference
├── frontend/
│   ├── index.html          # หน้าหลัก (member)
│   ├── admin/index.html    # Admin Panel (SPA)
│   ├── agent/index.html    # Agent Portal (SPA)
│   └── assets/
│       ├── js/api.js       # API client: AuthAPI, AdminAPI, MemberAPI ฯลฯ
│       └── favicon.svg     # Default favicon (fallback)
```

## Tech Stack
- **Backend**: Node.js, Express, MySQL2, bcryptjs, jsonwebtoken, axios, node-cron
- **Frontend**: Vanilla JS (ไม่ใช้ framework), CSS variables, single-file SPA
- **Auth**: JWT — member token (`tl_member_token`), admin token (`tl_admin_token`), agent token (`agent_token`)
- **RBAC**: `admins.permissions` JSON field — `rbac.requirePerm('resource.action')`

## Key Patterns

### DB Query
```js
const { query } = require('../config/db');
const rows = await query('SELECT * FROM table WHERE id=?', [id]);
const [row] = rows; // first row or undefined
```

### Auth Middleware
```js
router.get('/path', authAdmin, rbac.requirePerm('members.view'), async (req, res) => {
  req.admin.id / req.admin.role  // admin info
});
```

### API Response Format
```js
res.json({ success: true, data: rows });
res.status(400).json({ success: false, message: 'error text' });
```

### Migration (safe ALTER)
เพิ่มใน `ALTERS` array ใน `migrate.js` — idempotent (errno 1060/1061 = already exists, ข้ามได้)

### Settings Table
```js
await query(
  'INSERT INTO settings (`key`,value,type,`group`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE value=?',
  [key, value, 'string', 'general', value]
);
```
⚠️ ใช้ `` `group` `` (backtick) ไม่ใช่ `category`

## Admin Login
- **Email**: superadmin@tigerlotto.com
- **Password**: ดูใน Railway env `ADMIN_PASSWORD`
- **Phone login**: ตั้งเบอร์ใน Admin → Admins → 📱 เบอร์ แล้ว login ผ่านหน้าหลักได้

## Lottery Types
| Code | ชื่อ |
|------|------|
| TH_GOV | หวยรัฐบาลไทย |
| LA_GOV | ลาวพัฒนา |
| VN_HAN | ฮานอยปกติ |
| VN_HAN_SP | ฮานอยพิเศษ |
| VN_HAN_VIP | ฮานอย VIP |
| YEEKEE_* | ยี่กีหลายประเภท |

## External Services
| Service | ใช้ทำอะไร | ตั้งค่าที่ |
|---------|-----------|-----------|
| SlipOK | ตรวจสลิปอัตโนมัติ | Admin → Settings → SlipOK |
| KBank API | โอนเงินถอนอัตโนมัติ | Admin → Settings → KBank |
| LINE Notify | แจ้งเตือนกลุ่ม | Admin → Settings → LINE |
| LINE Messaging API | Bot ตอบคำสั่ง | Admin → Settings → LINE |

## LINE Bot Commands
สมาชิกพิมพ์ใน LINE (DM หรือกลุ่ม):
- `ยอด` → ยอดเงินคงเหลือ (ต้องผูกบัญชีก่อน)
- `ผล` → ผลหวยล่าสุด
- `ผูก 0812345678` → ผูก LINE กับบัญชีสมาชิก (DM เท่านั้น)
- `ยกเลิกผูก` → ยกเลิกการผูก
- `ช่วย` → แสดงคำสั่งทั้งหมด

Webhook URL: `https://rawtoss1668.com/api/webhooks/line`

## Frontend API Client (api.js)
```js
API.AuthAPI.login(phone, pass)
API.AdminAPI.listMembers(page, search)
API.AdminAPI.setAdminPhone(id, phone)
API.AdminAPI.uploadFavicon(dataUrl)
API.AdminAPI.testLineNotify()
API.MemberAPI.getBalance()
// ดูไฟล์ frontend/assets/js/api.js สำหรับ methods ทั้งหมด
```

## สิ่งที่ยังไม่ได้ทำ (อาจทำต่อ)
- PromptPay QR อัตโนมัติ
- PWA (manifest.json + service worker)
- Dashboard กราฟ (รายได้/ยอดแทงรายวัน)
- Referral System (โครงสร้าง referral_rate มีแล้ว แต่ยังไม่ได้ wire)
