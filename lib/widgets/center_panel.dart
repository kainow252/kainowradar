import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/app_state.dart';
import '../models/app_models.dart';
import 'chat_widgets.dart';

// ============================================================
// CENTER PANEL — Chat / Agentes / Projetos / Integrações
// ============================================================
class CenterPanel extends StatelessWidget {
  const CenterPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final idx = context.watch<AppState>().selectedNavIndex;
    return switch (idx) {
      1 => const _AgentsScreen(),
      2 => const _ProjectsScreen(),
      3 => const _IntegrationsScreen(),
      _ => const _ChatScreen(),
    };
  }
}

// ─── TELA DE CHAT (Home) ─────────────────────────────────────
class _ChatScreen extends StatefulWidget {
  const _ChatScreen();

  @override
  State<_ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<_ChatScreen> {
  final TextEditingController _ctrl = TextEditingController();
  final ScrollController _scroll = ScrollController();

  final List<_SuggestionChip> _suggestions = const [
    _SuggestionChip(Icons.phone_android, 'Criar app Flutter\ncom Firebase'),
    _SuggestionChip(Icons.language, 'Criar site Next.js\ncom Tailwind'),
    _SuggestionChip(Icons.api, 'API Python\ncom integração Pix'),
    _SuggestionChip(Icons.smart_toy_outlined, 'Chatbot com\nLangChain + RAG'),
    _SuggestionChip(Icons.dashboard, 'Dashboard React\ncom gráficos'),
    _SuggestionChip(Icons.shopping_cart_outlined, 'E-commerce\nMercado Livre API'),
  ];

  void _send() {
    final text = _ctrl.text.trim();
    if (text.isEmpty) return;
    _ctrl.clear();
    context.read<AppState>().sendMessage(text);
    // scroll para baixo
    Future.delayed(const Duration(milliseconds: 100), () {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut);
      }
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final msgs = state.messages;

    return Column(
      children: [
        // Top bar
        _TopBar(
          title: state.hasProject ? state.projectName : 'NexusIA Dev',
          subtitle: state.hasProject ? state.projectBranch : '',
          onToggleRight: () => context.read<AppState>().toggleRightPanel(),
        ),

        // Mensagens ou splash
        Expanded(
          child: msgs.isEmpty
              ? _buildSplash(context)
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(16),
                  itemCount: msgs.length,
                  itemBuilder: (_, i) => ChatMessageBubble(message: msgs[i]),
                ),
        ),

        // Barra de input
        _ChatInputBar(
          controller: _ctrl,
          isRunning: state.isAgentRunning,
          onSend: _send,
          onStop: () => context.read<AppState>().clearMessages(),
        ),

        // Status bar
        _StatusBar(
          projectName: state.hasProject ? state.projectName : 'Nenhum projeto conectado',
          branch: state.hasProject ? state.projectBranch : 'Sem filial',
          isRunning: state.isAgentRunning,
        ),
      ],
    );
  }

  Widget _buildSplash(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // Ícone central
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF00B4D8), Color(0xFF00E676)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(16),
            ),
            child: const Center(
              child: Text('🛠️', style: TextStyle(fontSize: 36)),
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'Vamos começar a construir!',
            style: TextStyle(
              color: Color(0xFFE6EDF3),
              fontSize: 22,
              fontWeight: FontWeight.w700,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          const Text(
            'Descreva o que você quer criar — site, app, API, IA, ou qualquer sistema.',
            style: TextStyle(color: Color(0xFF8B949E), fontSize: 14, height: 1.5),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 32),

          // Grid de sugestões
          LayoutBuilder(
            builder: (ctx, c) {
              final cols = c.maxWidth > 500 ? 3 : 2;
              return GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: cols,
                  childAspectRatio: 2.4,
                  crossAxisSpacing: 8,
                  mainAxisSpacing: 8,
                ),
                itemCount: _suggestions.length,
                itemBuilder: (_, i) => _SuggestionCard(
                  chip: _suggestions[i],
                  onTap: () {
                    _ctrl.text = _suggestions[i].text.replaceAll('\n', ' ');
                    _send();
                  },
                ),
              );
            },
          ),
          const SizedBox(height: 24),

          // Agentes disponíveis
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('  Agentes disponíveis',
                style: TextStyle(
                    color: Color(0xFF484F58),
                    fontSize: 12,
                    fontWeight: FontWeight.w600)),
          ),
          const SizedBox(height: 8),
          const _AgentChipsRow(),
        ],
      ),
    );
  }
}

class _SuggestionChip {
  final IconData icon;
  final String text;
  const _SuggestionChip(this.icon, this.text);
}

class _SuggestionCard extends StatelessWidget {
  final _SuggestionChip chip;
  final VoidCallback onTap;
  const _SuggestionCard({required this.chip, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFF161B22),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Row(
          children: [
            Icon(chip.icon, color: const Color(0xFF00B4D8), size: 18),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                chip.text,
                style: const TextStyle(
                  color: Color(0xFFE6EDF3),
                  fontSize: 12,
                  height: 1.3,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AgentChipsRow extends StatelessWidget {
  const _AgentChipsRow();

  @override
  Widget build(BuildContext context) {
    final agents = context.read<AppState>().agents;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: agents
          .map((a) => Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: Color(a.color.bg).withValues(alpha: 0.5),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                      color: Color(a.color.accent).withValues(alpha: 0.4)),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(a.emoji, style: const TextStyle(fontSize: 13)),
                    const SizedBox(width: 4),
                    Text(a.name,
                        style: TextStyle(
                            color: Color(a.color.accent),
                            fontSize: 11,
                            fontWeight: FontWeight.w600)),
                  ],
                ),
              ))
          .toList(),
    );
  }
}

// ─── TOP BAR ────────────────────────────────────────────────
class _TopBar extends StatelessWidget {
  final String title;
  final String subtitle;
  final VoidCallback onToggleRight;

  const _TopBar(
      {required this.title,
      required this.subtitle,
      required this.onToggleRight});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 48,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(
        color: Color(0xFF161B22),
        border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
      ),
      child: Row(
        children: [
          const Icon(Icons.hub_outlined, color: Color(0xFF00B4D8), size: 18),
          const SizedBox(width: 8),
          Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
              if (subtitle.isNotEmpty)
                Text(subtitle,
                    style: const TextStyle(
                        color: Color(0xFF484F58), fontSize: 10)),
            ],
          ),
          const Spacer(),
          // Modelo selecionado
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xFF0D1117),
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: const Color(0xFF30363D)),
            ),
            child: Row(
              children: [
                const Icon(Icons.auto_awesome, color: Color(0xFF00B4D8), size: 12),
                const SizedBox(width: 4),
                const Text('AI Developer',
                    style: TextStyle(color: Color(0xFF8B949E), fontSize: 11)),
                const Icon(Icons.expand_more, color: Color(0xFF484F58), size: 14),
              ],
            ),
          ),
          const SizedBox(width: 6),
          // Toggle painel direito
          IconButton(
            icon: const Icon(Icons.view_sidebar_outlined, size: 18),
            tooltip: 'Painel de trabalho',
            onPressed: onToggleRight,
            color: const Color(0xFF8B949E),
            padding: const EdgeInsets.all(4),
            constraints: const BoxConstraints(),
          ),
        ],
      ),
    );
  }
}

// ─── CHAT INPUT BAR ─────────────────────────────────────────
class _ChatInputBar extends StatelessWidget {
  final TextEditingController controller;
  final bool isRunning;
  final VoidCallback onSend;
  final VoidCallback onStop;

  const _ChatInputBar({
    required this.controller,
    required this.isRunning,
    required this.onSend,
    required this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      decoration: const BoxDecoration(
        color: Color(0xFF161B22),
        border: Border(top: BorderSide(color: Color(0xFF21262D))),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Campo de texto
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              // Clipe (attach)
              IconButton(
                icon: const Icon(Icons.attach_file, size: 18),
                onPressed: () {},
                color: const Color(0xFF8B949E),
                padding: const EdgeInsets.all(4),
                constraints: const BoxConstraints(),
              ),
              const SizedBox(width: 6),
              // TextField
              Expanded(
                child: TextField(
                  controller: controller,
                  maxLines: 4,
                  minLines: 1,
                  enabled: !isRunning,
                  onSubmitted: (_) => onSend(),
                  style: const TextStyle(
                    color: Color(0xFFE6EDF3),
                    fontSize: 14,
                    height: 1.5,
                  ),
                  decoration: const InputDecoration(
                    hintText: "Descreva o que quer construir...",
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                    filled: false,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Botão enviar / parar
              if (isRunning)
                _ActionButton(
                  icon: Icons.stop_rounded,
                  label: 'Parar',
                  color: const Color(0xFFDA3633),
                  onTap: onStop,
                )
              else
                _ActionButton(
                  icon: Icons.send_rounded,
                  label: 'Enviar',
                  color: const Color(0xFF238636),
                  onTap: onSend,
                ),
            ],
          ),

          const SizedBox(height: 6),

          // Toolbar inferior
          Row(
            children: [
              _ToolbarChip(
                icon: Icons.build_outlined,
                label: 'Ferramentas',
                onTap: () {},
              ),
              const SizedBox(width: 6),
              _ToolbarChip(
                icon: Icons.format_list_bulleted,
                label: 'Plano',
                color: const Color(0xFF00B4D8),
                onTap: () => context.read<AppState>().setPanelTab(PanelTab.planner),
              ),
              const SizedBox(width: 6),
              _ToolbarChip(
                icon: Icons.smart_toy_outlined,
                label: 'Agente',
                onTap: () {},
              ),
              const Spacer(),
              if (isRunning)
                Row(
                  children: [
                    SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.5,
                        color: const Color(0xFF00B4D8),
                      ),
                    ),
                    const SizedBox(width: 6),
                    const Text('Aguardando tarefa',
                        style: TextStyle(
                            color: Color(0xFF8B949E), fontSize: 11)),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;
  const _ActionButton(
      {required this.icon,
      required this.label,
      required this.color,
      required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            Icon(icon, size: 15, color: Colors.white),
            const SizedBox(width: 4),
            Text(label,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 12,
                    fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class _ToolbarChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color? color;
  final VoidCallback? onTap;
  const _ToolbarChip(
      {required this.icon,
      required this.label,
      this.color,
      this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = color ?? const Color(0xFF8B949E);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: const Color(0xFF0D1117),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 13, color: c),
            const SizedBox(width: 4),
            Text(label,
                style: TextStyle(
                    color: c,
                    fontSize: 11,
                    fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }
}

// ─── STATUS BAR ─────────────────────────────────────────────
class _StatusBar extends StatelessWidget {
  final String projectName;
  final String branch;
  final bool isRunning;
  const _StatusBar(
      {required this.projectName,
      required this.branch,
      required this.isRunning});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      color: const Color(0xFF0D1117),
      child: Row(
        children: [
          Icon(Icons.circle,
              size: 8,
              color: isRunning ? const Color(0xFF00E676) : const Color(0xFF484F58)),
          const SizedBox(width: 6),
          Text(projectName,
              style: const TextStyle(
                  color: Color(0xFF484F58), fontSize: 11)),
          const SizedBox(width: 12),
          if (branch.isNotEmpty && branch != 'Sem filial') ...[
            const Icon(Icons.fork_right, size: 12, color: Color(0xFF484F58)),
            const SizedBox(width: 3),
            Text(branch,
                style: const TextStyle(
                    color: Color(0xFF484F58), fontSize: 11)),
          ] else
            Text(branch,
                style: const TextStyle(
                    color: Color(0xFF484F58), fontSize: 11)),
          const Spacer(),
          if (isRunning)
            const Text('● Executando',
                style: TextStyle(
                    color: Color(0xFF00E676), fontSize: 11)),
        ],
      ),
    );
  }
}

// ─── TELA DE AGENTES ────────────────────────────────────────
class _AgentsScreen extends StatelessWidget {
  const _AgentsScreen();

  @override
  Widget build(BuildContext context) {
    final agents = context.read<AppState>().agents;

    return Column(
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            color: Color(0xFF161B22),
            border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
          ),
          child: const Row(
            children: [
              Icon(Icons.smart_toy_outlined, color: Color(0xFF00B4D8), size: 18),
              SizedBox(width: 8),
              Text('Agentes Especializados',
                  style: TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 14,
                      fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: agents.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, i) => _AgentCard(agent: agents[i]),
          ),
        ),
      ],
    );
  }
}

class _AgentCard extends StatelessWidget {
  final AgentModel agent;
  const _AgentCard({required this.agent});

  @override
  Widget build(BuildContext context) {
    final accentColor = Color(agent.color.accent);

    return InkWell(
      onTap: () {
        // Selecionar agente e ir para o chat
        context.read<AppState>().setNavIndex(0);
        context.read<AppState>().sendMessage(
            'Use o agente ${agent.name} para me ajudar com ${agent.specialty}');
      },
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: const Color(0xFF161B22),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: Color(agent.color.bg),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                        color: accentColor.withValues(alpha: 0.5)),
                  ),
                  child: Center(
                    child: Text(agent.emoji,
                        style: const TextStyle(fontSize: 20)),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(agent.name,
                          style: const TextStyle(
                              color: Color(0xFFE6EDF3),
                              fontSize: 14,
                              fontWeight: FontWeight.w600)),
                      Text(agent.specialty,
                          style: TextStyle(
                              color: accentColor,
                              fontSize: 11,
                              fontWeight: FontWeight.w500)),
                    ],
                  ),
                ),
                // Status indicator
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFF238636).withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                        color: const Color(0xFF238636).withValues(alpha: 0.5)),
                  ),
                  child: const Text('Ativo',
                      style: TextStyle(
                          color: Color(0xFF3FB950),
                          fontSize: 10,
                          fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(agent.description,
                style: const TextStyle(
                    color: Color(0xFF8B949E),
                    fontSize: 12,
                    height: 1.4)),
            const SizedBox(height: 10),
            // Capabilities chips
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: agent.capabilities
                  .map((c) => Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: accentColor.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(4),
                          border: Border.all(
                              color: accentColor.withValues(alpha: 0.3)),
                        ),
                        child: Text(c,
                            style: TextStyle(
                                color: accentColor,
                                fontSize: 10)),
                      ))
                  .toList(),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── TELA DE PROJETOS ────────────────────────────────────────
class _ProjectsScreen extends StatelessWidget {
  const _ProjectsScreen();

  static final _demoProjects = [
    {'name': 'app-delivery-flutter', 'type': '📱 Mobile', 'status': 'Em Desenvolvimento', 'agents': '3 agentes'},
    {'name': 'api-pix-fastapi', 'type': '⚙️ Backend', 'status': 'Completo', 'agents': '2 agentes'},
    {'name': 'saas-dashboard-next', 'type': '🌐 Web App', 'status': 'Em Revisão', 'agents': '4 agentes'},
    {'name': 'bot-whatsapp-langchain', 'type': '🤖 IA', 'status': 'Planejando', 'agents': '2 agentes'},
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            color: Color(0xFF161B22),
            border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
          ),
          child: Row(
            children: [
              const Icon(Icons.folder_open_outlined,
                  color: Color(0xFF00B4D8), size: 18),
              const SizedBox(width: 8),
              const Text('Projetos',
                  style: TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 14,
                      fontWeight: FontWeight.w600)),
              const Spacer(),
              ElevatedButton.icon(
                onPressed: () => context.read<AppState>().setNavIndex(0),
                icon: const Icon(Icons.add, size: 14),
                label: const Text('Novo', style: TextStyle(fontSize: 12)),
                style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 6),
                    minimumSize: Size.zero),
              )
            ],
          ),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: _demoProjects.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (_, i) {
              final p = _demoProjects[i];
              return Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFF161B22),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0xFF30363D)),
                ),
                child: Row(
                  children: [
                    Text(p['type']!,
                        style: const TextStyle(fontSize: 18)),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(p['name']!,
                              style: const TextStyle(
                                  color: Color(0xFF58A6FF),
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600)),
                          const SizedBox(height: 2),
                          Text('${p['agents']}',
                              style: const TextStyle(
                                  color: Color(0xFF8B949E), fontSize: 11)),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFF21262D),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(p['status']!,
                          style: const TextStyle(
                              color: Color(0xFF8B949E), fontSize: 10)),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}

// ─── TELA DE INTEGRAÇÕES BR ──────────────────────────────────
class _IntegrationsScreen extends StatelessWidget {
  const _IntegrationsScreen();

  static final _integrations = [
    {'emoji': '💸', 'name': 'Pix / Open Finance', 'desc': 'Gerencianet, Asaas, Stark Bank', 'status': true},
    {'emoji': '💬', 'name': 'WhatsApp Business', 'desc': 'Cloud API, WPPConnect, Blip', 'status': true},
    {'emoji': '🏢', 'name': 'CNPJ / Receita Federal', 'desc': 'Consulta automática de empresas', 'status': true},
    {'emoji': '🧾', 'name': 'NF-e / NFS-e', 'desc': 'Emissão de notas fiscais', 'status': false},
    {'emoji': '📧', 'name': 'RD Station / ActiveCampaign', 'desc': 'CRM e automação de marketing', 'status': false},
    {'emoji': '🛒', 'name': 'Mercado Livre API', 'desc': 'Listagens e pedidos e-commerce', 'status': false},
    {'emoji': '🧠', 'name': 'Maritaca AI (Sabiá-3)', 'desc': 'LLM nativo brasileiro', 'status': true},
    {'emoji': '🏦', 'name': 'Open Banking BR', 'desc': 'Integração bancária nativa', 'status': false},
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          decoration: const BoxDecoration(
            color: Color(0xFF161B22),
            border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
          ),
          child: const Row(
            children: [
              Text('🇧🇷', style: TextStyle(fontSize: 18)),
              SizedBox(width: 8),
              Text('Integrações Brasileiras',
                  style: TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 14,
                      fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.all(12),
            itemCount: _integrations.length,
            separatorBuilder: (_, __) => const SizedBox(height: 6),
            itemBuilder: (_, i) {
              final item = _integrations[i];
              final active = item['status'] as bool;
              return Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xFF161B22),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFF30363D)),
                ),
                child: Row(
                  children: [
                    Text(item['emoji']! as String,
                        style: const TextStyle(fontSize: 20)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(item['name']! as String,
                              style: const TextStyle(
                                  color: Color(0xFFE6EDF3),
                                  fontSize: 13,
                                  fontWeight: FontWeight.w500)),
                          Text(item['desc']! as String,
                              style: const TextStyle(
                                  color: Color(0xFF8B949E), fontSize: 11)),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: active
                            ? const Color(0xFF238636).withValues(alpha: 0.2)
                            : const Color(0xFF21262D),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                            color: active
                                ? const Color(0xFF238636).withValues(alpha: 0.5)
                                : const Color(0xFF30363D)),
                      ),
                      child: Text(active ? 'Disponível' : 'Em breve',
                          style: TextStyle(
                              color: active
                                  ? const Color(0xFF3FB950)
                                  : const Color(0xFF484F58),
                              fontSize: 10,
                              fontWeight: FontWeight.w600)),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
