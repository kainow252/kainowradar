import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/app_state.dart';

// ============================================================
// LEFT SIDEBAR — ícones de navegação estilo OpenHands/VSCode
// ============================================================
class LeftSidebar extends StatelessWidget {
  const LeftSidebar({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();

    return Container(
      width: 56,
      color: const Color(0xFF161B22),
      child: Column(
        children: [
          // Logo NexusIA
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child: Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF00B4D8), Color(0xFF00E676)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Center(
                child: Text('N',
                    style: TextStyle(
                        color: Colors.black,
                        fontWeight: FontWeight.w900,
                        fontSize: 18)),
              ),
            ),
          ),
          const Divider(height: 1, color: Color(0xFF21262D)),

          // Nav items
          const SizedBox(height: 8),
          _SideNavItem(
            icon: Icons.add_circle_outline,
            tooltip: 'Novo Projeto',
            onTap: () {
              context.read<AppState>().clearMessages();
              context.read<AppState>().setNavIndex(0);
            },
          ),
          _SideNavItem(
            icon: Icons.chat_bubble_outline_rounded,
            tooltip: 'Conversas',
            selected: state.selectedNavIndex == 0,
            onTap: () => context.read<AppState>().setNavIndex(0),
          ),
          _SideNavItem(
            icon: Icons.smart_toy_outlined,
            tooltip: 'Agentes',
            selected: state.selectedNavIndex == 1,
            onTap: () => context.read<AppState>().setNavIndex(1),
          ),
          _SideNavItem(
            icon: Icons.folder_open_outlined,
            tooltip: 'Projetos',
            selected: state.selectedNavIndex == 2,
            onTap: () => context.read<AppState>().setNavIndex(2),
          ),
          _SideNavItem(
            icon: Icons.extension_outlined,
            tooltip: 'Integrações BR',
            selected: state.selectedNavIndex == 3,
            onTap: () => context.read<AppState>().setNavIndex(3),
          ),

          const Spacer(),

          // Bottom icons
          _SideNavItem(
            icon: Icons.settings_outlined,
            tooltip: 'Configurações',
            onTap: () => _showSettings(context),
          ),
          _SideNavItem(
            icon: Icons.account_circle_outlined,
            tooltip: 'Perfil',
            onTap: () {},
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  void _showSettings(BuildContext context) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF161B22),
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
            side: const BorderSide(color: Color(0xFF30363D))),
        title: const Text('Configurações',
            style: TextStyle(color: Color(0xFFE6EDF3), fontSize: 16)),
        content: const SizedBox(
          width: 340,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              _SettingsRow(label: 'Modelo padrão', value: 'GPT-4o'),
              _SettingsRow(label: 'Agente padrão', value: 'AI Developer'),
              _SettingsRow(label: 'Idioma', value: 'Português BR'),
              _SettingsRow(label: 'Tema', value: 'Dark (GitHub)'),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Fechar'))
        ],
      ),
    );
  }
}

class _SideNavItem extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final bool selected;
  final VoidCallback? onTap;

  const _SideNavItem({
    required this.icon,
    required this.tooltip,
    this.selected = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      preferBelow: false,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          width: 40,
          height: 40,
          margin: const EdgeInsets.symmetric(vertical: 2),
          decoration: selected
              ? BoxDecoration(
                  color: const Color(0xFF00B4D8).withValues(alpha: 0.15),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(
                      color: const Color(0xFF00B4D8).withValues(alpha: 0.4)),
                )
              : null,
          child: Icon(
            icon,
            size: 20,
            color: selected ? const Color(0xFF00B4D8) : const Color(0xFF8B949E),
          ),
        ),
      ),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  final String label;
  final String value;
  const _SettingsRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Text(label,
              style: const TextStyle(
                  color: Color(0xFF8B949E), fontSize: 13)),
          const Spacer(),
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: const Color(0xFF0D1117),
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: const Color(0xFF30363D)),
            ),
            child: Text(value,
                style: const TextStyle(
                    color: Color(0xFF00B4D8), fontSize: 12)),
          ),
        ],
      ),
    );
  }
}
