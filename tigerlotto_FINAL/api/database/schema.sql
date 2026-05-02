-- ═══════════════════════════════════════════════════════
-- TigerLotto Database Schema v1.0
-- MySQL 8.0+
-- ═══════════════════════════════════════════════════════

-- Database is selected via connection string (Railway uses 'railway' db)
-- Do NOT use CREATE DATABASE / USE here — tables go into the connected database

-- ─── DROP all tables in FK-safe order (child tables first) ──────────────────
DROP TABLE IF EXISTS `notifications`;
DROP TABLE IF EXISTS `admin_logs`;
DROP TABLE IF EXISTS `transactions`;
DROP TABLE IF EXISTS `bets`;
DROP TABLE IF EXISTS `deposits`;
DROP TABLE IF EXISTS `withdrawals`;
DROP TABLE IF EXISTS `lottery_results`;
DROP TABLE IF EXISTS `promotions`;
DROP TABLE IF EXISTS `otps`;
DROP TABLE IF EXISTS `agents`;
DROP TABLE IF EXISTS `lottery_rounds`;
DROP TABLE IF EXISTS `lottery_types`;
DROP TABLE IF EXISTS `settings`;
DROP TABLE IF EXISTS `members`;
DROP TABLE IF EXISTS `admins`;

-- ─────────────────────────────────────────
-- ADMINS (Multi-level: superadmin/admin/finance/staff)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `admins` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`          VARCHAR(36) NOT NULL UNIQUE,
  `name`          VARCHAR(100) NOT NULL,
  `email`         VARCHAR(150) NOT NULL UNIQUE,
  `password`      VARCHAR(255) NOT NULL,
  `role`          ENUM('superadmin','admin','finance','staff') NOT NULL DEFAULT 'staff',
  `is_active`     TINYINT(1) NOT NULL DEFAULT 1,
  `two_fa_secret` VARCHAR(100) DEFAULT NULL,
  `two_fa_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `last_login_at` DATETIME DEFAULT NULL,
  `last_login_ip` VARCHAR(45) DEFAULT NULL,
  `login_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`  DATETIME DEFAULT NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_email` (`email`),
  INDEX `idx_role`  (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- MEMBERS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `members` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`          VARCHAR(36) NOT NULL UNIQUE,
  `member_code`   VARCHAR(20) NOT NULL UNIQUE,
  `name`          VARCHAR(150) NOT NULL,
  `phone`         VARCHAR(20) NOT NULL UNIQUE,
  `email`         VARCHAR(150) DEFAULT NULL,
  `password`      VARCHAR(255) NOT NULL,
  `bank_code`     VARCHAR(20) DEFAULT NULL COMMENT 'KBANK,SCB,KTB,BBL,TTB',
  `bank_account`  VARCHAR(20) DEFAULT NULL,
  `bank_name`     VARCHAR(100) DEFAULT NULL,
  `balance`       DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `bonus_balance` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_deposit` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_withdraw` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_bet`     DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_win`     DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `level`         ENUM('bronze','silver','gold','platinum') NOT NULL DEFAULT 'bronze',
  `status`        ENUM('active','inactive','banned','pending') NOT NULL DEFAULT 'pending',
  `is_verified`   TINYINT(1) NOT NULL DEFAULT 0,
  `phone_verified` TINYINT(1) NOT NULL DEFAULT 0,
  `ref_by`        INT UNSIGNED DEFAULT NULL COMMENT 'referral member_id',
  `agent_id`      INT UNSIGNED DEFAULT NULL,
  `last_login_at` DATETIME DEFAULT NULL,
  `last_login_ip` VARCHAR(45) DEFAULT NULL,
  `login_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`  DATETIME DEFAULT NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_phone`   (`phone`),
  INDEX `idx_status`  (`status`),
  INDEX `idx_agent`   (`agent_id`),
  INDEX `idx_ref`     (`ref_by`),
  FOREIGN KEY (`ref_by`) REFERENCES `members`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- AGENTS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `agents` (
  `id`              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`            VARCHAR(36) NOT NULL UNIQUE,
  `name`            VARCHAR(150) NOT NULL,
  `phone`           VARCHAR(20) NOT NULL UNIQUE,
  `email`           VARCHAR(150) DEFAULT NULL,
  `password`        VARCHAR(255) NOT NULL,
  `commission_rate` DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  `balance`         DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_commission` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `status`          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- OTP (Phone Verification)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `otps` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `phone`      VARCHAR(20) NOT NULL,
  `code`       VARCHAR(10) NOT NULL,
  `type`       ENUM('register','login','withdraw','reset') NOT NULL,
  `is_used`    TINYINT(1) NOT NULL DEFAULT 0,
  `attempts`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_phone_type` (`phone`, `type`),
  INDEX `idx_expires`    (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- LOTTERY TYPES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `lottery_types` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `code`        VARCHAR(20) NOT NULL UNIQUE,
  `name`        VARCHAR(100) NOT NULL,
  `flag`        VARCHAR(10) DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `status`      ENUM('open','closed','maintenance') NOT NULL DEFAULT 'open',
  `min_bet`     DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  `max_bet`     DECIMAL(10,2) NOT NULL DEFAULT 5000.00,
  `rate_3top`   DECIMAL(8,2) NOT NULL DEFAULT 750.00,
  `rate_3tod`   DECIMAL(8,2) NOT NULL DEFAULT 120.00,
  `rate_2top`   DECIMAL(8,2) NOT NULL DEFAULT 95.00,
  `rate_2bot`   DECIMAL(8,2) NOT NULL DEFAULT 90.00,
  `rate_run_top` DECIMAL(8,2) NOT NULL DEFAULT 3.20,
  `rate_run_bot` DECIMAL(8,2) NOT NULL DEFAULT 4.20,
  `sort_order`  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- LOTTERY ROUNDS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `lottery_rounds` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`        VARCHAR(36) NOT NULL UNIQUE,
  `lottery_id`  INT UNSIGNED NOT NULL,
  `round_name`  VARCHAR(50) NOT NULL,
  `draw_date`   DATE NOT NULL,
  `close_at`    DATETIME NOT NULL,
  `status`      ENUM('upcoming','open','closed','announcing','announced','cancelled') NOT NULL DEFAULT 'upcoming',
  `total_bet`   DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `total_win`   DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `bet_count`   INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_lottery_date` (`lottery_id`, `draw_date`),
  INDEX `idx_status`       (`status`),
  FOREIGN KEY (`lottery_id`) REFERENCES `lottery_types`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- LOTTERY RESULTS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `lottery_results` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `round_id`      INT UNSIGNED NOT NULL UNIQUE,
  `prize_1st`     VARCHAR(6) DEFAULT NULL,
  `prize_2nd`     JSON DEFAULT NULL COMMENT '["xxxxxx","xxxxxx",...]',
  `prize_3rd`     JSON DEFAULT NULL,
  `prize_4th`     JSON DEFAULT NULL,
  `prize_5th`     JSON DEFAULT NULL,
  `prize_near_1st` JSON DEFAULT NULL COMMENT '2 prizes near 1st',
  `prize_front_3` JSON DEFAULT NULL COMMENT '["xxx","xxx"]',
  `prize_last_3`  JSON DEFAULT NULL COMMENT '["xxx","xxx"]',
  `prize_last_2`  VARCHAR(2) DEFAULT NULL,
  `prize_2bot`    VARCHAR(2) DEFAULT NULL,
  `announced_at`  DATETIME DEFAULT NULL,
  `announced_by`  INT UNSIGNED DEFAULT NULL COMMENT 'admin_id',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`round_id`)     REFERENCES `lottery_rounds`(`id`),
  FOREIGN KEY (`announced_by`) REFERENCES `admins`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- BETS (โพย)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `bets` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`        VARCHAR(36) NOT NULL UNIQUE,
  `member_id`   INT UNSIGNED NOT NULL,
  `round_id`    INT UNSIGNED NOT NULL,
  `bet_type`    ENUM('3top','3tod','2top','2bot','run_top','run_bot') NOT NULL,
  `number`      VARCHAR(6) NOT NULL,
  `amount`      DECIMAL(10,2) NOT NULL,
  `rate`        DECIMAL(8,2) NOT NULL,
  `payout`      DECIMAL(15,2) NOT NULL COMMENT 'amount * rate',
  `status`      ENUM('waiting','win','lose','cancelled','refunded') NOT NULL DEFAULT 'waiting',
  `win_amount`  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_member`  (`member_id`),
  INDEX `idx_round`   (`round_id`),
  INDEX `idx_status`  (`status`),
  INDEX `idx_number`  (`number`),
  FOREIGN KEY (`member_id`) REFERENCES `members`(`id`),
  FOREIGN KEY (`round_id`)  REFERENCES `lottery_rounds`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- DEPOSITS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `deposits` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`        VARCHAR(36) NOT NULL UNIQUE,
  `member_id`   INT UNSIGNED NOT NULL,
  `amount`      DECIMAL(15,2) NOT NULL,
  `bank_code`   VARCHAR(20) DEFAULT NULL,
  `slip_image`  VARCHAR(255) DEFAULT NULL,
  `transfer_at` DATETIME DEFAULT NULL,
  `status`      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `approved_by` INT UNSIGNED DEFAULT NULL,
  `approved_at` DATETIME DEFAULT NULL,
  `note`        TEXT DEFAULT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_member` (`member_id`),
  INDEX `idx_status` (`status`),
  FOREIGN KEY (`member_id`)   REFERENCES `members`(`id`),
  FOREIGN KEY (`approved_by`) REFERENCES `admins`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- WITHDRAWALS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `withdrawals` (
  `id`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`         VARCHAR(36) NOT NULL UNIQUE,
  `member_id`    INT UNSIGNED NOT NULL,
  `amount`       DECIMAL(15,2) NOT NULL,
  `bank_code`    VARCHAR(20) NOT NULL,
  `bank_account` VARCHAR(20) NOT NULL,
  `bank_name`    VARCHAR(100) NOT NULL,
  `status`       ENUM('pending','processing','completed','rejected','failed') NOT NULL DEFAULT 'pending',
  `processed_by` INT UNSIGNED DEFAULT NULL,
  `processed_at` DATETIME DEFAULT NULL,
  `ref_no`       VARCHAR(50) DEFAULT NULL COMMENT 'bank transfer ref',
  `note`         TEXT DEFAULT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_member` (`member_id`),
  INDEX `idx_status` (`status`),
  FOREIGN KEY (`member_id`)    REFERENCES `members`(`id`),
  FOREIGN KEY (`processed_by`) REFERENCES `admins`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- TRANSACTIONS (wallet history)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `transactions` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `uuid`        VARCHAR(36) NOT NULL UNIQUE,
  `member_id`   INT UNSIGNED NOT NULL,
  `type`        ENUM('deposit','withdraw','bet','win','refund','bonus','commission') NOT NULL,
  `amount`      DECIMAL(15,2) NOT NULL,
  `balance_before` DECIMAL(15,2) NOT NULL,
  `balance_after`  DECIMAL(15,2) NOT NULL,
  `ref_id`      INT UNSIGNED DEFAULT NULL COMMENT 'deposit_id, bet_id, etc.',
  `ref_type`    VARCHAR(20) DEFAULT NULL,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_member` (`member_id`),
  INDEX `idx_type`   (`type`),
  INDEX `idx_created` (`created_at`),
  FOREIGN KEY (`member_id`) REFERENCES `members`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- PROMOTIONS / BONUSES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `promotions` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `code`        VARCHAR(30) UNIQUE DEFAULT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `type`        ENUM('welcome','deposit','cashback','referral','manual') NOT NULL,
  `value`       DECIMAL(10,2) NOT NULL COMMENT 'amount or percent',
  `is_percent`  TINYINT(1) NOT NULL DEFAULT 0,
  `min_deposit` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `max_bonus`   DECIMAL(10,2) DEFAULT NULL,
  `usage_limit` INT UNSIGNED DEFAULT NULL,
  `usage_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`   TINYINT(1) NOT NULL DEFAULT 1,
  `start_at`    DATETIME DEFAULT NULL,
  `end_at`      DATETIME DEFAULT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- ACTIVITY LOGS (Admin)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `admin_logs` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `admin_id`    INT UNSIGNED DEFAULT NULL,
  `action`      VARCHAR(100) NOT NULL,
  `target_type` VARCHAR(50) DEFAULT NULL,
  `target_id`   INT UNSIGNED DEFAULT NULL,
  `detail`      TEXT DEFAULT NULL,
  `ip`          VARCHAR(45) DEFAULT NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_admin`   (`admin_id`),
  INDEX `idx_action`  (`action`),
  INDEX `idx_created` (`created_at`),
  FOREIGN KEY (`admin_id`) REFERENCES `admins`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- SYSTEM SETTINGS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `settings` (
  `key`        VARCHAR(100) PRIMARY KEY,
  `value`      TEXT DEFAULT NULL,
  `type`       ENUM('string','number','boolean','json') NOT NULL DEFAULT 'string',
  `group`      VARCHAR(50) NOT NULL DEFAULT 'general',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────
-- NOTIFICATIONS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `member_id`   INT UNSIGNED DEFAULT NULL COMMENT 'NULL = broadcast',
  `title`       VARCHAR(200) NOT NULL,
  `body`        TEXT NOT NULL,
  `type`        ENUM('system','win','deposit','withdraw','promo') NOT NULL DEFAULT 'system',
  `is_read`     TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_member` (`member_id`),
  INDEX `idx_read`   (`is_read`),
  FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ═══════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════

-- Super Admin — ON DUPLICATE KEY UPDATE resets password on every deploy
INSERT INTO `admins` (`uuid`,`name`,`email`,`password`,`role`,`is_active`,`login_attempts`) VALUES
('00000000-0000-0000-0000-000000000001','Super Admin','superadmin@tigerlotto.com',
 '$2a$12$t3nuvcQ7ilfJ9HhNpfXHh.F7K/bhOo7GXtvrVlsUOSHPVozJhdAHy','superadmin',1,0)
ON DUPLICATE KEY UPDATE
  password='$2a$12$t3nuvcQ7ilfJ9HhNpfXHh.F7K/bhOo7GXtvrVlsUOSHPVozJhdAHy',
  login_attempts=0,
  locked_until=NULL,
  is_active=1;
-- Password: Admin@1234

-- Lottery Types
INSERT INTO `lottery_types` (`code`,`name`,`flag`,`sort_order`,`rate_3top`,`rate_3tod`,`rate_2top`,`rate_2bot`,`rate_run_top`,`rate_run_bot`,`max_bet`) VALUES
('TH_GOV','หวยรัฐบาลไทย','🇹🇭',1,750,120,95,90,3.2,4.2,5000),
('CN_STK','หวยหุ้นจีน','🇨🇳',2,720,115,90,85,3.0,4.0,5000),
('VN_HAN','หวยฮานอย','🇻🇳',3,720,115,90,85,3.0,4.0,3000),
('VN_HAN_SP','ฮานอยพิเศษ','🇻🇳',31,720,115,90,85,3.0,4.0,3000),
('VN_HAN_VIP','ฮานอย VIP','🇻🇳',32,720,115,90,85,3.0,4.0,3000),
('LA_GOV','หวยลาว','🇱🇦',4,700,110,88,83,3.0,4.0,3000),
('YEEKEE','หวยยี่กี','🎲',5,700,110,85,80,3.0,3.8,2000),
('MY_STK','หวยมาเลย์','🇲🇾',6,720,115,90,85,3.0,4.0,3000),
('SG_STK','หวยสิงคโปร์','🇸🇬',7,720,115,90,85,3.0,4.0,3000),
('TH_STK','หวยหุ้นไทย','📈',8,720,115,90,85,3.0,4.0,5000);

-- System Settings
INSERT INTO `settings` (`key`,`value`,`type`,`group`) VALUES
('site_name','TigerLotto','string','general'),
('site_url','https://tigerlotto.com','string','general'),
('maintenance_mode','false','boolean','general'),
('min_deposit','100','number','finance'),
('max_deposit','100000','number','finance'),
('min_withdraw','100','number','finance'),
('max_withdraw','50000','number','finance'),
('auto_approve_deposit','false','boolean','finance'),
('auto_approve_max','1000','number','finance'),
('bonus_new_member','50','number','promotion'),
('cashback_percent','5','number','promotion'),
('referral_commission','3','number','promotion'),
('line_id','@tigerlotto','string','contact'),
('contact_tel','02-xxx-xxxx','string','contact'),
('sms_enabled','false','boolean','sms'),
('line_enabled','false','boolean','line'),
('session_expire','60','number','security'),
('login_max_attempt','5','number','security'),
('require_2fa_admin','true','boolean','security');

-- Default Promotion
INSERT INTO `promotions` (`code`,`name`,`type`,`value`,`is_percent`,`is_active`) VALUES
('WELCOME50','โบนัสต้อนรับสมาชิกใหม่','welcome',50,0,1),
('CASHBACK5','คืนยอด 5% ทุกงวด','cashback',5,1,1),
('REF3','ค่าแนะนำเพื่อน 3%','referral',3,1,1);
