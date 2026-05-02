-- ==============================================================================
-- Migration: Add HuayDragon lottery types and bet types
-- Date: 2026-04-26
-- Description: Adds 24 new lottery types from HuayDragon API including Thai stocks,
--              international stocks, and specialized lottery formats (เลขชุด)
-- Safety: Uses INSERT IGNORE for idempotency - safe to run multiple times
-- ==============================================================================

-- ==============================================================================
-- Section 1: Insert new lottery_types
-- ==============================================================================

-- NOTE: Production schema uses `flag` (not `icon`) and has no `rounds_per_day` column
INSERT IGNORE INTO lottery_types (code, name, flag, sort_order) VALUES
('thai_am', 'หุ้นไทยเช้า', '📈', 10),
('thai_noon', 'หุ้นไทยเที่ยง', '📈', 11),
('thai_pm', 'หุ้นไทยบ่าย', '📈', 12),
('thai_eve', 'หุ้นไทยเย็น', '📈', 13),
('bank_stock', 'หวยธกส.', '🏦', 14),
('gsb', 'หวยออมสิน', '🏦', 15),
('stock_nk_am', 'หุ้นนิเคอิเช้า', '🇯🇵', 20),
('stock_nk_pm', 'หุ้นนิเคอิบ่าย', '🇯🇵', 21),
('stock_hk_am', 'หุ้นฮั่งเส็งเช้า', '🇭🇰', 22),
('stock_hk_pm', 'หุ้นฮั่งเส็งบ่าย', '🇭🇰', 23),
('stock_cn_am', 'หุ้นจีนเช้า', '🇨🇳', 24),
('stock_cn_pm', 'หุ้นจีนบ่าย', '🇨🇳', 25),
('stock_tw', 'หุ้นไต้หวัน', '🇹🇼', 26),
('stock_kr', 'หุ้นเกาหลี', '🇰🇷', 27),
('stock_sg', 'หุ้นสิงคโปร์', '🇸🇬', 28),
('stock_eg', 'หุ้นอียิปต์', '🇪🇬', 29),
('stock_de', 'หุ้นเยอรมัน', '🇩🇪', 30),
('stock_ru', 'หุ้นรัสเซีย', '🇷🇺', 31),
('stock_in', 'หุ้นอินเดีย', '🇮🇳', 32),
('stock_dj', 'หุ้นดาวโจนส์', '🇺🇸', 33),
('stock_my', 'หุ้นมาเลย์', '🇲🇾', 34),
('stock_uk', 'หุ้นอังกฤษ', '🇬🇧', 35),
('lao_set', 'หวยลาว (เลขชุด)', '🇱🇦', 40),
('hanoi_set', 'หวยฮานอย (เลขชุด)', '🇻🇳', 41),
('malay_set', 'หวยมาเลย์ (เลขชุด)', '🇲🇾', 42);

-- ==============================================================================
-- Section 2: Insert bet_types for Thai stocks (thai_am, thai_noon, thai_pm, thai_eve)
-- ==============================================================================

INSERT IGNORE INTO bet_types (lottery_type_id, code, name, digits, payout_rate, max_bet) VALUES
((SELECT id FROM lottery_types WHERE code = 'thai_am'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_am'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'thai_am'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_am'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_am'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'thai_am'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'thai_noon'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_noon'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'thai_noon'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_noon'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_noon'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'thai_noon'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'thai_pm'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_pm'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'thai_pm'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_pm'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_pm'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'thai_pm'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'thai_eve'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_eve'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'thai_eve'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_eve'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'thai_eve'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'thai_eve'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000);

-- ==============================================================================
-- Section 3: Insert bet_types for Bank stocks (bank_stock, gsb)
-- ==============================================================================

INSERT IGNORE INTO bet_types (lottery_type_id, code, name, digits, payout_rate, max_bet) VALUES
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'bank_stock'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'gsb'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'gsb'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'gsb'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'gsb'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'gsb'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'gsb'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000);

-- ==============================================================================
-- Section 4: Insert bet_types for International stocks (Nikkei AM/PM, HSI, China, etc.)
-- ==============================================================================

INSERT IGNORE INTO bet_types (lottery_type_id, code, name, digits, payout_rate, max_bet) VALUES
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_am'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_nk_pm'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_am'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_hk_pm'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_am'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_cn_pm'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_tw'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_tw'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_tw'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_tw'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_tw'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_tw'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_kr'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_kr'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_kr'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_kr'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_kr'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_kr'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_sg'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_sg'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_sg'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_sg'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_sg'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_sg'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_eg'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_eg'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_eg'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_eg'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_eg'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_eg'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_de'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_de'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_de'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_de'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_de'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_de'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_ru'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_ru'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_ru'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_ru'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_ru'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_ru'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_in'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_in'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_in'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_in'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_in'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_in'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_dj'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_dj'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_dj'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_dj'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_dj'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_dj'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_my'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_my'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_my'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_my'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_my'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_my'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000),

((SELECT id FROM lottery_types WHERE code = 'stock_uk'), '3_top', '3 ตัวบน', 3, 500.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_uk'), '3_tod', '3 โต๊ด', 3, 90.00, 10000),
((SELECT id FROM lottery_types WHERE code = 'stock_uk'), '2_top', '2 ตัวบน', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_uk'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'stock_uk'), 'run_top', 'วิ่งบน', 1, 2.50, 20000),
((SELECT id FROM lottery_types WHERE code = 'stock_uk'), 'run_bot', 'วิ่งล่าง', 1, 3.00, 20000);

-- ==============================================================================
-- Section 5: Insert bet_types for Set lotteries (lao_set, hanoi_set, malay_set)
-- Format: 4 digits (4 ตัวบน, 4 โต๊ด) + 2 ตัวล่าง
-- ==============================================================================

INSERT IGNORE INTO bet_types (lottery_type_id, code, name, digits, payout_rate, max_bet) VALUES
((SELECT id FROM lottery_types WHERE code = 'lao_set'), '4_top', '4 ตัวบน', 4, 2500.00, 2000),
((SELECT id FROM lottery_types WHERE code = 'lao_set'), '4_tod', '4 โต๊ด', 4, 200.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'lao_set'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),

((SELECT id FROM lottery_types WHERE code = 'hanoi_set'), '4_top', '4 ตัวบน', 4, 2500.00, 2000),
((SELECT id FROM lottery_types WHERE code = 'hanoi_set'), '4_tod', '4 โต๊ด', 4, 200.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'hanoi_set'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000),

((SELECT id FROM lottery_types WHERE code = 'malay_set'), '4_top', '4 ตัวบน', 4, 2500.00, 2000),
((SELECT id FROM lottery_types WHERE code = 'malay_set'), '4_tod', '4 โต๊ด', 4, 200.00, 5000),
((SELECT id FROM lottery_types WHERE code = 'malay_set'), '2_bot', '2 ตัวล่าง', 2, 65.00, 5000);

-- ==============================================================================
-- End of migration
-- ==============================================================================
    