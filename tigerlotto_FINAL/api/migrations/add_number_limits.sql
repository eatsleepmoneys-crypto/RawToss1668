-- ─────────────────────────────────────────────────────────────────
-- Migration: ระบบอั้นหวย (Lottery Number Limits / Tier System)
-- ─────────────────────────────────────────────────────────────────

-- 1. ตารางกำหนดถัง (template per lottery type + number)
CREATE TABLE IF NOT EXISTS `number_limits` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `lottery_id`    INT UNSIGNED NOT NULL COMMENT 'อ้างอิง lottery_types.id',
  `round_id`      INT UNSIGNED NULL      COMMENT 'NULL = template ใช้ทุกงวด, NOT NULL = override งวดเฉพาะ',
  `number`        VARCHAR(6) NOT NULL,
  `bet_type`      ENUM('3top','3tod','2top','2bot','run_top','run_bot') NOT NULL,
  -- ถัง 1: จ่ายเต็ม
  `tier1_limit`   DECIMAL(12,2) NOT NULL DEFAULT 0   COMMENT '0 = ไม่จำกัด',
  `tier1_used`    DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- ถัง 2: จ่าย % (หลัก)
  `tier2_rate`    DECIMAL(5,2)  NOT NULL DEFAULT 100  COMMENT 'เช่น 75 = 75% ของ rate ปกติ',
  `tier2_limit`   DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tier2_used`    DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- ถัง 2.1
  `tier2_1_rate`  DECIMAL(5,2)  NULL,
  `tier2_1_limit` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tier2_1_used`  DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- ถัง 2.2
  `tier2_2_rate`  DECIMAL(5,2)  NULL,
  `tier2_2_limit` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tier2_2_used`  DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- ถัง 2.3
  `tier2_3_rate`  DECIMAL(5,2)  NULL,
  `tier2_3_limit` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `tier2_3_used`  DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- สถานะปัจจุบัน
  `current_tier`  VARCHAR(5) NOT NULL DEFAULT '1' COMMENT '1 / 2 / 2.1 / 2.2 / 2.3 / 3',
  `escalated_at`  DATETIME NULL COMMENT 'เวลาที่ขยับไปถัง2',
  `closed_at`     DATETIME NULL COMMENT 'เวลาที่ปิดถัง3',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_nl` (`lottery_id`, `round_id`, `number`, `bet_type`),
  KEY `idx_round_num` (`round_id`, `number`, `bet_type`),
  KEY `idx_lt_num`    (`lottery_id`, `number`, `bet_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='ระบบอั้นหวย — ถัง1/2/3';

-- 2. เพิ่ม column rate_override ใน bets (บันทึก % ที่ใช้จริง ณ เวลาแทง)
ALTER TABLE `bets`
  ADD COLUMN `rate_override` DECIMAL(5,2) NULL DEFAULT NULL
    COMMENT 'NULL=full rate, 75=75% payout (tier2), 0=tier3(should not happen)'
    AFTER `rate`;
