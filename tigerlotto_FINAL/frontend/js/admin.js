/**
 * TigerLotto — admin.js
 * Admin Dashboard เชื่อม API จริง
 * ใช้กับ admin.html
 */

const ADMIN_MENU = [
  { sec: 'ภาพรวม' },
  { k:'dashboard',      icon:'📊', label:'Dashboard'              },
  { k:'users',          icon:'👥', label:'สมาชิก'                 },
  { k:'transactions',   icon:'💳', label:'ธุรกรรม'                },
  { k:'deposits',       icon:'📥', label:'อนุมัติฝาก', badge:true  },
  { k:'withdrawals',    icon:'📤', label:'อนุมัติถอน', badge:true  },
  { sec: 'แทงหวย (Admin)' },
  { k:'lottery_control',icon:'🔛', label:'เปิด/ปิดหวย'           },
  { k:'rounds',         icon:'📅', label:'จัดการงวด'             },
  { k:'enter_result',   icon:'🏆', label:'บันทึกผล'              },
  { k:'hot_numbers',    icon:'🔥', label:'เลขฮิต'                },
  { sec: 'สมาชิก & การเงิน' },
  { k:'kyc',            icon:'🪪', label:'ตรวจสอบ KYC'           },
  { k:'promotions_mgr', icon:'🎁', label:'จัดการโปรโมชั่น'       },
  { k:'wallets',        icon:'💰', label:'กระเป๋าเงินสมาชิก'     },
  { sec: 'ระบบ' },
  { k:'lottery_types',  icon:'🎯', label:'ประเภทหวย'             },
  { k:'settings',       icon:'⚙️', label:'ตั้งค่าระบบ'           },
  { k:'report',         icon:'📑', label:'รายงาน'                },
  { sec: 'การเชื่อมต่อ' },
  { k:'api_manager',    icon:'🔌', label:'API Manager'            },
];

let currentPage = 'dashboard';

// ── INIT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (!isLoggedIn()) { location.href = '/'; return; }
  const { user } = getSession();
  if (!['admin','superadmin'].includes(user?.role)) { location.href = '/'; return; }
  buildSidebar(); navTo('dashboard'); loadBadges();
});

async function loadBadges() {
  try {
    const [dep, wit, kyc] = await Promise.all([
      Admin.transactions({ type:'deposit',  status:'pending', limit:1 }),
      Admin.transactions({ type:'withdraw', status:'pending', limit:1 }),
      Admin.kycList({ status:'pending', limit:1 }),
    ]);
    // totals require count — use data length as approx or add header later
    // For now just set > 0 indicator
    const setBadge = (id, data) => {
      const el = document.getElementById(id);
      if (!el) return;
      const count = data?.total ?? data?.data?.length ?? 0;
      el.textContent = count > 99 ? '99+' : count;
      el.style.display = count > 0 ? '' : 'none';
    };
    // Re-fetch full counts
    const [depFull, witFull, kycFull] = await Promise.all([
      Admin.transactions({ type:'deposit',  status:'pending', limit:200 }),
      Admin.transactions({ type:'withdraw', status:'pending', limit:200 }),
      Admin.kycList({ status:'pending', limit:200 }),
    ]);
    setBadge('badge-deposits',   depFull);
    setBadge('badge-withdrawals', witFull);
    setBadge('badge-kyc',         kycFull);
  } catch(e) {}
}

function buildSidebar() {
  const nav = document.getElementById('sbNav');
  if (!nav) return;
  nav.innerHTML = ADMIN_MENU.map(m => {
    if (m.sec) return `<div class="sb-sec">${m.sec}</div>`;
    return `<div class="sb-item" id="sb-${m.k}" onclick="navTo('${m.k}')">
      <span class="sb-icon">${m.icon}</span>${m.label}
      ${m.badge ? `<span class="sb-badge" id="badge-${m.k}">0</span>` : ''}
    </div>`;
  }).join('');
}

async function navTo(key) {
  currentPage = key;
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('on'));
  document.getElementById('sb-' + key)?.classList.add('on');
  const label = ADMIN_MENU.find(m => m.k === key)?.label || key;
  document.getElementById('tbCrumb').textContent = label;
  const el = document.getElementById('mainContent');
  if (!el) return;
  el.innerHTML = '<div style="color:#444;font-size:12px;padding:20px;text-align:center">⏳ กำลังโหลด...</div>';
  try {
    switch(key) {
      case 'dashboard':    await renderDashboard(el);    break;
      case 'users':        await renderUsers(el);        break;
      case 'transactions': await renderTransactions(el); break;
      case 'deposits':     await renderDeposits(el);     break;
      case 'withdrawals':  await renderWithdrawals(el);  break;
      case 'rounds':       await renderRounds(el);       break;
      case 'enter_result': await renderEnterResult(el);  break;
      case 'hot_numbers':  await renderHotNumbers(el);   break;
      case 'kyc':          await renderKYC(el);          break;
      case 'settings':     await renderSettings(el);     break;
      case 'report':       await renderReport(el);       break;
      case 'api_manager':  await renderApiManager(el);   break;
      case 'lottery_control':  await renderLotteryControl(el);  break;
      case 'lottery_types':    await renderLotteryTypes(el);    break;
      case 'promotions_mgr':   await renderPromotionsMgr(el);   break;
      case 'wallets':          await renderWallets(el);         break;
      default: el.innerHTML = '<div style="color:#555;padding:20px">หน้านี้กำลังพัฒนา</div>';
    }
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:12px;padding:20px">${e.message}</div>`;
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────
async function renderDashboard(el) {
  const d = await Admin.dashboard();
  el.innerHTML = `
    <div class="pg-title">📊 Dashboard</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">สมาชิกทั้งหมด</div><div class="kpi-val">${(d.total_members||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--gold)"></div></div>
      <div class="kpi"><div class="kpi-lbl">แอ็กทีฟวันนี้</div><div class="kpi-val" style="color:var(--green)">${(d.active_today||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--green)"></div></div>
      <div class="kpi"><div class="kpi-lbl">รายได้วันนี้</div><div class="kpi-val">฿${parseFloat(d.revenue_today||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--blue)"></div></div>
      <div class="kpi"><div class="kpi-lbl">รอถอนเงิน</div><div class="kpi-val" style="color:var(--red)">฿${parseFloat(d.pending_withdraw||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--red)"></div></div>
    </div>
    ${d.pending_kyc > 0 ? `<div style="background:#1a0800;border:1.5px solid #D85A3055;border-radius:10px;padding:12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:12px;color:var(--red)">⚠️ รอตรวจสอบ KYC ${d.pending_kyc} รายการ</span>
      <button onclick="navTo('kyc')" style="padding:5px 12px;border-radius:7px;background:var(--red);border:none;color:#fff;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">ดูเลย</button>
    </div>` : ''}`;
}

// ── USERS ─────────────────────────────────────────────────────
async function renderUsers(el) {
  const res = await Admin.users({ limit: 30 });
  const users = res.data || [];
  el.innerHTML = `
    <div class="pg-title">👥 สมาชิก
      <div style="font-size:12px;color:#555">${(res.total||users.length).toLocaleString()} คน</div>
    </div>
    <div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr><th>ชื่อ</th><th>เบอร์</th><th>Role</th><th>VIP</th><th>ยืนยัน</th><th>สมัคร</th><th>จัดการ</th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td style="color:#ccc;font-weight:600">${u.first_name||''} ${u.last_name||''}</td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:10px">${u.phone||''}</td>
            <td><span class="badge ${u.role==='superadmin'||u.role==='admin'?'b-ok':u.role==='agent'?'b-pend':''}">
              ${u.role}</span></td>
            <td style="color:var(--gold)">⭐ ${u.vip_tier||'bronze'}</td>
            <td>${u.is_verified ? '<span class="badge b-ok">✓</span>' : '<span class="badge b-fail">✕</span>'}</td>
            <td style="font-size:10px;color:#555">${new Date(u.created_at).toLocaleDateString('th-TH')}</td>
            <td style="display:flex;gap:4px">
              <button onclick="toggleUser(${u.id},${u.is_active})"
                style="padding:2px 7px;border-radius:4px;font-size:8px;font-weight:700;cursor:pointer;font-family:inherit;
                       background:${u.is_active?'#1a0a0a':'#0a1a0a'};border:1px solid ${u.is_active?'#D85A3033':'#3BD44133'};
                       color:${u.is_active?'var(--red)':'var(--green)'}">
                ${u.is_active ? 'ระงับ' : 'เปิด'}
              </button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function toggleUser(id, isActive) {
  try {
    await Admin.userStatus(id, { is_active: isActive ? 0 : 1, is_banned: 0 });
    toast((isActive ? '🚫 ระงับ' : '✅ เปิด') + ' สมาชิก #' + id);
    navTo('users');
  } catch(e) { toast(e.message, 'err'); }
}

// ── TRANSACTIONS ──────────────────────────────────────────────
async function renderTransactions(el) {
  const res = await Admin.transactions({ limit: 30 });
  const txs = res.data || [];
  el.innerHTML = `
    <div class="pg-title">💳 ธุรกรรม</div>
    <div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr><th>REF</th><th>สมาชิก</th><th>ประเภท</th><th>จำนวน</th><th>สถานะ</th><th>เวลา</th></tr></thead>
        <tbody>${txs.map(tx => `
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#444">${tx.ref_no||''}</td>
            <td style="font-size:11px;color:#ccc">${tx.first_name||''} ${tx.last_name||''}</td>
            <td><span class="badge ${tx.type==='deposit'||tx.type==='win'?'b-ok':tx.type==='withdraw'?'b-fail':'b-pend'}">${tx.type}</span></td>
            <td style="font-size:12px;font-weight:700;color:${['deposit','win','bonus'].includes(tx.type)?'var(--green)':'var(--red)'}">
              ${['deposit','win','bonus'].includes(tx.type)?'+':'-'}฿${parseFloat(tx.amount||0).toLocaleString()}</td>
            <td><span class="badge ${tx.status==='success'?'b-ok':tx.status==='pending'?'b-pend':'b-fail'}">${tx.status}</span></td>
            <td style="font-size:10px;color:#555">${new Date(tx.created_at).toLocaleDateString('th-TH',{hour:'2-digit',minute:'2-digit'})}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── DEPOSITS ──────────────────────────────────────────────────
async function renderDeposits(el) {
  const res = await Admin.transactions({ type:'deposit', status:'pending', limit:50 });
  const txs = res.data || [];
  const badge = document.getElementById('badge-deposits');
  if (badge) badge.textContent = txs.length;

  el.innerHTML = `
    <div class="pg-title">📥 อนุมัติฝากเงิน
      <span style="font-size:12px;font-weight:400;color:#555">${txs.length} รายการรออนุมัติ</span>
    </div>
    ${txs.length ? `<div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr>
          <th>REF</th><th>สมาชิก</th><th>จำนวน</th><th>วิธีชำระ</th><th>วันที่</th><th style="min-width:180px">จัดการ</th>
        </tr></thead>
        <tbody>${txs.map(tx => `
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#444">${tx.ref_no||''}</td>
            <td style="color:#ccc">${tx.first_name||''} ${tx.last_name||''}<br>
              <span style="font-size:9px;color:#555">${tx.phone||''}</span>
            </td>
            <td style="font-size:14px;font-weight:900;color:var(--green)">+฿${parseFloat(tx.amount||0).toLocaleString()}</td>
            <td style="font-size:10px;color:#78BAFF">${tx.payment_method||'bank_transfer'}</td>
            <td style="font-size:10px;color:#555">${new Date(tx.created_at).toLocaleDateString('th-TH',{hour:'2-digit',minute:'2-digit'})}</td>
            <td style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 4px">
              ${tx.slip_image ? `<button onclick="viewSlip(${tx.id})"
                style="padding:4px 8px;border-radius:6px;background:var(--dark3);border:1px solid #78BAFF55;color:#78BAFF;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">
                🖼️ ดูสลิป
              </button>` : ''}
              <button onclick="approveTx(${tx.id},'deposit')"
                style="padding:4px 10px;border-radius:6px;background:linear-gradient(135deg,#1a9e2a,#0f6e1b);border:none;color:#fff;font-size:10px;font-weight:900;cursor:pointer;font-family:inherit">
                ✅ อนุมัติ
              </button>
              <button onclick="rejectTx(${tx.id},'deposit')"
                style="padding:4px 10px;border-radius:6px;background:var(--dark3);border:1px solid var(--red);color:var(--red);font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">
                ❌ ปฏิเสธ
              </button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="card" style="text-align:center;padding:30px;color:#444">✅ ไม่มีรายการรออนุมัติ</div>'}`;
}

// ── WITHDRAWALS ───────────────────────────────────────────────
async function renderWithdrawals(el) {
  const res = await Admin.transactions({ type:'withdraw', status:'pending', limit:50 });
  const txs = res.data || [];
  const badge = document.getElementById('badge-withdrawals');
  if (badge) badge.textContent = txs.length;

  el.innerHTML = `
    <div class="pg-title">📤 อนุมัติถอนเงิน
      <span style="font-size:12px;font-weight:400;color:#555">${txs.length} รายการรออนุมัติ</span>
    </div>
    ${txs.length ? `<div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr>
          <th>REF</th><th>สมาชิก</th><th>จำนวน</th><th>วันที่</th><th style="min-width:140px">จัดการ</th>
        </tr></thead>
        <tbody>${txs.map(tx => `
          <tr>
            <td style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#444">${tx.ref_no||''}</td>
            <td style="color:#ccc">${tx.first_name||''} ${tx.last_name||''}<br>
              <span style="font-size:9px;color:#555">${tx.phone||''}</span>
            </td>
            <td style="font-size:14px;font-weight:900;color:var(--gold)">฿${parseFloat(tx.amount||0).toLocaleString()}</td>
            <td style="font-size:10px;color:#555">${new Date(tx.created_at).toLocaleDateString('th-TH',{hour:'2-digit',minute:'2-digit'})}</td>
            <td style="display:flex;gap:6px;padding:8px 4px">
              <button onclick="approveTx(${tx.id},'withdraw')"
                style="padding:4px 10px;border-radius:6px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:10px;font-weight:900;cursor:pointer;font-family:inherit">
                ✅ อนุมัติ
              </button>
              <button onclick="rejectTx(${tx.id},'withdraw')"
                style="padding:4px 10px;border-radius:6px;background:var(--dark3);border:1px solid var(--red);color:var(--red);font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">
                ❌ ปฏิเสธ
              </button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="card" style="text-align:center;padding:30px;color:#444">✅ ไม่มีรายการรออนุมัติ</div>'}`;
}

// slip cache: store base64 by tx id after first fetch
const _slipCache = {};

function viewSlip(txId) {
  const cached = _slipCache[txId];
  if (cached) { _openSlipModal(cached); return; }
  // find the tx in current DOM data — slip_image already in the rendered data
  // Re-fetch from admin transactions to get slip_image (it may be a base64 data URI)
  Admin.transactions({ type: 'deposit', status: 'pending', limit: 50 }).then(res => {
    const tx = (res.data || []).find(t => t.id === txId);
    if (tx && tx.slip_image) {
      _slipCache[txId] = tx.slip_image;
      _openSlipModal(tx.slip_image);
    } else {
      toast('ไม่พบรูปสลิป', 'err');
    }
  }).catch(() => toast('โหลดสลิปไม่ได้', 'err'));
}

function _openSlipModal(src) {
  const existing = document.getElementById('slip-modal-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'slip-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#000a;z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `<img src="${src}" style="max-width:90vw;max-height:90vh;border-radius:12px;border:2px solid #B8860B55;box-shadow:0 0 40px #0008">`;
  document.body.appendChild(overlay);
}

async function approveTx(id, type) {
  if (!confirm(`ยืนยันอนุมัติ${type==='deposit'?'ฝากเงิน':'ถอนเงิน'}?`)) return;
  try {
    await Admin.approveTx(id);
    toast(`✅ อนุมัติ${type==='deposit'?'ฝากเงิน':'ถอนเงิน'}แล้ว`);
    navTo(type==='deposit'?'deposits':'withdrawals');
  } catch(e) { toast(e.message, 'err'); }
}

async function approveWithdraw(id) { await approveTx(id, 'withdraw'); }

async function rejectTx(id, type) {
  const note = prompt(`เหตุผลปฏิเสธ${type==='deposit'?'ฝากเงิน':'ถอนเงิน'} (ไม่บังคับ):`);
  if (note === null) return; // cancel
  try {
    await Admin.rejectTx(id, note || 'ถูกปฏิเสธโดย Admin');
    toast(`❌ ปฏิเสธ${type==='deposit'?'ฝากเงิน':'ถอนเงิน'}แล้ว${type==='withdraw'?' เงินคืนอัตโนมัติ':''}`);
    navTo(type==='deposit'?'deposits':'withdrawals');
  } catch(e) { toast(e.message, 'err'); }
}

// ── ENTER RESULT ──────────────────────────────────────────────
async function renderEnterResult(el) {
  const res = await Admin.adminRounds({ status:'closed', limit:30 });
  const rounds = res.data || [];

  const noRoundHint = rounds.length === 0 ? `
    <div style="background:#1A0A00;border:1px solid #D85A3033;border-radius:10px;padding:14px;margin-bottom:14px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">⚠️</span>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--gold)">ไม่มีงวดที่รอกรอกผล</div>
        <div style="font-size:10px;color:#777;margin-top:3px">
          ต้อง <span style="color:var(--gold);cursor:pointer;font-weight:700" onclick="navTo('rounds')">สร้างงวด → ปิดรับ</span> ก่อน จึงจะกรอกผลได้
        </div>
      </div>
    </div>` : '';

  el.innerHTML = `
    <div class="pg-title">🏆 บันทึกผลรางวัล
      <button onclick="renderEnterResult(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">🔄</button>
    </div>
    ${noRoundHint}
    <div class="card" style="${rounds.length===0?'opacity:.5;pointer-events:none':''}">
      <label style="font-size:11px;color:var(--gold);font-weight:700;margin-bottom:6px;display:block">📅 เลือกงวด (ที่ปิดรับแล้ว)</label>
      <select id="resultRoundId"
        style="width:100%;height:42px;background:var(--dark);border:1.5px solid #FFD70033;border-radius:8px;color:var(--gold);font-size:12px;padding:0 12px;font-family:inherit;outline:none;margin-bottom:14px">
        <option value="">-- เลือกงวด --</option>
        ${rounds.map(r=>`<option value="${r.id}">${r.lottery_name||''} — ${r.round_code||''}</option>`).join('')}
      </select>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">🥇 รางวัลที่ 1 (6 หลัก) *</label>
          <input class="finput" id="r1" placeholder="XXXXXX" maxlength="6"
            style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:900;letter-spacing:6px;text-align:center;height:52px;margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">2 ตัวล่าง *</label>
          <input class="finput" id="r2b" placeholder="XX" maxlength="2"
            style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:900;letter-spacing:6px;text-align:center;height:52px;margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:#aaa;font-weight:700;display:block;margin-bottom:4px">3 ตัวหลัง ชุดที่ 1</label>
          <input class="finput" id="r3b1" placeholder="XXX" maxlength="3"
            style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:900;letter-spacing:4px;text-align:center;margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:#aaa;font-weight:700;display:block;margin-bottom:4px">3 ตัวหลัง ชุดที่ 2</label>
          <input class="finput" id="r3b2" placeholder="XXX" maxlength="3"
            style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:900;letter-spacing:4px;text-align:center;margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:#aaa;font-weight:700;display:block;margin-bottom:4px">3 ตัวหน้า ชุดที่ 1</label>
          <input class="finput" id="r3f1" placeholder="XXX" maxlength="3"
            style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:900;letter-spacing:4px;text-align:center;margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:#aaa;font-weight:700;display:block;margin-bottom:4px">3 ตัวหน้า ชุดที่ 2</label>
          <input class="finput" id="r3f2" placeholder="XXX" maxlength="3"
            style="font-family:'JetBrains Mono',monospace;font-size:18px;font-weight:900;letter-spacing:4px;text-align:center;margin-bottom:0">
        </div>
      </div>

      <div style="background:#0a1a0a;border:1px solid #3BD44133;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:10px;color:#555">
        ⚠️ หลังกด "บันทึกผล" ระบบจะ <strong style="color:#3BD441">คำนวณรางวัลอัตโนมัติ</strong> และโอนเงินให้ผู้ถูกทันที ตรวจสอบตัวเลขให้ถูกต้องก่อนกด
      </div>
      <button id="submit-result-btn" onclick="submitResult()"
        style="width:100%;height:48px;border-radius:10px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;letter-spacing:.02em">
        ✅ บันทึกผลและจ่ายรางวัลทันที
      </button>
    </div>`;
}

async function submitResult() {
  const roundId = document.getElementById('resultRoundId')?.value;
  if (!roundId) return toast('กรุณาเลือกงวด', 'w');
  const body = {
    result_first:   document.getElementById('r1')?.value.trim(),
    result_2_back:  document.getElementById('r2b')?.value.trim(),
    result_3_back1: document.getElementById('r3b1')?.value.trim(),
    result_3_back2: document.getElementById('r3b2')?.value.trim(),
    result_3_front1:document.getElementById('r3f1')?.value.trim(),
    result_3_front2:document.getElementById('r3f2')?.value.trim(),
  };
  if (!body.result_first || body.result_first.length < 6) return toast('รางวัลที่ 1 ต้องมี 6 หลัก', 'w');
  if (!body.result_2_back || body.result_2_back.length < 2) return toast('กรุณาใส่ 2 ตัวล่าง', 'w');

  // ยืนยันก่อน submit
  const round = document.getElementById('resultRoundId');
  const roundName = round.options[round.selectedIndex]?.text || '';
  if (!confirm(`ยืนยันบันทึกผล?\n${roundName}\nรางวัลที่ 1: ${body.result_first}\n2 ตัวล่าง: ${body.result_2_back}`)) return;

  const btn = document.getElementById('submit-result-btn');
  if (btn) { btn.disabled=true; btn.textContent='⏳ กำลังบันทึกและคำนวณรางวัล...'; }
  try {
    await Admin.enterResult(roundId, body);
    toast('✅ บันทึกผลแล้ว! ระบบกำลังคำนวณรางวัลและโอนเงิน...');
    // รีโหลดหน้าหลังจาก 1.5 วินาที
    setTimeout(() => renderEnterResult(document.getElementById('mainContent')), 1500);
  } catch(e) {
    toast(e.message, 'err');
    if (btn) { btn.disabled=false; btn.textContent='✅ บันทึกผลและจ่ายรางวัลทันที'; }
  }
}

// ── HOT NUMBERS ───────────────────────────────────────────────
async function renderHotNumbers(el) {
  const res = await Admin.hotNumbers({ limit: 20 });
  const nums = res.data || [];
  el.innerHTML = `
    <div class="pg-title">🔥 เลขยอดนิยม</div>
    <div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr><th>#</th><th>เลข</th><th>จำนวนซื้อ</th><th>ยอดรวม</th><th>ความเสี่ยงจ่าย</th></tr></thead>
        <tbody>${nums.map((n,i) => {
          const risk = parseFloat(n.total_amount||0) * 750;
          return `<tr>
            <td style="color:${i<3?'var(--gold)':'#555'};font-weight:700">#${i+1}</td>
            <td style="font-size:18px;font-weight:900;font-family:'JetBrains Mono',monospace;color:var(--gold)">${n.number}</td>
            <td style="color:var(--blue)">${(n.bet_count||0).toLocaleString()} ครั้ง</td>
            <td style="color:var(--gold);font-weight:700">฿${parseFloat(n.total_amount||0).toLocaleString()}</td>
            <td style="color:${risk>500000?'var(--red)':'var(--green)'};font-weight:700">
              ฿${(risk/1000000).toFixed(1)}M ${risk>500000?'⚠️':''}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── KYC ───────────────────────────────────────────────────────
async function renderKYC(el) {
  const res = await Admin.kycList({ status:'pending' });
  const list = res.data || [];
  const badge = document.getElementById('badge-kyc');
  el.innerHTML = `
    <div class="pg-title">🪪 ตรวจสอบ KYC
      <span style="font-size:12px;font-weight:400;color:#555">${list.length} รายการ</span>
    </div>
    ${list.length ? list.map(k => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div>
            <div style="font-size:13px;font-weight:700;color:#fff">${k.first_name||''} ${k.last_name||''}</div>
            <div style="font-size:10px;color:#555;margin-top:2px">${k.phone||''}</div>
            <div style="font-size:10px;color:#555;margin-top:2px">เลขบัตร: <span style="font-family:'JetBrains Mono',monospace">${k.id_card_number||''}</span></div>
            <div style="font-size:10px;color:#555">ส่งมาเมื่อ: ${new Date(k.created_at).toLocaleDateString('th-TH')}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="approveKYC(${k.id})"
            style="flex:1;height:36px;border-radius:8px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:12px;font-weight:900;cursor:pointer;font-family:inherit">
            ✅ อนุมัติ
          </button>
          <button onclick="rejectKYC(${k.id})"
            style="flex:1;height:36px;border-radius:8px;background:#1a0a0a;border:1.5px solid #D85A3033;color:var(--red);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">
            ✕ ปฏิเสธ
          </button>
        </div>
      </div>`).join('') :
    '<div class="card" style="text-align:center;padding:30px;color:#444">✅ ไม่มีรายการรอตรวจสอบ</div>'}`;
}

async function approveKYC(id) {
  try { await Admin.approveKYC(id); toast('✅ อนุมัติ KYC แล้ว'); navTo('kyc'); }
  catch(e) { toast(e.message, 'err'); }
}
async function rejectKYC(id) {
  const reason = prompt('เหตุผลที่ปฏิเสธ:') || 'เอกสารไม่ชัดเจน';
  try { await Admin.rejectKYC(id, { reason }); toast('❌ ปฏิเสธ KYC แล้ว'); navTo('kyc'); }
  catch(e) { toast(e.message, 'err'); }
}

// ── SETTINGS ──────────────────────────────────────────────────
// ── SETTINGS ──────────────────────────────────────────────────
async function renderSettings(el) {
  let settings = [];
  try { const res = await Admin.settings(); settings = res.data || []; } catch(e) { toast(e.message,'err'); }

  const groups = {};
  settings.forEach(s => {
    const g = s.group_name || 'ทั่วไป';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  const groupIcons = {
    'agent':'👥','betting':'🎲','payment':'💳','promo':'🎁','risk':'⚠️',
    'system':'🖥️','sms':'📩','security':'🔒','notification':'🔔','ทั่วไป':'⚙️'
  };

  el.innerHTML = `
    <div class="pg-title">⚙️ ตั้งค่าระบบ
      <button onclick="renderSettings(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">🔄 รีเฟรช</button>
    </div>
    ${Object.keys(groups).map(grp => {
      const safeGrp = grp.replace(/[^a-zA-Z0-9]/g,'_');
      return `
      <div class="card" style="margin-bottom:12px;padding:0;overflow:hidden">
        <div style="padding:10px 14px;background:#0D0D0D;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:12px;font-weight:900;color:var(--gold)">${groupIcons[grp]||'⚙️'} ${grp}</span>
          <button onclick="saveSettingGroup('${safeGrp}')"
            style="padding:3px 12px;border-radius:6px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:9px;font-weight:900;cursor:pointer;font-family:inherit">
            💾 บันทึกทั้งกลุ่ม
          </button>
        </div>
        <div style="padding:4px 14px">
          ${groups[grp].map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #0f0f0f" data-grp="${safeGrp}">
              <div style="flex:1;min-width:0">
                <div style="font-size:11px;font-weight:700;color:var(--gold);font-family:'JetBrains Mono',monospace">${s.setting_key}</div>
                <div style="font-size:9px;color:#444;margin-top:2px">${s.description||''}</div>
              </div>
              <input id="setting-${s.setting_key}" value="${(s.value||'').replace(/"/g,'&quot;')}"
                style="width:160px;height:32px;background:var(--dark);border:1.5px solid #FFD70022;border-radius:7px;
                       color:#fff;font-size:12px;font-weight:600;padding:0 10px;font-family:inherit;outline:none;flex-shrink:0"
                onfocus="this.style.borderColor='var(--gold)'" onblur="this.style.borderColor='#FFD70022'">
              <button onclick="saveSetting('${s.setting_key}')"
                style="padding:3px 8px;border-radius:5px;background:#1A1200;border:1.5px solid #FFD70033;color:var(--gold);font-size:9px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0">
                บันทึก
              </button>
            </div>`).join('')}
        </div>
      </div>`;
    }).join('')}
    ${settings.length === 0 ? '<div class="card" style="text-align:center;padding:30px;color:#444">ไม่พบการตั้งค่า</div>' : ''}`;
}

async function saveSetting(key) {
  const val = document.getElementById('setting-' + key)?.value;
  try { await Admin.updateSetting(key, val); toast('✅ บันทึก ' + key); }
  catch(e) { toast(e.message, 'err'); }
}

async function saveSettingGroup(safeGrp) {
  const rows = document.querySelectorAll(`[data-grp="${safeGrp}"]`);
  let ok = 0, fail = 0;
  for (const row of rows) {
    const inp = row.querySelector('input');
    if (!inp) continue;
    const key = inp.id.replace('setting-', '');
    try { await Admin.updateSetting(key, inp.value); ok++; }
    catch { fail++; }
  }
  if (fail === 0) toast(`✅ บันทึก ${ok} รายการแล้ว`);
  else toast(`บันทึกสำเร็จ ${ok} / ล้มเหลว ${fail}`, 'w');
}

// ── REPORT ────────────────────────────────────────────────────
async function renderReport(el) {
  const now = new Date();
  const res  = await Admin.report({ year: now.getFullYear(), month: now.getMonth()+1 });
  el.innerHTML = `
    <div class="pg-title">📑 รายงานประจำเดือน
      <button onclick="renderReport(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">
        🔄 รีเฟรช
      </button>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-lbl">รายรับ</div><div class="kpi-val">฿${parseFloat(res.revenue||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--gold)"></div></div>
      <div class="kpi"><div class="kpi-lbl">จ่ายรางวัล</div><div class="kpi-val" style="color:var(--red)">฿${parseFloat(res.payout||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--red)"></div></div>
      <div class="kpi"><div class="kpi-lbl">กำไรสุทธิ</div><div class="kpi-val" style="color:var(--green)">฿${parseFloat(res.profit||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--green)"></div></div>
      <div class="kpi"><div class="kpi-lbl">สมาชิกใหม่</div><div class="kpi-val" style="color:var(--blue)">${(res.new_members||0).toLocaleString()}</div><div class="kpi-bar" style="background:var(--blue)"></div></div>
    </div>`;
}

// ── ROUNDS ────────────────────────────────────────────────────
async function renderRounds(el) {
  // Load lottery types (for create form)
  let types = [];
  try { const r = await Lottery.types(); types = Array.isArray(r) ? r : (r.data||[]); } catch {}
  // Load all rounds (admin view — all statuses)
  let rounds = [];
  try { const r = await Admin.adminRounds({ limit:60 }); rounds = r.data||[]; } catch {}

  const S_COLOR = { open:'#3BD441', closed:'#FFD700', resulted:'#78BAFF', upcoming:'#888', cancelled:'#D85A30' };
  const S_LABEL = { open:'รับแทง', closed:'ปิดรับ', resulted:'ออกผลแล้ว', upcoming:'รอเปิด', cancelled:'ยกเลิก' };

  el.innerHTML = `
    <div class="pg-title">📅 จัดการงวดหวย
      <button onclick="renderRounds(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">
        🔄 รีเฟรช
      </button>
    </div>

    <!-- ── สร้างงวดใหม่ ── -->
    <div class="card" style="border-color:#FFD70033;margin-bottom:14px">
      <div class="card-title" style="color:var(--gold);font-size:12px;margin-bottom:12px">➕ สร้างงวดใหม่</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">ประเภทหวย *</label>
          <select id="cr-type" onchange="autoRoundCode()"
            style="width:100%;height:40px;background:var(--dark);border:1.5px solid #FFD70033;border-radius:8px;color:#fff;font-size:12px;padding:0 10px;font-family:inherit;outline:none;margin-bottom:0">
            <option value="">-- เลือกประเภท --</option>
            ${types.map(t=>`<option value="${t.id}" data-code="${(t.code||t.slug||'').toUpperCase()}">${t.name_th||t.name||t.code}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">รหัสงวด *</label>
          <input class="finput" id="cr-code" placeholder="เช่น THAI-2026-04-01" style="margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">⏰ เปิดรับ</label>
          <input class="finput" type="datetime-local" id="cr-open" style="margin-bottom:0">
        </div>
        <div>
          <label style="font-size:10px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px">⏰ ปิดรับ</label>
          <input class="finput" type="datetime-local" id="cr-close" style="margin-bottom:0">
        </div>
      </div>
      <button onclick="createRound()"
        style="margin-top:12px;padding:10px 28px;border-radius:8px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:13px;font-weight:900;cursor:pointer;font-family:inherit">
        ➕ สร้างงวด
      </button>
    </div>

    <!-- ── รายการงวดทั้งหมด ── -->
    <div class="card" style="padding:0;overflow:hidden">
      <div class="card-title" style="padding:10px 14px;border-bottom:1px solid #1e1e1e">
        📋 งวดทั้งหมด &nbsp;<span style="color:#555;font-weight:400">${rounds.length} งวด</span>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th style="padding:8px 14px">งวด / รหัส</th>
            <th>เปิด</th><th>ปิด</th>
            <th>ยอดแทง</th><th>สถานะ</th><th>Action</th>
          </tr></thead>
          <tbody>
            ${rounds.length ? rounds.map(r => {
              const sc = S_COLOR[r.status]||'#888';
              const sl = S_LABEL[r.status]||r.status;
              const dtFmt = d => new Date(d).toLocaleString('th-TH',{dateStyle:'short',timeStyle:'short'});
              const actClose = r.status==='open' ?
                `<button onclick="closeRound(${r.id})"
                  style="padding:3px 9px;border-radius:6px;background:#1a0a0a;border:1px solid #D85A3033;color:var(--red);font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:4px">
                  🔒 ปิดรับ</button>` : '';
              const actResult = r.status==='closed' ?
                `<button onclick="navTo('enter_result')"
                  style="padding:3px 9px;border-radius:6px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:10px;font-weight:900;cursor:pointer;font-family:inherit">
                  🏆 กรอกผล</button>` : '';
              return `<tr>
                <td style="padding:8px 14px">
                  <div style="font-size:12px;font-weight:700;color:#fff">${r.lottery_name||'-'}</div>
                  <div style="font-size:9px;color:#555;font-family:'JetBrains Mono',monospace;margin-top:2px">${r.round_code||'-'}</div>
                </td>
                <td style="font-size:10px;color:#666">${r.open_at ? dtFmt(r.open_at) : '-'}</td>
                <td style="font-size:10px;color:#666">${r.close_at ? dtFmt(r.close_at) : '-'}</td>
                <td style="font-size:12px;font-weight:700;color:var(--gold)">฿${parseFloat(r.total_bet_amount||0).toLocaleString()}</td>
                <td><span class="badge" style="color:${sc};background:${sc}22;border:1px solid ${sc}44">${sl}</span></td>
                <td style="white-space:nowrap">${actClose}${actResult}</td>
              </tr>`;
            }).join('') : `<tr><td colspan="6" style="text-align:center;padding:30px;color:#444">ยังไม่มีงวด — สร้างงวดแรกด้านบน</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  // ตั้งเวลา default
  const pad = n => String(n).padStart(2,'0');
  const toLocal = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const crOpen = document.getElementById('cr-open');
  const crClose = document.getElementById('cr-close');
  if (crOpen && !crOpen.value) crOpen.value = toLocal(now);
  if (crClose && !crClose.value) {
    const def = new Date(now); def.setHours(20,29,0,0);
    if (def <= now) def.setDate(def.getDate()+1);
    crClose.value = toLocal(def);
  }
}

function autoRoundCode() {
  const sel = document.getElementById('cr-type');
  const inp = document.getElementById('cr-code');
  if (!sel || !inp) return;
  const code = sel.options[sel.selectedIndex]?.dataset?.code || '';
  if (!code) return;
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  inp.value = `${code}-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
}

async function createRound() {
  const lottery_type_id = document.getElementById('cr-type')?.value;
  const round_code = document.getElementById('cr-code')?.value.trim().toUpperCase();
  const open_at = document.getElementById('cr-open')?.value;
  const close_at = document.getElementById('cr-close')?.value;
  if (!lottery_type_id) return toast('กรุณาเลือกประเภทหวย', 'w');
  if (!round_code)      return toast('กรุณาระบุรหัสงวด', 'w');
  if (!open_at || !close_at) return toast('กรุณาระบุวันที่เปิด/ปิด', 'w');
  if (new Date(close_at) <= new Date(open_at)) return toast('วันปิดต้องหลังวันเปิด', 'w');
  try {
    await Admin.createRound({ lottery_type_id, round_code, round_name: round_code, open_at, close_at });
    toast('✅ สร้างงวดสำเร็จ');
    renderRounds(document.getElementById('mainContent'));
  } catch(e) { toast(e.message, 'err'); }
}

async function closeRound(id) {
  if (!confirm('ปิดรับงวดนี้?\nหลังปิดจะไม่สามารถรับยอดแทงเพิ่มได้')) return;
  try {
    await Admin.closeRound(id);
    toast('🔒 ปิดรับแล้ว — ไปที่ "บันทึกผล" เพื่อกรอกผลรางวัล');
    renderRounds(document.getElementById('mainContent'));
  } catch(e) { toast(e.message, 'err'); }
}

// ── LOTTERY CONTROL (เปิด/ปิดหวย) ─────────────────────────────
async function renderLotteryControl(el) {
  let types = [];
  try { const r = await api('GET', '/lottery/types?all=1'); types = r.data || []; } catch {}
  el.innerHTML = `
    <div class="pg-title">🔛 เปิด/ปิดหวย
      <button onclick="renderLotteryControl(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">🔄 รีเฟรช</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${types.length ? types.map(t => `
        <div class="card" style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:22px">${t.icon||'🎯'}</span>
            <div style="flex:1">
              <div style="font-size:12px;font-weight:700;color:#ccc">${t.name||''}</div>
              <div style="font-size:9px;color:#555;margin-top:2px">${t.category||''}</div>
            </div>
            <div onclick="toggleLotteryType(${t.id},${t.is_active})"
              style="width:38px;height:22px;border-radius:11px;cursor:pointer;position:relative;
                     background:${t.is_active?'var(--green)':'#333'};transition:background .2s;flex-shrink:0">
              <div style="position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;
                          transition:left .2s;left:${t.is_active?'19px':'3px'}"></div>
            </div>
          </div>
          <button onclick="quickCreateRound(${t.id},'${(t.code||t.slug||t.name||'').toUpperCase().replace(/'/g,'')}')"
            style="width:100%;padding:7px;border-radius:7px;background:rgba(255,215,0,.08);border:1px solid #FFD70033;
                   color:var(--gold);font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">
            ⚡ สร้างงวดด่วน (เปิดตอนนี้)
          </button>
        </div>`).join('') :
        '<div class="card" style="text-align:center;padding:30px;color:#444">ไม่พบข้อมูลประเภทหวย</div>'}
    </div>`;
}

async function toggleLotteryType(id, isActive) {
  try {
    await api('PUT', '/admin/lottery-types/' + id, { is_active: isActive ? 0 : 1 });
    toast((isActive ? '🔴 ปิด' : '🟢 เปิด') + ' หวยแล้ว');
    renderLotteryControl(document.getElementById('mainContent'));
  } catch(e) { toast(e.message, 'err'); }
}

async function quickCreateRound(typeId, typeCode) {
  const now = new Date();
  const close = new Date(now);
  // Default close: today at 20:29, or +3 days if already past
  close.setHours(20, 29, 0, 0);
  if (close <= now) close.setDate(close.getDate() + 3);

  const pad = n => String(n).padStart(2,'0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const roundCode = `${typeCode}-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  try {
    await Admin.createRound({
      lottery_type_id: typeId,
      round_code: roundCode,
      round_name: roundCode,
      open_at: fmt(now),
      close_at: fmt(close),
    });
    toast(`✅ สร้างงวด ${roundCode} แล้ว — เปิดรับแทงตอนนี้`);
    renderLotteryControl(document.getElementById('mainContent'));
  } catch(e) { toast(e.message || 'สร้างงวดไม่สำเร็จ', 'err'); }
}

// ── LOTTERY TYPES (ประเภทหวย) ─────────────────────────────────
async function renderLotteryTypes(el) {
  let types = [];
  try { const r = await Admin.lotteryTypes(true); types = r.data || []; } catch(e) { toast(e.message,'err'); }
  el.innerHTML = `
    <div class="pg-title">🎯 ประเภทหวย
      <button onclick="renderLotteryTypes(document.getElementById('mainContent'))"
        style="padding:5px 12px;border-radius:7px;background:var(--dark3);border:1.5px solid #1e1e1e;color:#888;font-size:11px;cursor:pointer;font-family:inherit">🔄 รีเฟรช</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead><tr>
          <th style="padding:10px 12px">ประเภทหวย</th>
          <th>รหัส</th><th>งวด/วัน</th><th>สถานะ</th><th>เปิด/ปิด</th>
        </tr></thead>
        <tbody>
          ${types.length ? types.map(t => `
            <tr>
              <td style="padding:10px 12px">
                <span style="font-size:20px">${t.icon||'🎯'}</span>
                <span style="color:#ccc;font-weight:700;margin-left:8px">${t.name||''}</span>
                ${t.description ? `<div style="font-size:9px;color:#444;margin-top:2px;margin-left:30px">${t.description}</div>` : ''}
              </td>
              <td><span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--gold);background:#1A1200;padding:2px 7px;border-radius:5px">${t.code||''}</span></td>
              <td style="color:#78BAFF;font-weight:700">${t.rounds_per_day||'-'}</td>
              <td><span class="badge ${t.is_active?'b-ok':'b-fail'}">${t.is_active?'● เปิด':'✕ ปิด'}</span></td>
              <td>
                <div onclick="toggleLotteryType(${t.id},${t.is_active})"
                  style="width:36px;height:20px;border-radius:10px;cursor:pointer;position:relative;display:inline-flex;align-items:center;
                         background:${t.is_active?'var(--green)':'#333'};transition:background .2s">
                  <div style="position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .2s;left:${t.is_active?'19px':'3px'}"></div>
                </div>
              </td>
            </tr>`).join('') :
            '<tr><td colspan="5" style="text-align:center;padding:30px;color:#444">ไม่พบข้อมูลประเภทหวย</td></tr>'}

        </tbody>
      </table>
    </div>`;
}

// ── PROMOTIONS MANAGER ─────────────────────────────────────────
async function renderPromotionsMgr(el) {
  el.innerHTML = `
    <div class="pg-title">🎁 จัดการโปรโมชั่น
      <button onclick="toast('ฟีเจอร์นี้กำลังพัฒนา','w')"
        style="padding:6px 14px;border-radius:8px;background:linear-gradient(135deg,var(--gold),var(--gold2));border:none;color:var(--dark);font-size:11px;font-weight:900;cursor:pointer;font-family:inherit">+ เพิ่มโปรโมชั่น</button>
    </div>
    <div class="card" style="text-align:center;padding:40px;color:#444">
      <div style="font-size:32px;margin-bottom:10px">🎁</div>
      <div style="font-size:13px;font-weight:700;color:#555">ระบบจัดการโปรโมชั่นกำลังพัฒนา</div>
      <div style="font-size:11px;color:#333;margin-top:6px">จะรองรับ: โบนัสสมัครใหม่, cashback, referral</div>
    </div>`;
}

// ── WALLETS ────────────────────────────────────────────────────
async function renderWallets(el) {
  const res = await Admin.users({ limit: 30 });
  const users = res.data || [];
  el.innerHTML = `
    <div class="pg-title">💰 กระเป๋าเงินสมาชิก</div>
    <div class="card" style="padding:8px;overflow-x:auto">
      <table>
        <thead><tr><th>ชื่อ</th><th>เบอร์</th><th>ยอดคงเหลือ</th><th>VIP</th><th>โบนัส</th></tr></thead>
        <tbody>${users.map(u => `
          <tr>
            <td style="color:#ccc;font-weight:600">${u.first_name||''} ${u.last_name||''}</td>
            <td style="font-family:'JetBrains Mono',monospace;font-size:10px">${u.phone||''}</td>
            <td style="font-size:13px;font-weight:700;color:var(--gold)">฿${parseFloat(u.balance||0).toLocaleString()}</td>
            <td style="color:var(--gold)">⭐ ${u.vip_tier||'bronze'}</td>
            <td style="color:var(--green)">฿${parseFloat(u.bonus_balance||0).toLocaleString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── LOGOUT ────────────────────────────────────────────────────
// ── API MANAGER ────────────────────────────────────────────────
async function renderApiManager(el) {
  el.innerHTML = `
    <div class="pg-title">🔌 API Manager</div>
    <div style="border-radius:10px;overflow:hidden;border:1px solid #1e1e1e;height:calc(100vh - 110px)">
      <iframe src="tigerlotto_api_manager.html" style="width:100%;height:100%;border:none;display:block"></iframe>
    </div>`;
}

function doLogout() { clearSession(); location.href = '/'; }

// ── TOAST ─────────────────────────────────────────────────────
let _t;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.className = 'toast on' + (type ? ' '+type : '');
  clearTimeout(_t); _t = setTimeout(() => el.classList.remove('on'), 2800);
}
