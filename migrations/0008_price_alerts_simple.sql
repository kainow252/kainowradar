-- ============================================================
-- Migration 0008: Tabela price_alerts (alertas sem OAuth)
-- Permite alertas por email sem necessidade de conta
-- ============================================================

-- Tabela simples de alertas por email (sem OAuth)
CREATE TABLE IF NOT EXISTS price_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  target_price REAL NOT NULL,
  is_active INTEGER DEFAULT 1,
  notified_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_price_alerts_email      ON price_alerts(email, is_active);
CREATE INDEX IF NOT EXISTS idx_price_alerts_product    ON price_alerts(product_id, is_active);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active     ON price_alerts(is_active, target_price);
CREATE INDEX IF NOT EXISTS idx_price_alerts_notify     ON price_alerts(is_active, notified_at);

-- Unique: um alerta por (produto + email)
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_alerts_unique ON price_alerts(product_id, email);
