// Run: node database/migrate.js
require('dotenv').config();
const mysql = require('mysql2/promise');

// ─── รองรับ Railway DATABASE_URL ───
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      host    : u.hostname,
      port    : parseInt(u.port) || 3306,
      database: u.pathname.replace('/', ''),
      user    : u.username,
      password: u.password,
    };
  } catch { return null; }
}

// ─── Table definitions (JS strings, no file parsing needed) ─────────────────

const DROPS = [
  // Drop child tables first (FK-safe order)
  'DROP TABLE IF EXISTS `notifications`',
  'DROP TABLE IF EXISTS `admin_logs`',
  'DROP TABLE IF EXISTS `transactions`',
  'DROP TABLE IF EXISTS `bets`',
  'DROP TABLE IF EXISTS `deposits`',
  'DROP TABLE IF EXISTS `withdrawals`',
  'DROP TABLE IF EXISTS `lottery_results`',
  'DROP TABLE IF EXISTS `promotions`',
  'DROP TABLE IF EXISTS `otps`',
  'DROP TABLE IF EXISTS `agents`',
  'DROP TABLE IF EXISTS `lottery_rounds`',
  'DROP TABLE IF EXISTS `lottery_types`',
  'DROP TABLE IF EXISTS `settings`',
  'DROP TABLE IF EXISTS `members`',
  'DROP TABLE IF EXISTS `admins`',
];

const CREATES = [
  // admins
  `CREATE TABLE IF NOT EXISTS \`admins\` (
    \`id\`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`           VARCHAR(36) NOT NULL UNIQUE,
    \`name\`           VARCHAR(100) NOT NULL,
    \`email\`          VARCHAR(150) NOT NULL UNIQUE,
    \`password\`       VARCHAR(255) NOT NULL,
    \`role\`           ENUM('superadmin','admin','finance','staff') NOT NULL DEFAULT 'staff',
    \`is_active\`      TINYINT(1) NOT NULL DEFAULT 1,
    \`two_fa_secret\`  VARCHAR(100) DEFAULT NULL,
    \`two_fa_enabled\` TINYINT(1) NOT NULL DEFAULT 0,
    \`last_login_at\`  DATETIME DEFAULT NULL,
    \`last_login_ip\`  VARCHAR(45) DEFAULT NULL,
    \`login_attempts\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`locked_until\`   DATETIME DEFAULT NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_email\` (\`email\`),
    INDEX \`idx_role\`  (\`role\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // members
  `CREATE TABLE IF NOT EXISTS \`members\` (
    \`id\`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`           VARCHAR(36) NOT NULL UNIQUE,
    \`member_code\`    VARCHAR(20) NOT NULL UNIQUE,
    \`name\`           VARCHAR(150) NOT NULL,
    \`phone\`          VARCHAR(20) NOT NULL UNIQUE,
    \`email\`          VARCHAR(150) DEFAULT NULL,
    \`password\`       VARCHAR(255) NOT NULL,
    \`bank_code\`      VARCHAR(20) DEFAULT NULL,
    \`bank_account\`   VARCHAR(20) DEFAULT NULL,
    \`bank_name\`      VARCHAR(100) DEFAULT NULL,
    \`balance\`        DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`bonus_balance\`  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_deposit\`  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_withdraw\` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_bet\`      DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_win\`      DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`level\`          ENUM('bronze','silver','gold','platinum') NOT NULL DEFAULT 'bronze',
    \`status\`         ENUM('active','inactive','banned','pending') NOT NULL DEFAULT 'pending',
    \`is_verified\`    TINYINT(1) NOT NULL DEFAULT 0,
    \`phone_verified\` TINYINT(1) NOT NULL DEFAULT 0,
    \`ref_by\`         INT UNSIGNED DEFAULT NULL,
    \`agent_id\`       INT UNSIGNED DEFAULT NULL,
    \`last_login_at\`  DATETIME DEFAULT NULL,
    \`last_login_ip\`  VARCHAR(45) DEFAULT NULL,
    \`login_attempts\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`locked_until\`   DATETIME DEFAULT NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_phone\`  (\`phone\`),
    INDEX \`idx_status\` (\`status\`),
    INDEX \`idx_agent\`  (\`agent_id\`),
    INDEX \`idx_ref\`    (\`ref_by\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // agents
  `CREATE TABLE IF NOT EXISTS \`agents\` (
    \`id\`               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`             VARCHAR(36) NOT NULL UNIQUE,
    \`name\`             VARCHAR(150) NOT NULL,
    \`phone\`            VARCHAR(20) NOT NULL UNIQUE,
    \`email\`            VARCHAR(150) DEFAULT NULL,
    \`password\`         VARCHAR(255) NOT NULL,
    \`commission_rate\`  DECIMAL(5,2) NOT NULL DEFAULT 3.00,
    \`balance\`          DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_commission\` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`status\`           ENUM('active','inactive') NOT NULL DEFAULT 'active',
    \`created_at\`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_phone\` (\`phone\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // otps
  `CREATE TABLE IF NOT EXISTS \`otps\` (
    \`id\`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`phone\`      VARCHAR(20) NOT NULL,
    \`code\`       VARCHAR(10) NOT NULL,
    \`type\`       ENUM('register','login','withdraw','reset') NOT NULL,
    \`is_used\`    TINYINT(1) NOT NULL DEFAULT 0,
    \`attempts\`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`expires_at\` DATETIME NOT NULL,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_phone_type\` (\`phone\`, \`type\`),
    INDEX \`idx_expires\`    (\`expires_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // lottery_types
  `CREATE TABLE IF NOT EXISTS \`lottery_types\` (
    \`id\`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`code\`         VARCHAR(20) NOT NULL UNIQUE,
    \`name\`         VARCHAR(100) NOT NULL,
    \`flag\`         VARCHAR(10) DEFAULT NULL,
    \`description\`  TEXT DEFAULT NULL,
    \`status\`       ENUM('open','closed','maintenance') NOT NULL DEFAULT 'open',
    \`min_bet\`      DECIMAL(10,2) NOT NULL DEFAULT 1.00,
    \`max_bet\`      DECIMAL(10,2) NOT NULL DEFAULT 5000.00,
    \`rate_3top\`    DECIMAL(8,2) NOT NULL DEFAULT 750.00,
    \`rate_3tod\`    DECIMAL(8,2) NOT NULL DEFAULT 120.00,
    \`rate_2top\`    DECIMAL(8,2) NOT NULL DEFAULT 95.00,
    \`rate_2bot\`    DECIMAL(8,2) NOT NULL DEFAULT 90.00,
    \`rate_run_top\` DECIMAL(8,2) NOT NULL DEFAULT 3.20,
    \`rate_run_bot\` DECIMAL(8,2) NOT NULL DEFAULT 4.20,
    \`sort_order\`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // lottery_rounds
  `CREATE TABLE IF NOT EXISTS \`lottery_rounds\` (
    \`id\`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`        VARCHAR(36) NOT NULL UNIQUE,
    \`lottery_id\`  INT UNSIGNED NOT NULL,
    \`round_code\`  VARCHAR(50) DEFAULT NULL,
    \`round_name\`  VARCHAR(100) NOT NULL,
    \`draw_date\`   DATE NOT NULL,
    \`open_at\`     DATETIME DEFAULT NULL,
    \`close_at\`    DATETIME NOT NULL,
    \`status\`      ENUM('upcoming','open','closed','announcing','announced','cancelled') NOT NULL DEFAULT 'upcoming',
    \`total_bet\`   DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`total_win\`   DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`bet_count\`   INT UNSIGNED NOT NULL DEFAULT 0,
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY \`uk_round_code\` (\`round_code\`),
    INDEX \`idx_lottery_date\` (\`lottery_id\`, \`draw_date\`),
    INDEX \`idx_status\`       (\`status\`),
    INDEX \`idx_close_at\`     (\`close_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // lottery_results
  `CREATE TABLE IF NOT EXISTS \`lottery_results\` (
    \`id\`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`round_id\`       INT UNSIGNED NOT NULL UNIQUE,
    \`prize_1st\`      VARCHAR(6) DEFAULT NULL,
    \`prize_2nd\`      JSON DEFAULT NULL,
    \`prize_3rd\`      JSON DEFAULT NULL,
    \`prize_4th\`      JSON DEFAULT NULL,
    \`prize_5th\`      JSON DEFAULT NULL,
    \`prize_near_1st\` JSON DEFAULT NULL,
    \`prize_front_3\`  JSON DEFAULT NULL,
    \`prize_last_3\`   JSON DEFAULT NULL,
    \`prize_last_2\`   VARCHAR(2) DEFAULT NULL,
    \`prize_2bot\`     VARCHAR(2) DEFAULT NULL,
    \`announced_at\`   DATETIME DEFAULT NULL,
    \`announced_by\`   INT UNSIGNED DEFAULT NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // bets
  `CREATE TABLE IF NOT EXISTS \`bets\` (
    \`id\`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`       VARCHAR(36) NOT NULL UNIQUE,
    \`member_id\`  INT UNSIGNED NOT NULL,
    \`round_id\`   INT UNSIGNED NOT NULL,
    \`bet_type\`   ENUM('3top','3tod','2top','2bot','run_top','run_bot') NOT NULL,
    \`number\`     VARCHAR(6) NOT NULL,
    \`amount\`     DECIMAL(10,2) NOT NULL,
    \`rate\`       DECIMAL(8,2) NOT NULL,
    \`payout\`     DECIMAL(15,2) NOT NULL,
    \`status\`     ENUM('waiting','win','lose','cancelled','refunded') NOT NULL DEFAULT 'waiting',
    \`win_amount\` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_member\` (\`member_id\`),
    INDEX \`idx_round\`  (\`round_id\`),
    INDEX \`idx_status\` (\`status\`),
    INDEX \`idx_number\` (\`number\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // deposits
  `CREATE TABLE IF NOT EXISTS \`deposits\` (
    \`id\`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`        VARCHAR(36) NOT NULL UNIQUE,
    \`member_id\`   INT UNSIGNED NOT NULL,
    \`amount\`      DECIMAL(15,2) NOT NULL,
    \`bank_code\`   VARCHAR(20) DEFAULT NULL,
    \`slip_image\`  VARCHAR(255) DEFAULT NULL,
    \`transfer_at\` DATETIME DEFAULT NULL,
    \`status\`      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    \`approved_by\` INT UNSIGNED DEFAULT NULL,
    \`approved_at\` DATETIME DEFAULT NULL,
    \`note\`        TEXT DEFAULT NULL,
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_member\` (\`member_id\`),
    INDEX \`idx_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // withdrawals
  `CREATE TABLE IF NOT EXISTS \`withdrawals\` (
    \`id\`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`         VARCHAR(36) NOT NULL UNIQUE,
    \`member_id\`    INT UNSIGNED NOT NULL,
    \`amount\`       DECIMAL(15,2) NOT NULL,
    \`bank_code\`    VARCHAR(20) NOT NULL,
    \`bank_account\` VARCHAR(20) NOT NULL,
    \`bank_name\`    VARCHAR(100) NOT NULL,
    \`status\`       ENUM('pending','processing','completed','rejected','failed') NOT NULL DEFAULT 'pending',
    \`processed_by\` INT UNSIGNED DEFAULT NULL,
    \`processed_at\` DATETIME DEFAULT NULL,
    \`ref_no\`       VARCHAR(50) DEFAULT NULL,
    \`note\`         TEXT DEFAULT NULL,
    \`created_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_member\` (\`member_id\`),
    INDEX \`idx_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // transactions
  `CREATE TABLE IF NOT EXISTS \`transactions\` (
    \`id\`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`           VARCHAR(36) NOT NULL UNIQUE,
    \`member_id\`      INT UNSIGNED NOT NULL,
    \`type\`           ENUM('deposit','withdraw','bet','win','refund','bonus','commission') NOT NULL,
    \`amount\`         DECIMAL(15,2) NOT NULL,
    \`balance_before\` DECIMAL(15,2) NOT NULL,
    \`balance_after\`  DECIMAL(15,2) NOT NULL,
    \`ref_id\`         INT UNSIGNED DEFAULT NULL,
    \`ref_type\`       VARCHAR(20) DEFAULT NULL,
    \`description\`    VARCHAR(255) DEFAULT NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_member\`  (\`member_id\`),
    INDEX \`idx_type\`    (\`type\`),
    INDEX \`idx_created\` (\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // promotions
  `CREATE TABLE IF NOT EXISTS \`promotions\` (
    \`id\`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`code\`        VARCHAR(30) UNIQUE DEFAULT NULL,
    \`name\`        VARCHAR(100) NOT NULL,
    \`type\`        ENUM('welcome','deposit','cashback','referral','manual') NOT NULL,
    \`value\`       DECIMAL(10,2) NOT NULL,
    \`is_percent\`  TINYINT(1) NOT NULL DEFAULT 0,
    \`min_deposit\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    \`max_bonus\`   DECIMAL(10,2) DEFAULT NULL,
    \`usage_limit\` INT UNSIGNED DEFAULT NULL,
    \`usage_count\` INT UNSIGNED NOT NULL DEFAULT 0,
    \`is_active\`   TINYINT(1) NOT NULL DEFAULT 1,
    \`start_at\`    DATETIME DEFAULT NULL,
    \`end_at\`      DATETIME DEFAULT NULL,
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // admin_logs
  `CREATE TABLE IF NOT EXISTS \`admin_logs\` (
    \`id\`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`admin_id\`    INT UNSIGNED DEFAULT NULL,
    \`action\`      VARCHAR(100) NOT NULL,
    \`target_type\` VARCHAR(50) DEFAULT NULL,
    \`target_id\`   INT UNSIGNED DEFAULT NULL,
    \`detail\`      TEXT DEFAULT NULL,
    \`ip\`          VARCHAR(45) DEFAULT NULL,
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_admin\`   (\`admin_id\`),
    INDEX \`idx_action\`  (\`action\`),
    INDEX \`idx_created\` (\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // settings
  `CREATE TABLE IF NOT EXISTS \`settings\` (
    \`key\`        VARCHAR(100) PRIMARY KEY,
    \`value\`      TEXT DEFAULT NULL,
    \`type\`       ENUM('string','number','boolean','json') NOT NULL DEFAULT 'string',
    \`group\`      VARCHAR(50) NOT NULL DEFAULT 'general',
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // notifications
  `CREATE TABLE IF NOT EXISTS \`notifications\` (
    \`id\`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`member_id\`  INT UNSIGNED DEFAULT NULL,
    \`title\`      VARCHAR(200) NOT NULL,
    \`body\`       TEXT NOT NULL,
    \`type\`       ENUM('system','win','deposit','withdraw','promo') NOT NULL DEFAULT 'system',
    \`is_read\`    TINYINT(1) NOT NULL DEFAULT 0,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_member\` (\`member_id\`),
    INDEX \`idx_read\`   (\`is_read\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // lottery API sources — configurable per lottery type, tried in priority order
  `CREATE TABLE IF NOT EXISTS \`lottery_api_sources\` (
    \`id\`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`lottery_code\`  VARCHAR(20)  NOT NULL,
    \`name\`          VARCHAR(100) NOT NULL DEFAULT '',
    \`source_url\`    TEXT         NOT NULL,
    \`method\`        ENUM('GET','POST') NOT NULL DEFAULT 'GET',
    \`api_key\`       VARCHAR(500) DEFAULT NULL COMMENT 'ส่งเป็น header: x-api-key',
    \`api_secret\`    VARCHAR(500) DEFAULT NULL,
    \`extra_headers\` TEXT         DEFAULT NULL COMMENT 'JSON object {"Header":"Value"}',
    \`body_template\` TEXT         DEFAULT NULL COMMENT 'POST body template (JSON string)',
    \`transform\`     VARCHAR(50)  NOT NULL DEFAULT 'auto' COMMENT 'auto|json_flat|longdo|sanook|huaylao|xoso|custom',
    \`path_prize1\`   VARCHAR(200) DEFAULT NULL COMMENT 'dot-path เช่น data.first หรือ result.prize1',
    \`path_last2\`    VARCHAR(200) DEFAULT NULL,
    \`path_front3\`   VARCHAR(200) DEFAULT NULL COMMENT 'array path, comma-sep keys, or single string',
    \`path_last3\`    VARCHAR(200) DEFAULT NULL,
    \`enabled\`       TINYINT(1)   NOT NULL DEFAULT 1,
    \`sort_order\`    SMALLINT     NOT NULL DEFAULT 0 COMMENT 'ลำดับการลอง 0=ก่อนสุด',
    \`last_status\`   ENUM('ok','error','untested') NOT NULL DEFAULT 'untested',
    \`last_checked\`  DATETIME     DEFAULT NULL,
    \`last_result\`   TEXT         DEFAULT NULL COMMENT 'JSON snapshot of last successful response',
    \`created_at\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_code_enabled\` (\`lottery_code\`, \`enabled\`, \`sort_order\`),
    UNIQUE KEY \`uk_code_name\` (\`lottery_code\`, \`name\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // agent_transactions — ประวัติการเงินของ Agent
  `CREATE TABLE IF NOT EXISTS \`agent_transactions\` (
    \`id\`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`           VARCHAR(36) NOT NULL UNIQUE,
    \`agent_id\`       INT UNSIGNED NOT NULL,
    \`type\`           ENUM('deposit','withdraw','bet','win','refund','commission') NOT NULL,
    \`amount\`         DECIMAL(15,2) NOT NULL,
    \`balance_before\` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`balance_after\`  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`ref_id\`         INT UNSIGNED DEFAULT NULL,
    \`description\`    VARCHAR(255) DEFAULT NULL,
    \`created_at\`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_agent\`   (\`agent_id\`),
    INDEX \`idx_type\`    (\`type\`),
    INDEX \`idx_created\` (\`created_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // agent_deposits — คำขอฝากเงินของ Agent
  `CREATE TABLE IF NOT EXISTS \`agent_deposits\` (
    \`id\`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`        VARCHAR(36) NOT NULL UNIQUE,
    \`agent_id\`    INT UNSIGNED NOT NULL,
    \`amount\`      DECIMAL(15,2) NOT NULL,
    \`bank_code\`   VARCHAR(20) DEFAULT NULL,
    \`note\`        TEXT DEFAULT NULL,
    \`status\`      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    \`approved_by\` INT UNSIGNED DEFAULT NULL,
    \`approved_at\` DATETIME DEFAULT NULL,
    \`reject_note\` VARCHAR(255) DEFAULT NULL,
    \`created_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_agent\`  (\`agent_id\`),
    INDEX \`idx_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // agent_withdrawals — คำขอถอนเงินของ Agent
  `CREATE TABLE IF NOT EXISTS \`agent_withdrawals\` (
    \`id\`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`         VARCHAR(36) NOT NULL UNIQUE,
    \`agent_id\`     INT UNSIGNED NOT NULL,
    \`amount\`       DECIMAL(15,2) NOT NULL,
    \`bank_code\`    VARCHAR(20) NOT NULL DEFAULT '',
    \`bank_account\` VARCHAR(20) NOT NULL DEFAULT '',
    \`bank_name\`    VARCHAR(100) NOT NULL DEFAULT '',
    \`note\`         TEXT DEFAULT NULL,
    \`status\`       ENUM('pending','processing','completed','rejected') NOT NULL DEFAULT 'pending',
    \`processed_by\` INT UNSIGNED DEFAULT NULL,
    \`processed_at\` DATETIME DEFAULT NULL,
    \`reject_note\`  VARCHAR(255) DEFAULT NULL,
    \`created_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_agent\`  (\`agent_id\`),
    INDEX \`idx_status\` (\`status\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // agent_bets — การแทงหวยของ Agent (จากกระเป๋าเงิน Agent)
  `CREATE TABLE IF NOT EXISTS \`agent_bets\` (
    \`id\`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    \`uuid\`       VARCHAR(36) NOT NULL UNIQUE,
    \`agent_id\`   INT UNSIGNED NOT NULL,
    \`round_id\`   INT UNSIGNED NOT NULL,
    \`bet_type\`   ENUM('3top','3tod','2top','2bot','run_top','run_bot') NOT NULL,
    \`number\`     VARCHAR(6) NOT NULL,
    \`amount\`     DECIMAL(10,2) NOT NULL,
    \`rate\`       DECIMAL(8,2) NOT NULL,
    \`payout\`     DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`status\`     ENUM('waiting','win','lose','cancelled','refunded') NOT NULL DEFAULT 'waiting',
    \`win_amount\` DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX \`idx_agent\`  (\`agent_id\`),
    INDEX \`idx_round\`  (\`round_id\`),
    INDEX \`idx_status\` (\`status\`),
    INDEX \`idx_number\` (\`number\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// ─── Seed data ───────────────────────────────────────────────────────────────

const SEEDS = [
  // Lottery types (INSERT IGNORE = skip if already exists)
  `INSERT IGNORE INTO \`lottery_types\` (\`code\`,\`name\`,\`flag\`,\`sort_order\`,\`rate_3top\`,\`rate_3tod\`,\`rate_2top\`,\`rate_2bot\`,\`rate_run_top\`,\`rate_run_bot\`,\`max_bet\`) VALUES
    ('TH_GOV','หวยรัฐบาลไทย','🇹🇭',1,750,120,95,90,3.2,4.2,5000),
    ('CN_STK','หวยหุ้นจีน','🇨🇳',2,720,115,90,85,3.0,4.0,5000),
    ('VN_HAN','ฮานอยปกติ','🇻🇳',3,720,115,90,85,3.0,4.0,3000),
    ('LA_GOV','ลาวพัฒนา','🇱🇦',4,700,110,88,83,3.0,4.0,3000),
    ('YEEKEE','หวยยี่กี','🎲',5,700,110,85,80,3.0,3.8,2000),
    ('MY_STK','หวยมาเลย์','🇲🇾',6,720,115,90,85,3.0,4.0,3000),
    ('SG_STK','หวยสิงคโปร์','🇸🇬',7,720,115,90,85,3.0,4.0,3000),
    ('TH_STK','หวยหุ้นไทย','📈',8,720,115,90,85,3.0,4.0,5000),
    ('VN_HAN_SP','ฮานอยพิเศษ','🇻🇳',9,720,115,90,85,3.0,4.0,3000),
    ('VN_HAN_VIP','ฮานอย VIP','🇻🇳',10,720,115,90,85,3.0,4.0,3000)`,

  // อัปเดตชื่อหวยที่เปลี่ยนแปลง (สำหรับ DB ที่มีอยู่แล้ว)
  `UPDATE \`lottery_types\` SET \`name\`='ลาวพัฒนา' WHERE \`code\`='LA_GOV' AND \`name\`='หวยลาว'`,
  `UPDATE \`lottery_types\` SET \`name\`='ฮานอยปกติ' WHERE \`code\`='VN_HAN' AND \`name\`='หวยฮานอย'`,

  // Settings (INSERT IGNORE = skip if already exists)
  `INSERT IGNORE INTO \`settings\` (\`key\`,\`value\`,\`type\`,\`group\`) VALUES
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
    ('site_tagline','OFFICIAL','string','general'),
    ('site_logo_url','','string','general'),
    ('line_id','@tigerlotto','string','contact'),
    ('line_url','https://line.me/R/ti/p/@tigerlotto','string','contact'),
    ('line_qr_url','','string','contact'),
    ('contact_tel','02-xxx-xxxx','string','contact'),
    ('sms_enabled','false','boolean','sms'),
    ('line_enabled','false','boolean','line'),
    ('session_expire','60','number','security'),
    ('login_max_attempt','5','number','security'),
    ('require_2fa_admin','true','boolean','security')`,

  // Promotions (INSERT IGNORE)
  `INSERT IGNORE INTO \`promotions\` (\`code\`,\`name\`,\`type\`,\`value\`,\`is_percent\`,\`is_active\`) VALUES
    ('WELCOME50','โบนัสต้อนรับสมาชิกใหม่','welcome',50,0,1),
    ('CASHBACK5','คืนยอด 5% ทุกงวด','cashback',5,1,1),
    ('REF3','ค่าแนะนำเพื่อน 3%','referral',3,1,1)`,

  // Default lottery API sources (INSERT IGNORE — unique on lottery_code+name)
  `INSERT IGNORE INTO \`lottery_api_sources\`
     (\`lottery_code\`,\`name\`,\`source_url\`,\`transform\`,\`enabled\`,\`sort_order\`) VALUES
    ('TH_GOV','GLO Official (HTML)','https://www.glo.or.th/th/lotto/result','html_th_gov',1,0),
    ('TH_GOV','Sanook Lottery (HTML)','https://www.sanook.com/lottery/','html_th_gov',1,1),
    ('TH_GOV','Manager Lottery (HTML)','https://www.manager.co.th/Lottery/','html_th_gov',1,2),
    ('LA_GOV','Sanook Lao (4-digit)','https://www.sanook.com/news/laolotto/','html_sanook_lao',1,0),
    ('LA_GOV','Tookhuay Lao (HTML)','https://www.tookhuay.com/lao-lottery-result/','html_la_gov',1,1),
    ('LA_GOV','Ruaythai Lao (HTML)','https://www.ruaythai.com/laos/','html_la_gov',1,2),
    ('LA_GOV','HuayLao.net (HTML)','https://huaylao.net/','html_la_gov',1,3),
    ('LA_GOV','LD1 Official (HTML)','https://www.ld1.la/','html_la_gov',1,4),
    ('LA_GOV','LottovipLao (HTML)','https://www.lottovip.com/lao-lottery-result/','html_la_gov',1,5),
    ('VN_HAN','ketqua.tv (HTML)','https://ketqua.tv/xo-so-mien-bac.html','html_vn_han',1,0),
    ('VN_HAN','xosomiennam.net (HTML)','https://xosomiennam.net/ket-qua-xo-so-mien-bac','html_vn_han',1,1),
    ('VN_HAN','xskt RSS (XML)','https://xskt.com.vn/rss-feed/mien-bac-xsmb.rss','rss_vn',1,2),
    ('VN_HAN','TNews ฮานอยปกติ (HTML)','https://www.tnews.co.th/lotto-horo-belief/feed','html_tnews',1,3),
    ('VN_HAN_SP','TNews ฮานอยพิเศษ (HTML)','https://www.tnews.co.th/lotto-horo-belief/feed','html_tnews',1,0),
    ('VN_HAN_VIP','TNews ฮานอย VIP (HTML)','https://www.tnews.co.th/lotto-horo-belief/feed','html_tnews',1,0)`,

  // ─── Fix existing TNews DB sources: เปลี่ยน html_vn_han → html_tnews + ชี้ไป RSS ──
  `UPDATE \`lottery_api_sources\`
   SET \`transform\`='html_tnews',
       \`source_url\`='https://www.tnews.co.th/lotto-horo-belief/feed',
       \`sort_order\`=CASE WHEN \`lottery_code\`='VN_HAN' THEN 3 ELSE 0 END
   WHERE \`name\` LIKE '%TNews%' AND \`transform\`='html_vn_han'`,

  // ─── Force correct transform + URL for ALL TNews sources (belt-and-suspenders) ──
  `UPDATE \`lottery_api_sources\`
   SET \`transform\`='html_tnews',
       \`source_url\`='https://www.tnews.co.th/lotto-horo-belief/feed'
   WHERE \`name\` LIKE '%TNews%' AND \`lottery_code\` IN ('VN_HAN','VN_HAN_SP','VN_HAN_VIP')`,

  // ─── ลบ VN_HAN_SP/VIP sources เวียดนาม (XSMT/XSMN/xosomiennam) ที่ผิด type ──
  `DELETE FROM \`lottery_api_sources\`
   WHERE \`lottery_code\` IN ('VN_HAN_SP','VN_HAN_VIP')
   AND \`name\` NOT LIKE '%TNews%'`,

  // ─── Force correct sort_order for LA_GOV (INSERT IGNORE keeps old values) ───
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=0, \`enabled\`=1
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='Sanook Lao (4-digit)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=10, \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='HuayLao.net (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=11, \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='Tookhuay Lao (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=12, \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='Ruaythai Lao (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=13, \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='LD1 Official (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=14, \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`name\`='LottovipLao (HTML)'`,
  // Disable old lotto.com.la source (returns 500)
  `UPDATE \`lottery_api_sources\` SET \`enabled\`=0
   WHERE \`lottery_code\`='LA_GOV' AND \`source_url\` LIKE '%lotto.com.la%'`,

  // ─── Force correct sort_order for VN_HAN (TNews first — ตรงกับผล TNews จริง) ───
  // TNews source ต้องเป็น sort_order=0 (ก่อนสุด) — xskt/ketqua/xosomiennam ส่งผลเวียดนาม 5 หลักซึ่งผิด
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=0, \`enabled\`=1
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='TNews ฮานอยปกติ (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=10, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='xskt RSS (XML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=11, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='ketqua.tv (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=12, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='xosomiennam.net (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=13, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='xoso.com.vn (HTML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=14, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN' AND \`name\`='xskt.com.vn (JSON)'`,

  // ─── Force correct sort_order + URL for VN_HAN_SP (XSMT = ภาคกลาง) ───
  // Disable old wrong sources that pointed to XSMB (ภาคเหนือ)
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=10, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN_SP' AND \`source_url\` LIKE '%mien-bac%'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=11, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN_SP' AND \`source_url\` LIKE '%ket-qua-xo-so-mien-bac%'`,
  // New correct sources for SP (XSMT)
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=0, \`enabled\`=1,
   \`source_url\`='https://xskt.com.vn/rss-feed/mien-trung-xsmt.rss'
   WHERE \`lottery_code\`='VN_HAN_SP' AND \`name\`='xskt RSS SP XSMT (XML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=1, \`enabled\`=1,
   \`source_url\`='https://xosomiennam.net/ket-qua-xo-so-mien-trung'
   WHERE \`lottery_code\`='VN_HAN_SP' AND \`name\`='xosomiennam SP (HTML)'`,

  // ─── Force correct sort_order + URL for VN_HAN_VIP (XSMN = ภาคใต้) ───
  // Disable old wrong sources that pointed to XSMB (ภาคเหนือ)
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=10, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN_VIP' AND \`source_url\` LIKE '%mien-bac%'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=11, \`enabled\`=0
   WHERE \`lottery_code\`='VN_HAN_VIP' AND \`source_url\` LIKE '%ket-qua-xo-so-mien-bac%'`,
  // New correct sources for VIP (XSMN)
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=0, \`enabled\`=1,
   \`source_url\`='https://xskt.com.vn/rss-feed/mien-nam-xsmn.rss'
   WHERE \`lottery_code\`='VN_HAN_VIP' AND \`name\`='xskt RSS VIP XSMN (XML)'`,
  `UPDATE \`lottery_api_sources\` SET \`sort_order\`=1, \`enabled\`=1,
   \`source_url\`='https://xosomiennam.net/ket-qua-xo-so-mien-nam'
   WHERE \`lottery_code\`='VN_HAN_VIP' AND \`name\`='xosomiennam VIP (HTML)'`,

  // ─── Cleanup duplicate sources (keep lowest id per lottery_code+name) ───
  `DELETE s1 FROM \`lottery_api_sources\` s1
   INNER JOIN \`lottery_api_sources\` s2
   WHERE s1.lottery_code = s2.lottery_code
     AND s1.name = s2.name
     AND s1.id > s2.id`,
];

// ─── Main migration function ─────────────────────────────────────────────────

async function migrate() {
  console.log('🔄 Running TigerLotto DB migration (JS-native)...');

  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const parsed = dbUrl ? parseDbUrl(dbUrl) : null;

  const connConfig = {
    host    : parsed?.host     || process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
    port    : parsed?.port     || process.env.DB_PORT     || process.env.MYSQLPORT     || 3306,
    database: parsed?.database || process.env.DB_NAME     || process.env.MYSQLDATABASE || 'railway',
    user    : parsed?.user     || process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
    password: parsed?.password || process.env.DB_PASS     || process.env.MYSQLPASSWORD || '',
    charset : 'utf8mb4',
    ssl     : process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };

  console.log(`   Host: ${connConfig.host}:${connConfig.port} / DB: ${connConfig.database}`);

  const conn = await mysql.createConnection(connConfig);

  let ok = 0, fail = 0;

  const run = async (label, sql) => {
    try {
      await conn.query(sql);
      ok++;
      console.log(`   ✅ ${label}`);
    } catch (e) {
      fail++;
      console.warn(`   ⚠️  ${label} — [${e.code}] ${e.message.substring(0, 120)}`);
    }
  };

  // 0. Drop FKs from OLD schema tables that reference our new tables
  //    MySQL 9.x enforces column-type compatibility even with FK_CHECKS=0 at CREATE time
  console.log('\n🔗 Dropping old-schema FKs that reference our tables...');
  try {
    const OUR_TABLES = [
      'agents','members','admins','lottery_types','lottery_rounds',
      'bets','deposits','withdrawals','transactions','notifications',
      'admin_logs','otps','settings','promotions','lottery_results'
    ];
    const placeholders = OUR_TABLES.map(() => '?').join(',');
    const [fkRows] = await conn.query(
      `SELECT DISTINCT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.CONSTRAINT_SCHEMA
         AND tc.TABLE_NAME = kcu.TABLE_NAME
       WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
         AND kcu.REFERENCED_TABLE_NAME IN (${placeholders})
         AND kcu.TABLE_NAME NOT IN (${placeholders})
         AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      [...OUR_TABLES, ...OUR_TABLES]
    );
    for (const row of fkRows) {
      await run(
        `DROP FK ${row.CONSTRAINT_NAME} on ${row.TABLE_NAME}`,
        `ALTER TABLE \`${row.TABLE_NAME}\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``
      );
    }
  } catch (e) {
    console.warn(`   ⚠️  FK scan error: ${e.message.substring(0, 120)}`);
  }

  // ─── SAFE MODE (default): CREATE IF NOT EXISTS + seeds only — NO drops ───
  // ─── RESET MODE: drop first, then create ──────────────────────────────────
  const forceReset = process.env.DB_FORCE_RESET === 'true';

  if (forceReset) {
    console.log('\n⚠️  FORCE RESET: Dropping all tables...');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const sql of DROPS) {
      const table = sql.match(/`(\w+)`$/)?.[1] || '?';
      await run(`DROP ${table}`, sql);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } else {
    console.log('\n🔒 Safe mode — skipping DROP (use DB_FORCE_RESET=true to reset)');
  }

  // 1. Create all tables (IF NOT EXISTS — safe to run every startup)
  console.log('\n🔨 Creating tables...');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const sql of CREATES) {
    const table = sql.match(/CREATE TABLE IF NOT EXISTS `(\w+)`/)?.[1] || '?';
    await run(`CREATE ${table}`, sql);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // 2. Safe ALTER TABLE — add new columns to existing tables
  console.log('\n🔧 Applying schema patches...');
  const ALTERS = [
    // Add open_at column to lottery_rounds (for upcoming→open auto-transition)
    `ALTER TABLE \`lottery_rounds\` ADD COLUMN \`open_at\` DATETIME DEFAULT NULL AFTER \`round_code\``,
    // round_code unique index (safe re-add attempt)
    `ALTER TABLE \`lottery_rounds\` ADD UNIQUE KEY \`uk_round_code\` (\`round_code\`)`,
    // lottery_api_sources: unique key to prevent duplicate seeds
    `ALTER TABLE \`lottery_api_sources\` ADD UNIQUE KEY \`uk_code_name\` (\`lottery_code\`, \`name\`)`,
    // lottery_results: เพิ่ม prize_2bot สำหรับ VN_HAN/VN_HAN_SP/VN_HAN_VIP (2 ตัวล่าง = last 2 ของ Giải Nhất)
    `ALTER TABLE \`lottery_results\` ADD COLUMN \`prize_2bot\` VARCHAR(2) DEFAULT NULL AFTER \`prize_last_2\``,
    // admins: เพิ่ม balance สำหรับระบบเพิ่ม/ลด เครดิต Admin
    `ALTER TABLE \`admins\` ADD COLUMN \`balance\` DECIMAL(15,2) NOT NULL DEFAULT 0.00 AFTER \`role\``,
    // settings: ขยาย value เป็น MEDIUMTEXT รองรับ base64 logo/QR image
    `ALTER TABLE \`settings\` MODIFY COLUMN \`value\` MEDIUMTEXT DEFAULT NULL`,
    // agents: เพิ่ม aff_code สำหรับ Affiliate link
    `ALTER TABLE \`agents\` ADD COLUMN \`aff_code\` VARCHAR(20) DEFAULT NULL UNIQUE AFTER \`uuid\``,
  ];
  for (const sql of ALTERS) {
    const label = sql.replace(/\s+/g, ' ').substring(0, 60);
    try {
      await conn.query(sql);
      ok++;
      console.log(`   ✅ ${label}`);
    } catch (e) {
      // 1060 = Duplicate column, 1061 = Duplicate key — both are OK (already applied)
      if (e.errno === 1060 || e.errno === 1061) {
        console.log(`   ✔  ${label} (already exists)`);
      } else {
        fail++;
        console.warn(`   ⚠️  ${label} — [${e.code}] ${e.message.substring(0, 80)}`);
      }
    }
  }

  // 3. Seed data (INSERT IGNORE — won't overwrite existing rows)
  console.log('\n🌱 Seeding data...');
  for (const sql of SEEDS) {
    const table = sql.match(/INTO `(\w+)`/)?.[1] || '?';
    await run(`SEED ${table}`, sql);
  }

  // 3b. Auto-seed ScraperAPI key from environment variable (if set)
  //     Uses INSERT … ON DUPLICATE KEY UPDATE with IF() to avoid overwriting
  //     an existing non-empty key that was saved through the admin UI.
  if (process.env.SCRAPERAPI_KEY) {
    const safeKey = process.env.SCRAPERAPI_KEY.replace(/'/g, "\\'");
    await run(
      'SEED settings[scraperapi_key from env]',
      `INSERT INTO \`settings\` (\`key\`, value, type, \`group\`)
       VALUES ('scraperapi_key', '${safeKey}', 'string', 'api')
       ON DUPLICATE KEY UPDATE
         value = IF(value IS NULL OR value = '' OR value = 'your_scraperapi_key_here',
                    VALUES(value), value)`
    );
    console.log('   🔑 ScraperAPI key seeded from SCRAPERAPI_KEY env var');
  }

  // 4. List tables for verification
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`
    );
    console.log(`\n📋 Tables in DB: ${rows.map(r => r.TABLE_NAME).join(', ')}`);
  } catch (e) { /* non-fatal */ }

  console.log(`\n✅ Migration complete! ok=${ok} fail=${fail}`);
  await conn.end();
}

// Export
module.exports = { runMigration: migrate };

// รัน standalone: node database/migrate.js
if (require.main === module) {
  migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}
