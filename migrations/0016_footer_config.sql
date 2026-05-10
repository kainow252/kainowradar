-- Migration 0016: Configuração dinâmica do rodapé do site
-- Permite editar textos, links e visibilidade via admin

CREATE TABLE IF NOT EXISTS footer_config (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section     TEXT NOT NULL,  -- 'brand' | 'categories' | 'stores' | 'info' | 'bottom'
  key         TEXT NOT NULL,
  value       TEXT,
  is_visible  INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(section, key)
);

-- Dados padrão: seção brand
INSERT OR IGNORE INTO footer_config (section, key, value, is_visible, sort_order) VALUES
  ('brand', 'site_name',   'KainowRadar', 1, 0),
  ('brand', 'tagline',     'Seu radar inteligente de ofertas. Encontre o menor preço nas maiores lojas do Brasil.', 1, 1),
  ('brand', 'show_logo',   '1', 1, 2);

-- Dados padrão: seção stores (lojas parceiras — visibilidade individual)
INSERT OR IGNORE INTO footer_config (section, key, value, is_visible, sort_order) VALUES
  ('stores', 'Amazon',         '/categoria/smartphones', 1, 0),
  ('stores', 'Magazine Luiza', '/categoria/notebooks',   1, 1),
  ('stores', 'Mercado Livre',  '/categoria/tv',          1, 2),
  ('stores', 'Americanas',     '/categoria/games',       1, 3);

-- Dados padrão: seção info (links de informações)
INSERT OR IGNORE INTO footer_config (section, key, value, is_visible, sort_order) VALUES
  ('info', 'Sobre',                  '/sobre',               1, 0),
  ('info', 'Política de Privacidade','/privacidade',          1, 1),
  ('info', 'Como funciona',          '/como-funciona',        1, 2),
  ('info', 'Contato',                '/contato',              0, 3),
  ('info', 'Anuncie aqui',           '/anuncie',              0, 4);

-- Dados padrão: seção bottom (textos do rodapé inferior)
INSERT OR IGNORE INTO footer_config (section, key, value, is_visible, sort_order) VALUES
  ('bottom', 'disclaimer', 'Este site usa links de afiliados. Podemos receber comissão nas compras realizadas através dos nossos links, sem custo adicional para você.', 1, 0),
  ('bottom', 'copyright',  '© 2025 KainowRadar. Todos os direitos reservados.', 1, 1);
