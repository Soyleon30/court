CREATE DATABASE IF NOT EXISTS basketball CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS basketball.workspaces (
  workspace_key VARCHAR(100) NOT NULL PRIMARY KEY,
  payload JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional least-privilege account for the application server:
-- CREATE USER 'basketball'@'10.%' IDENTIFIED BY 'replace-with-a-strong-password';
-- GRANT SELECT, INSERT, UPDATE ON basketball.workspaces TO 'basketball'@'10.%';
-- FLUSH PRIVILEGES;
