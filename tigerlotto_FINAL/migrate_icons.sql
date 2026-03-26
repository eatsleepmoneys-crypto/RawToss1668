-- Migration: อัปเดต icon ธงชาติ lottery_types
-- Run on Railway MySQL

UPDATE lottery_types SET icon = '🇹🇭' WHERE code = 'gov';
UPDATE lottery_types SET icon = '🇹🇭' WHERE code = 'set';
UPDATE lottery_types SET icon = '🇻🇳' WHERE code = 'hanoi';
UPDATE lottery_types SET icon = '🇻🇳' WHERE code = 'hanoi_vip';
UPDATE lottery_types SET icon = '🇻🇳' WHERE code = 'hanoi_special';
UPDATE lottery_types SET icon = '🇱🇦' WHERE code = 'laos';
-- yeekee คงไว้ ⚡ เพราะไม่มีธงประเทศ

-- ตรวจสอบ
SELECT code, name, icon FROM lottery_types ORDER BY sort_order;
