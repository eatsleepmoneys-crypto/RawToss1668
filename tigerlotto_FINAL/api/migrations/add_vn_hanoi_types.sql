-- Migration: Add VN_HAN_SP/VIP lottery types and prize_2bot column
-- Date: 2026-04-27
-- Safe to run multiple times (IF NOT EXISTS / INSERT IGNORE)

-- 1. Add prize_2bot column (2-digit bottom prize for VN/LA types)
ALTER TABLE lottery_results
  ADD COLUMN IF NOT EXISTS prize_2bot VARCHAR(2) DEFAULT NULL AFTER prize_last_2;

-- 2. Add VN_HAN_SP and VN_HAN_VIP lottery types
INSERT IGNORE INTO lottery_types
  (code, name, flag, sort_order, rate_3top, rate_3tod, rate_2top, rate_2bot, rate_run_top, rate_run_bot, max_bet)
VALUES
  ('VN_HAN_SP',  'ฮานอยพิเศษ', '🇻🇳', 31, 720, 115, 90, 85, 3.0, 4.0, 3000),
  ('VN_HAN_VIP', 'ฮานอย VIP',  '🇻🇳', 32, 720, 115, 90, 85, 3.0, 4.0, 3000);
