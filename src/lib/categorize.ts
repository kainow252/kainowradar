// ============================================================
// LIB: detectCategory
// Detecta categoria de um produto pelo nome e/ou URL
// Retorna um slug de categoria compatível com a tabela `categories`
// ============================================================

type CategoryRule = {
  slug: string
  keywords: string[]
}

// Ordem importa: regras mais específicas primeiro
const CATEGORY_RULES: CategoryRule[] = [
  // ── Smartphones ────────────────────────────────────────────
  {
    slug: 'smartphones',
    keywords: [
      'smartphone', 'celular', 'iphone', 'galaxy s', 'galaxy a', 'galaxy m',
      'moto g', 'moto e', 'motorola edge', 'redmi', 'xiaomi', 'poco x', 'poco m',
      'realme', 'oppo', 'vivo x', 'pixel ', 'oneplus', 'asus zenfone',
      'iphone 16', 'iphone 15', 'iphone 14', 'iphone 13', 'iphone 12',
      'android phone', 'phone 5g', 'telefone celular', 'celular 5g',
    ],
  },

  // ── Notebooks ──────────────────────────────────────────────
  {
    slug: 'notebooks',
    keywords: [
      'notebook', 'laptop', 'macbook', 'ultrabook', 'chromebook',
      'thinkpad', 'ideapad', 'legion ', 'yoga book', 'dell xps', 'dell inspiron',
      'hp pavilion', 'hp envy', 'hp victus', 'acer aspire', 'acer nitro', 'acer swift',
      'asus vivobook', 'asus zenbook', 'asus rog', 'asus tuf',
      'surface laptop', 'surface book', 'surface pro',
      'note i5', 'note i7', 'note i9', 'note ryzen',
    ],
  },

  // ── TVs & Smart TVs ────────────────────────────────────────
  {
    slug: 'tv',
    keywords: [
      'smart tv', 'smart-tv', 'televisao', 'televisao', 'televisor', 'tv led',
      'tv oled', 'tv qled', 'tv uhd', 'tv 4k', 'tv 8k', 'tv 32', 'tv 40',
      'tv 43', 'tv 50', 'tv 55', 'tv 65', 'tv 75', 'tv 85', 'tv samsung',
      'tv lg', 'tv sony', 'tv philips', 'tv tcl', 'tv hisense', 'tv xiaomi',
      'bravia', 'qled tv', 'neo qled', 'oled tv', 'crystal uhd', 'nanocell',
      '4k tv', '8k tv', 'android tv', 'google tv', 'webos', 'tizen tv',
      '"polegadas"', '"polegada"',
    ],
  },

  // ── Tablets & iPads ────────────────────────────────────────
  {
    slug: 'tablets',
    keywords: [
      'tablet', 'ipad', 'ipad air', 'ipad pro', 'ipad mini',
      'galaxy tab', 'tab s', 'tab a', 'lenovo tab', 'fire hd',
      'fire tablet', 'kindle fire', 'mediapad', 'realpad',
    ],
  },

  // ── Games & Consoles ───────────────────────────────────────
  {
    slug: 'games',
    keywords: [
      'playstation', 'ps5', 'ps4', 'xbox series', 'xbox one', 'nintendo switch',
      'switch oled', 'switch lite', 'steam deck', 'controle gamer', 'joystick',
      'jogo ps5', 'jogo ps4', 'jogo xbox', 'jogo nintendo', 'jogo pc',
      'game ps5', 'game xbox', 'headset gamer', 'cadeira gamer', 'cadeira gaming',
      'mouse gamer', 'teclado gamer', 'monitor gamer', 'placa de video', 'gpu rtx',
      'gpu rx', 'rtx 3060', 'rtx 3070', 'rtx 3080', 'rtx 4060', 'rtx 4070', 'rtx 4080',
      'rx 6600', 'rx 6700', 'rx 7600', 'rx 7700', 'rx 7800',
      'geforce', 'radeon rx', 'gaming chair',
    ],
  },

  // ── Áudio & Fones ──────────────────────────────────────────
  {
    slug: 'audio',
    keywords: [
      'fone de ouvido', 'headphone', 'headset', 'earphone', 'earbuds',
      'airpods', 'galaxy buds', 'jabra', 'beats headphones', 'jbl headphone',
      'bose headphone', 'sony headphone', 'sennheiser', 'skullcandy',
      'caixa de som', 'caixa bluetooth', 'speaker bluetooth', 'alto-falante',
      'soundbar', 'subwoofer', 'home theater', 'sistema de som', 'amplificador',
      'receiver audio', 'microfone', 'microfone condensador', 'interface de audio',
      'toca-discos', 'vitrola', 'aparelho de som',
    ],
  },

  // ── Câmeras & Drones ───────────────────────────────────────
  {
    slug: 'cameras',
    keywords: [
      'camera digital', 'camera fotografica', 'camera mirrorless', 'camera reflex',
      'dslr', 'mirrorless', 'gopro', 'action camera', 'camera de acao',
      'drone', 'dji', 'dji mini', 'dji air', 'phantom', 'mavic',
      'canon eos', 'nikon d', 'nikon z', 'sony alpha', 'fujifilm x',
      'lente camera', 'objetiva', 'flash fotografico', 'tripé camera',
      'camera instantanea', 'instax',
    ],
  },

  // ── Eletrodomésticos ───────────────────────────────────────
  {
    slug: 'eletrodomesticos',
    keywords: [
      'geladeira', 'refrigerador', 'freezer', 'lavadora', 'maquina de lavar',
      'secadora', 'lava-loucas', 'lava-roupas', 'fogao', 'cooktop',
      'forno eletrico', 'microondas', 'ar condicionado', 'ar-condicionado',
      'split', 'ventilador', 'purificador de agua', 'filtro de agua',
      'maquina de cafe', 'cafeteira', 'batedeira', 'liquidificador',
      'fritadeira', 'airfryer', 'air fryer', 'panela eletrica', 'panela de pressao',
      'sanduicheira', 'torradeira', 'espremedor', 'multiprocessador',
      'aspirador de po', 'aspirador robo', 'ferro de passar', 'depilador',
      'barbeador eletrico', 'escova secadora', 'chapinha', 'prancha de cabelo',
    ],
  },

  // ── Computadores & Desktops ────────────────────────────────
  {
    slug: 'computadores',
    keywords: [
      'desktop', 'computador', 'pc gamer', 'pc gaming', 'all in one',
      'mini pc', 'nuc intel', 'workstation', 'imac',
      'processador intel', 'processador amd', 'core i3', 'core i5', 'core i7', 'core i9',
      'ryzen 3', 'ryzen 5', 'ryzen 7', 'ryzen 9', 'placa mae', 'motherboard',
      'memoria ram', 'pente de ram', 'ram ddr4', 'ram ddr5', 'fonte de alimentacao',
      'gabinete pc', 'case pc', 'cooler processador', 'water cooler',
    ],
  },

  // ── Monitores ──────────────────────────────────────────────
  {
    slug: 'monitores',
    keywords: [
      'monitor ', 'monitor 4k', 'monitor gamer', 'monitor led', 'monitor ips',
      'monitor curvo', 'monitor ultrawide', 'dell monitor', 'lg monitor',
      'samsung monitor', 'aoc monitor', 'asus monitor', 'monitor 24',
      'monitor 27', 'monitor 32', '144hz', '165hz', '240hz', 'freesync', 'gsync',
    ],
  },

  // ── Impressoras & Scanners ─────────────────────────────────
  {
    slug: 'impressoras',
    keywords: [
      'impressora', 'multifuncional', 'scanner', 'plotter', 'cartucho de tinta',
      'toner', 'ribbon', 'epson l', 'epson ecotank', 'hp deskjet', 'hp laserjet',
      'canon pixma', 'brother mfc', 'brother dcp',
    ],
  },

  // ── Componentes PC ────────────────────────────────────────
  {
    slug: 'componentes',
    keywords: [
      'ssd m.2', 'ssd nvme', 'hd ssd', 'ssd 250', 'ssd 500', 'ssd 1tb', 'ssd 2tb',
      'placa de video', 'placa-de-video', 'placa mae', 'placa-mae',
      'processador ', 'cooler cpu', 'pasta termica', 'cabo sata', 'fonte 500w',
      'fonte 600w', 'fonte 700w', 'fonte 750w', 'fonte 800w',
      'gabinete ', 'case atx', 'case mid-tower', 'dissipador',
    ],
  },

  // ── Armazenamento & SSDs ───────────────────────────────────
  {
    slug: 'armazenamento',
    keywords: [
      'hd externo', 'hd interno', 'hard disk', 'hard drive',
      'pendrive', 'pen drive', 'flash drive', 'memoria flash',
      'cartao de memoria', 'cartao sd', 'microsd', 'sdxc', 'sdhc',
      'ssd externo', 'ssd portatil', 'nvme externo',
      'nas storage', 'nas drive', 'wd red', 'wd blue', 'wd purple',
      'seagate barracuda', 'seagate ironwolf',
    ],
  },

  // ── Redes & Wi-Fi ─────────────────────────────────────────
  {
    slug: 'redes',
    keywords: [
      'roteador', 'router', 'modem', 'access point', 'ponto de acesso',
      'switch de rede', 'cabo de rede', 'cabo ethernet', 'cabo rj45',
      'placa de rede', 'adaptador wifi', 'repetidor wifi', 'extensor wifi',
      'mesh wifi', 'sistema mesh', 'tp-link', 'intelbras roteador', 'asus roteador',
      'netgear', 'ubiquiti', 'mikrotik',
    ],
  },

  // ── Moda & Calçados ────────────────────────────────────────
  {
    slug: 'moda',
    keywords: [
      'tenis ', 'sapato', 'sandalia', 'bota ', 'mocassim', 'chinelo',
      'camiseta', 'camisa ', 'calca jeans', 'vestido', 'saia ', 'blusa ',
      'casaco', 'jaqueta', 'moletom', 'shorts ', 'bermuda ',
      'cueca', 'calcinha', 'sutiã', 'meia ', 'cinto ', 'bolsa ',
      'mochila ', 'carteira couro', 'oculos ', 'relogio ',
      'nike', 'adidas', 'puma', 'vans', 'converse', 'new balance',
      'havaianas', 'melissa', 'zara', 'lacoste',
    ],
  },
]

// Normaliza texto: minúsculas + remove acentos + colapsa espaços
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extrai tokens do nome/URL de produto para comparação
function tokenize(text: string): string[] {
  return normalize(text).split(/\s+/).filter(t => t.length > 2)
}

/**
 * Detecta a categoria de um produto a partir do nome e/ou URL.
 *
 * @param name  - Nome do produto (ex: "Samsung Galaxy S24 Ultra 256GB")
 * @param url   - URL do produto (ex: "https://www.mercadolivre.com.br/...")
 * @returns     - Slug da categoria (ex: "smartphones") ou null se não detectado
 */
export function detectCategory(
  name: string = '',
  url:  string = '',
): string | null {
  const haystack = normalize(`${name} ${url}`)

  // Testa cada regra em ordem de especificidade
  for (const rule of CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      // Palavra-chave pode ser substring ou token exato
      const normalizedKw = normalize(kw).trim()
      if (normalizedKw && haystack.includes(normalizedKw)) {
        return rule.slug
      }
    }
  }

  return null
}

/**
 * Detecta categoria com fallback para valor existente.
 * Se `existing` já é um slug válido → mantém.
 * Se `existing` é null/vazio/undefined → tenta detectar.
 */
export function detectCategoryWithFallback(
  name:     string,
  url:      string,
  existing: string | null | undefined,
): string {
  // Se já tem categoria válida (não vazia, não 'outros'), mantém
  if (existing && existing.trim() && existing !== 'outros') {
    return existing
  }

  return detectCategory(name, url) ?? 'outros'
}
