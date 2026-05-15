-- Migration 0030: cria categoria catch-all 'outros'
-- Produtos sem categoria detectada serão atribuídos a esta categoria
-- em vez de ficarem com category = NULL

INSERT OR IGNORE INTO categories (name, slug, icon, is_active, product_count)
VALUES (
  'Outros',
  'outros',
  '📦',
  1,
  0
);

-- Recategoriza todos os produtos que estão com category = NULL ou category = ''
-- para 'outros', para que nenhum produto fique orphan no painel
UPDATE products
SET category = 'outros'
WHERE (category IS NULL OR category = '' OR TRIM(category) = '');

-- Atualiza o product_count da categoria 'outros' com a contagem real
UPDATE categories
SET product_count = (
  SELECT COUNT(*) FROM products WHERE category = 'outros'
)
WHERE slug = 'outros';
