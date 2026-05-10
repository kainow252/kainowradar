-- ============================================================
-- MIGRATION 0019: Admin Users + Permissions
-- ============================================================

-- Tabela de administradores do sistema
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,         -- salt:sha256
  role TEXT DEFAULT 'moderator',       -- 'super_admin' | 'admin' | 'moderator' | 'editor'
  status TEXT DEFAULT 'active',        -- 'active' | 'inactive'
  avatar_url TEXT,
  last_login_at DATETIME,
  login_count INTEGER DEFAULT 0,
  created_by TEXT,                     -- id do admin que criou
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Permissões individuais por admin
CREATE TABLE IF NOT EXISTS admin_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  permission TEXT NOT NULL,            -- chave da permissão ex: 'products.edit'
  granted INTEGER DEFAULT 1,          -- 1=permitido 0=negado
  UNIQUE(admin_id, permission),
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE CASCADE
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_admin_users_email  ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_status ON admin_users(status);
CREATE INDEX IF NOT EXISTS idx_admin_perms_admin  ON admin_permissions(admin_id);
