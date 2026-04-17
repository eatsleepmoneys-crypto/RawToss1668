/**
 * TigerLotto — API Client
 * Central fetch wrapper + token/session manager
 * ใช้ได้ทั้ง index.html (member) และ admin/index.html (admin)
 */

const API_BASE = window.API_BASE || 'http://localhost:3000/api';

/* ─── Token Storage ─── */
const Token = {
  getMember : () => localStorage.getItem('tl_member_token'),
  getAdmin  : () => localStorage.getItem('tl_admin_token'),
  setMember : (t) => localStorage.setItem('tl_member_token', t),
  setAdmin  : (t) => localStorage.setItem('tl_admin_token', t),
  clearMember: () => localStorage.removeItem('tl_member_token'),
  clearAdmin : () => localStorage.removeItem('tl_admin_token'),
  getVerified: () => sessionStorage.getItem('tl_verified_token'),
  setVerified: (t) => sessionStorage.setItem('tl_verified_token', t),
  clearVerified: () => sessionStorage.removeItem('tl_verified_token'),
};

/* ─── Core Fetch ─── */
async function apiFetch(path, options = {}, tokenType = 'member') {
  const token = tokenType === 'admin' ? Token.getAdmin() : Token.getMember();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // FormData: อย่าใส่ Content-Type (ให้ browser จัดการ boundary)
  if (options.body instanceof FormData) delete headers['Content-Type'];

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ─── Member Auth API ─── */
const AuthAPI = {
  sendOtp: (phone) =>
    apiFetch('/auth/send-otp', { method: 'POST', body: JSON.stringify({ phone }) }),

  verifyOtp: async (phone, code) => {
    const data = await apiFetch('/auth/verify-otp', {
      method: 'POST', body: JSON.stringify({ phone, code })
    });
    if (data.verified_token) Token.setVerified(data.verified_token);
    return data;
  },

  register: async (payload) => {
    const data = await apiFetch('/auth/register', {
      method: 'POST', body: JSON.stringify(payload)
    });
    if (data.token) Token.setMember(data.token);
    Token.clearVerified();
    return data;
  },

  login: async (phone, password) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST', body: JSON.stringify({ phone, password })
    });
    if (data.token) Token.setMember(data.token);
    return data;
  },

  me: () => apiFetch('/auth/me'),

  logout: () => {
    Token.clearMember();
    Token.clearVerified();
    window.currentUser = null;
  },

  resetPassword: (phone, verified_token, new_password) =>
    apiFetch('/auth/reset-password', {
      method: 'POST', body: JSON.stringify({ phone, verified_token, new_password })
    }),
};

/* ─── Admin Auth API ─── */
const AdminAuthAPI = {
  login: async (email, password, role) => {
    const res = await apiFetch('/auth/admin/login', {
      method: 'POST', body: JSON.stringify({ email, password, role })
    }, 'admin');
    // Backend wraps payload in res.data: { token, admin }
    const token = res.data?.token || res.token;
    const admin = res.data?.admin || res.admin;
    if (token) Token.setAdmin(token);
    // Return flat object so admin/index.html can access data.token / data.admin directly
    return { ...res, token, admin };
  },

  me: () => apiFetch('/auth/admin/me', {}, 'admin'),

  logout: () => {
    Token.clearAdmin();
    window.currentAdmin = null;
  },
};

/* ─── Lottery API (Public) ─── */
const LotteryAPI = {
  getTypes    : () => apiFetch('/lottery/types'),
  getType     : (id) => apiFetch(`/lottery/types/${id}`),
  getRounds   : (params = {}) => apiFetch('/lottery/rounds?' + new URLSearchParams(params)),
  getResults  : (params = {}) => apiFetch('/lottery/results?' + new URLSearchParams(params)),
  getResult   : (roundId) => apiFetch(`/lottery/results/${roundId}`),
  checkNumber : (round_id, number) =>
    apiFetch('/lottery/check', { method: 'POST', body: JSON.stringify({ round_id, number }) }),
};

/* ─── Bets API ─── */
const BetsAPI = {
  place: (round_id, bets) =>
    apiFetch('/bets', { method: 'POST', body: JSON.stringify({ round_id, bets }) }),

  getBet: (uuid) => apiFetch(`/bets/${uuid}`),

  history: (params = {}) =>
    apiFetch('/members/bet-history?' + new URLSearchParams(params)),
};

/* ─── Transactions API ─── */
const TransactionsAPI = {
  deposit: (formData) =>
    apiFetch('/transactions/deposit', { method: 'POST', body: formData }),

  withdraw: (amount, bank_account, bank_name) =>
    apiFetch('/transactions/withdraw', {
      method: 'POST', body: JSON.stringify({ amount, bank_account, bank_name })
    }),

  history : (params = {}) =>
    apiFetch('/transactions/history?' + new URLSearchParams(params)),

  depositStatus: (id) => apiFetch(`/transactions/deposit-status?id=${id}`),
};

/* ─── Members API ─── */
const MemberAPI = {
  getProfile  : () => apiFetch('/members/profile'),
  updateProfile: (data) => apiFetch('/members/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  changePassword: (current_password, new_password) =>
    apiFetch('/members/change-password', { method: 'PATCH', body: JSON.stringify({ current_password, new_password }) }),
  getWallet       : () => apiFetch('/members/wallet'),
  getNotifications: (params = {}) => apiFetch('/members/notifications?' + new URLSearchParams(params)),
  getReferrals    : () => apiFetch('/members/referrals'),
};

/* ─── Admin APIs ─── */
const AdminAPI = {
  // Dashboard
  dashboard: () => apiFetch('/admin/dashboard', {}, 'admin'),

  // Members  (mounted at /api/members → route /admin/*)
  listMembers : (params = {}) => apiFetch('/members/admin/list?' + new URLSearchParams(params), {}, 'admin'),
  getMember   : (id) => apiFetch(`/members/admin/${id}`, {}, 'admin'),
  setMemberStatus: (id, status, reason) =>
    apiFetch(`/members/admin/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) }, 'admin'),
  adjustCredit: (id, amount, type, note) =>
    apiFetch(`/members/admin/${id}/credit`, { method: 'PATCH', body: JSON.stringify({ amount, type, note }) }, 'admin'),
  createMember: (data) =>
    apiFetch('/members/admin/create', { method: 'POST', body: JSON.stringify(data) }, 'admin'),

  // Agents
  listAgents  : (params = {}) => apiFetch('/admin/agents?' + new URLSearchParams(params), {}, 'admin'),
  createAgent : (data) => apiFetch('/admin/agents', { method: 'POST', body: JSON.stringify(data) }, 'admin'),
  updateAgent : (id, data) => apiFetch(`/admin/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, 'admin'),

  // Admins
  listAdmins          : () => apiFetch('/admin/admins', {}, 'admin'),
  createAdmin         : (data) => apiFetch('/admin/admins', { method: 'POST', body: JSON.stringify(data) }, 'admin'),
  updateAdmin         : (id, data) => apiFetch(`/admin/admins/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, 'admin'),
  deleteAdmin         : (id) => apiFetch(`/admin/admins/${id}`, { method: 'DELETE' }, 'admin'),
  resetAdminPassword  : (id, new_password) =>
    apiFetch(`/admin/admins/${id}/reset-password`, { method: 'PATCH', body: JSON.stringify({ new_password }) }, 'admin'),

  // Lottery admin
  getLotteryTypes : () => apiFetch('/lottery/admin/types', {}, 'admin'),
  updateLotteryType: (id, data) => apiFetch(`/lottery/admin/types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, 'admin'),
  listRoundsAdmin : (params = {}) => apiFetch('/lottery/admin/rounds?' + new URLSearchParams(params), {}, 'admin'),
  createRound     : (data) => apiFetch('/lottery/admin/rounds', { method: 'POST', body: JSON.stringify(data) }, 'admin'),
  closeRound      : (id) => apiFetch(`/lottery/admin/rounds/${id}/close`, { method: 'PATCH' }, 'admin'),
  announceResult  : (data) => apiFetch('/lottery/admin/results', { method: 'POST', body: JSON.stringify(data) }, 'admin'),

  // Bets admin
  listBets  : (params = {}) => apiFetch('/bets/admin/list?' + new URLSearchParams(params), {}, 'admin'),
  cancelBet : (id) => apiFetch(`/bets/admin/${id}/cancel`, { method: 'PATCH' }, 'admin'),

  // Deposits admin
  listDeposits   : (params = {}) => apiFetch('/transactions/admin/deposits?' + new URLSearchParams(params), {}, 'admin'),
  approveDeposit : (id, note) =>
    apiFetch(`/transactions/admin/deposits/${id}/approve`, { method: 'PATCH', body: JSON.stringify({ note }) }, 'admin'),
  rejectDeposit  : (id, note) =>
    apiFetch(`/transactions/admin/deposits/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ note }) }, 'admin'),

  // Withdrawals admin
  listWithdrawals   : (params = {}) => apiFetch('/transactions/admin/withdrawals?' + new URLSearchParams(params), {}, 'admin'),
  processWithdrawal : (id, ref_no) =>
    apiFetch(`/transactions/admin/withdrawals/${id}/process`, { method: 'PATCH', body: JSON.stringify({ ref_no }) }, 'admin'),
  rejectWithdrawal  : (id, note) =>
    apiFetch(`/transactions/admin/withdrawals/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ note }) }, 'admin'),

  // Reports
  reportSummary: (params = {}) => apiFetch('/admin/reports/summary?' + new URLSearchParams(params), {}, 'admin'),
  getLogs      : (params = {}) => apiFetch('/admin/logs?' + new URLSearchParams(params), {}, 'admin'),
  announce     : (message, type) =>
    apiFetch('/admin/announce', { method: 'POST', body: JSON.stringify({ message, type }) }, 'admin'),

  // Promotions
  listPromotions   : () => apiFetch('/admin/promotions', {}, 'admin'),
  createPromotion  : (data) => apiFetch('/admin/promotions', { method: 'POST', body: JSON.stringify(data) }, 'admin'),
  updatePromotion  : (id, data) => apiFetch(`/admin/promotions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, 'admin'),
  deletePromotion  : (id) => apiFetch(`/admin/promotions/${id}`, { method: 'DELETE' }, 'admin'),

  // Hot Numbers
  listHotNumbers   : (params = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v])=>v!==''&&v!=null))).toString();
    return apiFetch(`/admin/hot-numbers${qs?'?'+qs:''}`, {}, 'admin');
  },
  listHotRounds    : () => apiFetch('/admin/hot-numbers/rounds', {}, 'admin'),

  // KYC
  listKYC          : (status = 'pending', page = 1) => apiFetch(`/admin/kyc?status=${status}&page=${page}&limit=20`, {}, 'admin'),
  approveKYC       : (id) => apiFetch(`/admin/kyc/${id}/approve`, { method: 'PUT' }, 'admin'),
  rejectKYC        : (id, reason) => apiFetch(`/admin/kyc/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) }, 'admin'),

  // Settings
  getSettings    : () => apiFetch('/settings/admin/all', {}, 'admin'),
  updateSettings : (settings) =>
    apiFetch('/settings/admin', { method: 'PUT', body: JSON.stringify(settings) }, 'admin'),
  getApiKeys     : () => apiFetch('/settings/admin/api-keys', {}, 'admin'),
  updateApiKeys  : (keys) =>
    apiFetch('/settings/admin/api-keys', { method: 'PUT', body: JSON.stringify(keys) }, 'admin'),
  setMaintenance : (enabled, message) =>
    apiFetch('/settings/admin/maintenance', { method: 'POST', body: JSON.stringify({ enabled, message }) }, 'admin'),
};

/* ─── UI Helpers ─── */
const UI = {
  toast(msg, type = 'success', duration = 3000) {
    const colors = { success: '#2ecc71', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
    const t = document.createElement('div');
    t.style.cssText = `
      position:fixed;top:20px;right:20px;z-index:99999;
      background:${colors[type]||colors.info};color:#fff;
      padding:12px 20px;border-radius:8px;font-size:14px;
      box-shadow:0 4px 12px rgba(0,0,0,.3);
      animation:slideIn .3s ease;max-width:320px;word-break:break-word;
    `;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, duration);
  },

  loading(btn, state) {
    if (!btn) return;
    if (state) {
      btn._orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span style="opacity:.7">⏳ กำลังโหลด...</span>';
    } else {
      btn.disabled = false;
      btn.innerHTML = btn._orig || btn.innerHTML;
    }
  },

  formatMoney: (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  formatDate : (d) => d ? new Date(d).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-',
  formatDateOnly: (d) => d ? new Date(d).toLocaleDateString('th-TH') : '-',

  confirm(msg) { return window.confirm(msg); },
};

/* ─── Session init (ตรวจสอบ token ที่มีอยู่) ─── */
async function initMemberSession() {
  if (!Token.getMember()) return null;
  try {
    const data = await AuthAPI.me();
    window.currentUser = data.member;
    return data.member;
  } catch {
    Token.clearMember();
    return null;
  }
}

async function initAdminSession() {
  if (!Token.getAdmin()) return null;
  try {
    const data = await AdminAuthAPI.me();
    window.currentAdmin = data.admin;
    return data.admin;
  } catch {
    Token.clearAdmin();
    return null;
  }
}

/* ─── Export globals ─── */
window.API        = { AuthAPI, AdminAuthAPI, LotteryAPI, BetsAPI, TransactionsAPI, MemberAPI, AdminAPI };
window.Token      = Token;
window.UI         = UI;
window.initMemberSession = initMemberSession;
window.initAdminSession  = initAdminSession;

/* CSS animation สำหรับ toast */
if (!document.getElementById('tl-api-style')) {
  const s = document.createElement('style');
  s.id = 'tl-api-style';
  s.textContent = `@keyframes slideIn{from{transform:translateX(100px);opacity:0}to{transform:translateX(0);opacity:1}}`;
  document.head.appendChild(s);
}
