-- ============================================================
-- Migration 0013: Categorias completas baseadas em análise dos
-- principais e-commerces BR: Amazon, Buscapé, Zoom, KaBuM,
-- Mercado Livre, Magalu, Shopee, Americanas, Casas Bahia
-- ============================================================

-- Atualiza as 8 existentes (sort_order e ícones refinados)
UPDATE categories SET name = 'Smartphones',        icon = '📱', sort_order = 1  WHERE slug = 'smartphones';
UPDATE categories SET name = 'Notebooks',          icon = '💻', sort_order = 2  WHERE slug = 'notebooks';
UPDATE categories SET name = 'TVs & Smart TVs',    icon = '📺', sort_order = 3  WHERE slug = 'tv';
UPDATE categories SET name = 'Games & Consoles',   icon = '🎮', sort_order = 4  WHERE slug = 'games';
UPDATE categories SET name = 'Eletrodomésticos',   icon = '🏠', sort_order = 5  WHERE slug = 'eletrodomesticos';
UPDATE categories SET name = 'Áudio & Fones',      icon = '🎧', sort_order = 6  WHERE slug = 'audio';
UPDATE categories SET name = 'Câmeras & Drones',   icon = '📷', sort_order = 7  WHERE slug = 'cameras';
UPDATE categories SET name = 'Moda & Calçados',    icon = '👗', sort_order = 8  WHERE slug = 'moda';

-- Novas categorias — Tecnologia & Informática
INSERT OR IGNORE INTO categories (name, slug, icon, sort_order, is_active) VALUES
  ('Tablets & iPads',         'tablets',           '📟', 9,  1),
  ('Computadores & Desktops', 'computadores',      '🖥️', 10, 1),
  ('Monitores',               'monitores',         '🖥️', 11, 1),
  ('Impressoras & Scanners',  'impressoras',       '🖨️', 12, 1),
  ('Componentes PC',          'componentes-pc',    '⚙️', 13, 1),
  ('Armazenamento & SSDs',    'armazenamento',     '💾', 14, 1),
  ('Redes & Wi-Fi',           'redes',             '📡', 15, 1),
  ('Smartwatches & Wearables','smartwatches',      '⌚', 16, 1),
  ('Fones de Ouvido',         'fones',             '🎵', 17, 1),
  ('Caixas de Som',           'caixas-de-som',     '🔊', 18, 1),
  ('Casa Inteligente',        'casa-inteligente',  '🏡', 19, 1),
  ('Acessórios Tech',         'acessorios-tech',   '🔌', 20, 1);

-- Novas categorias — Eletro & Casa
INSERT OR IGNORE INTO categories (name, slug, icon, sort_order, is_active) VALUES
  ('Ar-Condicionado',         'ar-condicionado',   '❄️', 21, 1),
  ('Geladeiras & Freezers',   'geladeiras',        '🧊', 22, 1),
  ('Lavadoras & Secadoras',   'lavadoras',         '🫧', 23, 1),
  ('Fogões & Fornos',         'fogoes',            '🍳', 24, 1),
  ('Aspiradores & Limpeza',   'limpeza',           '🧹', 25, 1),
  ('Móveis & Decoração',      'moveis',            '🛋️', 26, 1),
  ('Ferramentas & Construção','ferramentas',       '🔨', 27, 1);

-- Novas categorias — Lifestyle & Outros
INSERT OR IGNORE INTO categories (name, slug, icon, sort_order, is_active) VALUES
  ('Esportes & Fitness',      'esportes',          '🏋️', 28, 1),
  ('Beleza & Cuidados',       'beleza',            '💄', 29, 1),
  ('Brinquedos & Kids',       'brinquedos',        '🧸', 30, 1),
  ('Automotivo',              'automotivo',        '🚗', 31, 1),
  ('Livros & Papelaria',      'livros',            '📚', 32, 1),
  ('Pet Shop',                'pet-shop',          '🐾', 33, 1),
  ('Saúde & Bem-estar',       'saude',             '💊', 34, 1),
  ('Alimentos & Bebidas',     'alimentos',         '🛒', 35, 1),
  ('Instrumentos Musicais',   'instrumentos',      '🎸', 36, 1);
