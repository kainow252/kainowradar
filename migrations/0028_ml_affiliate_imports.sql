-- ============================================================
-- Migration 0028: Log de links de afiliado ML importados manualmente
-- Permite importar links meli.la/... ou links longos do ML
-- e rastrear o histórico de importações
-- ============================================================

CREATE TABLE IF NOT EXISTS ml_affiliate_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  original_url    TEXT NOT NULL,                   -- Link original colado (meli.la/xxx ou link longo)
  resolved_url    TEXT,                            -- URL final após resolver redirect
  ml_item_id      TEXT,                            -- MLB123456789 extraído
  affiliate_url   TEXT,                            -- Link final com matt_word rastreado
  product_id      INTEGER REFERENCES products(id), -- Produto vinculado (se encontrado)
  product_name    TEXT,                            -- Nome do produto (cache)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | matched | error
  error_msg       TEXT,                            -- Mensagem de erro se falhar
  imported_by     TEXT DEFAULT 'admin',
  imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ml_imports_ml_item_id  ON ml_affiliate_imports(ml_item_id);
CREATE INDEX IF NOT EXISTS idx_ml_imports_status      ON ml_affiliate_imports(status);
CREATE INDEX IF NOT EXISTS idx_ml_imports_imported_at ON ml_affiliate_imports(imported_at);
