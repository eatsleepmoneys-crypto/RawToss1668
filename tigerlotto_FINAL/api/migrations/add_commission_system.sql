-- ══════════════════════════════════════════════════════════════════
--  Migration: Commission & Discount System
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS referral_rate DECIMAL(5,2) NOT NULL DEFAULT 0
  COMMENT 'ค่าคอมจากสมาชิกที่แนะนำต่อ (%)';

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS referral_rate DECIMAL(5,2) NOT NULL DEFAULT 0
  COMMENT 'ค่าคอมจากสมาชิกที่แนะนำต่อ (%)';

CREATE TABLE IF NOT EXISTS commissions (
  id             INT           AUTO_INCREMENT PRIMARY KEY,
  uuid           VARCHAR(36)   NOT NULL UNIQUE,
  earner_type    ENUM('agent','member') NOT NULL,
  earner_id      INT           NOT NULL,
  from_member_id INT           NOT NULL,
  bet_id         INT           NOT NULL DEFAULT 0,
  bet_amount     DECIMAL(12,2) NOT NULL,
  rate           DECIMAL(5,2)  NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  description    VARCHAR(255),
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_earner      (earner_type, earner_id),
  INDEX idx_from_member (from_member_id),
  INDEX idx_created     (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
