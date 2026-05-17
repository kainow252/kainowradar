-- Move categoria "Outros" para o final do subnav (sort_order 999)
UPDATE categories SET sort_order = 999 WHERE name = 'Outros';
