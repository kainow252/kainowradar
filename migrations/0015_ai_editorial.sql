-- Migration 0015: Tabela de destaques editoriais gerados pela IA interna
-- O motor analisa produtos, ofertas e categorias do D1 e gera conteúdo automaticamente

CREATE TABLE IF NOT EXISTS ai_editorial (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slot        TEXT NOT NULL UNIQUE, -- 'banner_main', 'banner_sec1', 'banner_sec2', 'hot_label', 'insight_1..3'
  type        TEXT NOT NULL DEFAULT 'banner', -- 'banner' | 'insight' | 'label'
  title       TEXT NOT NULL,
  subtitle    TEXT,
  label       TEXT,           -- ex: "🔥 Destaque do dia"
  emoji       TEXT,           -- emoji decorativo ex: 📱
  search_term TEXT,           -- termo para quickSearch() no frontend
  category_slug TEXT,         -- slug para /categoria/:slug
  product_id  INTEGER,        -- produto específico (opcional)
  stat_value  TEXT,           -- ex: "até R$ 800", "30% OFF", "12 ofertas"
  color_from  TEXT DEFAULT '#2563EB', -- gradiente início
  color_to    TEXT DEFAULT '#7C3AED', -- gradiente fim
  style       TEXT DEFAULT 'blue',    -- 'blue'|'purple'|'green'|'orange'|'red'
  priority    INTEGER DEFAULT 0,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  valid_until  DATETIME,
  meta_json   TEXT  -- JSON com dados extras (top_product, stores_count, etc.)
);

-- Insights textuais (rodapé, ticker, etc.)
CREATE TABLE IF NOT EXISTS ai_insights (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT,   -- categoria analisada
  insight_text TEXT NOT NULL,
  insight_type TEXT DEFAULT 'tip', -- 'tip'|'alert'|'trend'
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
