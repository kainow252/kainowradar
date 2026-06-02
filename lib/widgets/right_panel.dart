import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/app_state.dart';
import '../models/app_models.dart';

// ============================================================
// RIGHT PANEL — Planejador / Código / Browser / Terminal
// ============================================================
class RightPanel extends StatelessWidget {
  const RightPanel({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFF0D1117),
      child: Column(
        children: [
          const _RightPanelTabBar(),
          const Divider(height: 1),
          const Expanded(child: _RightPanelContent()),
        ],
      ),
    );
  }
}

// ─── TAB BAR SUPERIOR ───────────────────────────────────────
class _RightPanelTabBar extends StatelessWidget {
  const _RightPanelTabBar();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final tab = state.activePanelTab;

    final tabs = [
      (PanelTab.planner, Icons.format_list_bulleted, 'Planejador'),
      (PanelTab.code, Icons.code_rounded, 'Código'),
      (PanelTab.browser, Icons.language_outlined, 'Browser'),
      (PanelTab.terminal, Icons.terminal_rounded, 'Terminal'),
      (PanelTab.preview, Icons.preview_outlined, 'Preview'),
    ];

    return Container(
      height: 48,
      color: const Color(0xFF161B22),
      child: Row(
        children: [
          ...tabs.map((t) {
            final (panelTab, icon, label) = t;
            final selected = tab == panelTab;
            return InkWell(
              onTap: () => context.read<AppState>().setPanelTab(panelTab),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 0),
                height: 48,
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                      color: selected
                          ? const Color(0xFFF78166)
                          : Colors.transparent,
                      width: 2,
                    ),
                  ),
                ),
                child: Row(
                  children: [
                    Icon(
                      icon,
                      size: 15,
                      color: selected
                          ? const Color(0xFFE6EDF3)
                          : const Color(0xFF8B949E),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      label,
                      style: TextStyle(
                        color: selected
                            ? const Color(0xFFE6EDF3)
                            : const Color(0xFF8B949E),
                        fontSize: 12,
                        fontWeight: selected
                            ? FontWeight.w600
                            : FontWeight.normal,
                      ),
                    ),
                  ],
                ),
              ),
            );
          }),
          const Spacer(),
          // Botão expandir
          IconButton(
            icon: const Icon(Icons.open_in_full, size: 14),
            onPressed: () {},
            color: const Color(0xFF484F58),
            padding: const EdgeInsets.all(8),
            constraints: const BoxConstraints(),
          ),
          const SizedBox(width: 8),
        ],
      ),
    );
  }
}

// ─── CONTEÚDO DO PAINEL ──────────────────────────────────────
class _RightPanelContent extends StatelessWidget {
  const _RightPanelContent();

  @override
  Widget build(BuildContext context) {
    final tab = context.watch<AppState>().activePanelTab;
    return switch (tab) {
      PanelTab.planner => const _PlannerView(),
      PanelTab.code => const _CodeView(),
      PanelTab.browser => const _BrowserView(),
      PanelTab.terminal => const _TerminalView(),
      PanelTab.preview => const _PreviewView(),
    };
  }
}

// ─── PLANEJADOR ─────────────────────────────────────────────
class _PlannerView extends StatelessWidget {
  const _PlannerView();

  @override
  Widget build(BuildContext context) {
    final tasks = context.watch<AppState>().planTasks;
    final isRunning = context.watch<AppState>().isAgentRunning;

    if (tasks.isEmpty && !isRunning) {
      return const _EmptyPanel(
        icon: Icons.format_list_bulleted,
        title: 'Planejador',
        subtitle: 'O plano de desenvolvimento aparecerá aqui\nquando você iniciar uma tarefa.',
      );
    }

    if (isRunning && tasks.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircularProgressIndicator(
              color: Color(0xFF00B4D8),
              strokeWidth: 2,
            ),
            SizedBox(height: 16),
            Text('Carregando...',
                style: TextStyle(color: Color(0xFF8B949E), fontSize: 14)),
          ],
        ),
      );
    }

    // Calcular progresso
    final done = tasks.where((t) => t.status == TaskStatus.done).length;
    final inProg = tasks.where((t) => t.status == TaskStatus.inProgress).length;

    return Column(
      children: [
        // Header com progresso
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('$done/${tasks.length} concluídas',
                      style: const TextStyle(
                          color: Color(0xFF8B949E), fontSize: 12)),
                  const Spacer(),
                  if (inProg > 0)
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0xFF00B4D8).withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text('$inProg em andamento',
                          style: const TextStyle(
                              color: Color(0xFF00B4D8), fontSize: 10)),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              // Progress bar
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: tasks.isEmpty ? 0 : done / tasks.length,
                  backgroundColor: const Color(0xFF21262D),
                  color: const Color(0xFF00E676),
                  minHeight: 4,
                ),
              ),
            ],
          ),
        ),

        // Lista de tarefas
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: tasks.length,
            itemBuilder: (_, i) => _TaskItem(task: tasks[i], index: i),
          ),
        ),
      ],
    );
  }
}

class _TaskItem extends StatelessWidget {
  final PlanTask task;
  final int index;
  const _TaskItem({required this.task, required this.index});

  @override
  Widget build(BuildContext context) {
    IconData statusIcon;
    Color statusColor;

    switch (task.status) {
      case TaskStatus.done:
        statusIcon = Icons.check_circle;
        statusColor = const Color(0xFF3FB950);
        break;
      case TaskStatus.inProgress:
        statusIcon = Icons.radio_button_checked;
        statusColor = const Color(0xFF00B4D8);
        break;
      case TaskStatus.failed:
        statusIcon = Icons.cancel;
        statusColor = const Color(0xFFDA3633);
        break;
      default:
        statusIcon = Icons.radio_button_unchecked;
        statusColor = const Color(0xFF484F58);
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: task.status == TaskStatus.inProgress
              ? const Color(0xFF00B4D8).withValues(alpha: 0.05)
              : const Color(0xFF161B22),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(
            color: task.status == TaskStatus.inProgress
                ? const Color(0xFF00B4D8).withValues(alpha: 0.3)
                : const Color(0xFF21262D),
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Número
            Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: const Color(0xFF21262D),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Center(
                child: Text('${index + 1}',
                    style: const TextStyle(
                        color: Color(0xFF484F58),
                        fontSize: 10,
                        fontWeight: FontWeight.w600)),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(task.title,
                      style: TextStyle(
                          color: task.status == TaskStatus.done
                              ? const Color(0xFF484F58)
                              : const Color(0xFFE6EDF3),
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          decoration: task.status == TaskStatus.done
                              ? TextDecoration.lineThrough
                              : null)),
                  const SizedBox(height: 2),
                  Text(task.description,
                      style: const TextStyle(
                          color: Color(0xFF484F58), fontSize: 11, height: 1.3)),
                  if (task.assignedAgent != null) ...[
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        const Icon(Icons.smart_toy_outlined,
                            size: 10, color: Color(0xFF8B949E)),
                        const SizedBox(width: 3),
                        Text(task.assignedAgent!,
                            style: const TextStyle(
                                color: Color(0xFF8B949E), fontSize: 10)),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            Icon(statusIcon, size: 16, color: statusColor),
          ],
        ),
      ),
    );
  }
}

// ─── VISUALIZADOR DE CÓDIGO ──────────────────────────────────
class _CodeView extends StatelessWidget {
  const _CodeView();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final files = state.codeFiles;

    if (files.isEmpty) {
      return const _EmptyPanel(
        icon: Icons.code_rounded,
        title: 'Editor de Código',
        subtitle: 'Os arquivos gerados pelos agentes\naparecerão aqui.',
      );
    }

    final activeFile = state.activeCodeFile!;

    return Column(
      children: [
        // File tabs
        Container(
          height: 38,
          color: const Color(0xFF161B22),
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: files.length,
            itemBuilder: (_, i) {
              final selected = i == state.activeCodeFileIndex;
              return InkWell(
                onTap: () => context.read<AppState>().setCodeFileIndex(i),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 14, vertical: 0),
                  decoration: BoxDecoration(
                    color: selected
                        ? const Color(0xFF0D1117)
                        : Colors.transparent,
                    border: Border(
                      bottom: BorderSide(
                        color: selected
                            ? const Color(0xFF00B4D8)
                            : Colors.transparent,
                        width: 2,
                      ),
                      right: const BorderSide(color: Color(0xFF21262D)),
                    ),
                  ),
                  child: Row(
                    children: [
                      _fileIcon(files[i].language),
                      const SizedBox(width: 6),
                      Text(files[i].filename,
                          style: TextStyle(
                              color: selected
                                  ? const Color(0xFFE6EDF3)
                                  : const Color(0xFF8B949E),
                              fontSize: 12)),
                    ],
                  ),
                ),
              );
            },
          ),
        ),

        // Código
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Line numbers
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: activeFile.content.split('\n').asMap().entries.map((e) {
                    return Text('${e.key + 1}',
                        style: const TextStyle(
                            color: Color(0xFF484F58),
                            fontSize: 12,
                            fontFamily: 'monospace',
                            height: 1.6));
                  }).toList(),
                ),
                const SizedBox(width: 16),
                // Código
                Expanded(
                  child: SelectableText(
                    activeFile.content,
                    style: const TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 12,
                      fontFamily: 'monospace',
                      height: 1.6,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),

        // Footer
        Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          color: const Color(0xFF161B22),
          child: Row(
            children: [
              Text(activeFile.language,
                  style: const TextStyle(
                      color: Color(0xFF8B949E), fontSize: 10)),
              const SizedBox(width: 12),
              Text(
                  '${activeFile.content.split('\n').length} linhas',
                  style: const TextStyle(
                      color: Color(0xFF484F58), fontSize: 10)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _fileIcon(String lang) {
    final icons = {
      'dart': '🎯',
      'python': '🐍',
      'yaml': '⚙️',
      'markdown': '📄',
      'javascript': '🟨',
      'typescript': '🔷',
      'text': '📝',
    };
    return Text(icons[lang] ?? '📄',
        style: const TextStyle(fontSize: 12));
  }
}

// ─── BROWSER ────────────────────────────────────────────────
class _BrowserView extends StatelessWidget {
  const _BrowserView();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // URL bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: const BoxDecoration(
            color: Color(0xFF161B22),
            border: Border(bottom: BorderSide(color: Color(0xFF21262D))),
          ),
          child: Row(
            children: [
              const Icon(Icons.arrow_back, size: 16, color: Color(0xFF484F58)),
              const SizedBox(width: 6),
              const Icon(Icons.arrow_forward, size: 16, color: Color(0xFF484F58)),
              const SizedBox(width: 6),
              const Icon(Icons.refresh, size: 16, color: Color(0xFF8B949E)),
              const SizedBox(width: 8),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: const Color(0xFF0D1117),
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: const Color(0xFF30363D)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.lock_outline,
                          size: 12, color: Color(0xFF3FB950)),
                      SizedBox(width: 4),
                      Text('localhost:3000',
                          style: TextStyle(
                              color: Color(0xFF8B949E), fontSize: 11)),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),

        // Browser content
        Expanded(
          child: Container(
            color: const Color(0xFF0D1117),
            child: const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text('🌐', style: TextStyle(fontSize: 48)),
                  SizedBox(height: 16),
                  Text('Preview do App',
                      style: TextStyle(
                          color: Color(0xFFE6EDF3),
                          fontSize: 16,
                          fontWeight: FontWeight.w600)),
                  SizedBox(height: 8),
                  Text(
                      'O preview do site/app gerado\naparecerá aqui automaticamente.',
                      style:
                          TextStyle(color: Color(0xFF8B949E), fontSize: 12),
                      textAlign: TextAlign.center),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── TERMINAL ────────────────────────────────────────────────
class _TerminalView extends StatelessWidget {
  const _TerminalView();

  @override
  Widget build(BuildContext context) {
    final lines = context.watch<AppState>().terminalLines;
    final isRunning = context.watch<AppState>().isAgentRunning;

    return Column(
      children: [
        // Terminal header
        Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          color: const Color(0xFF161B22),
          child: Row(
            children: [
              const Text('bash',
                  style: TextStyle(
                      color: Color(0xFF8B949E),
                      fontSize: 11,
                      fontWeight: FontWeight.w500)),
              const SizedBox(width: 8),
              const Text('~/projeto',
                  style: TextStyle(
                      color: Color(0xFF3FB950), fontSize: 11)),
              const Spacer(),
              if (isRunning)
                const SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: Color(0xFF3FB950),
                  ),
                ),
            ],
          ),
        ),

        // Output
        Expanded(
          child: Container(
            color: const Color(0xFF0D1117),
            child: lines.isEmpty
                ? const Center(
                    child: Text('Terminal aguardando...',
                        style: TextStyle(
                            color: Color(0xFF484F58), fontSize: 12)),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: lines.length,
                    itemBuilder: (_, i) => Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(
                        lines[i],
                        style: TextStyle(
                          color: lines[i].contains('✅')
                              ? const Color(0xFF3FB950)
                              : lines[i].contains('❌')
                                  ? const Color(0xFFDA3633)
                                  : const Color(0xFF8B949E),
                          fontSize: 11,
                          fontFamily: 'monospace',
                          height: 1.4,
                        ),
                      ),
                    ),
                  ),
          ),
        ),

        // Input
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          color: const Color(0xFF161B22),
          child: Row(
            children: [
              const Text('\$',
                  style: TextStyle(
                      color: Color(0xFF3FB950),
                      fontSize: 12,
                      fontFamily: 'monospace')),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  isRunning ? 'Executando comando...' : '',
                  style: const TextStyle(
                      color: Color(0xFF8B949E),
                      fontSize: 12,
                      fontFamily: 'monospace'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ─── PREVIEW ─────────────────────────────────────────────────
class _PreviewView extends StatelessWidget {
  const _PreviewView();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('📱', style: TextStyle(fontSize: 56)),
          SizedBox(height: 16),
          Text('Live Preview',
              style: TextStyle(
                  color: Color(0xFFE6EDF3),
                  fontSize: 16,
                  fontWeight: FontWeight.w600)),
          SizedBox(height: 8),
          Text('O preview em tempo real do\napp Flutter ou site aparecerá aqui.',
              style: TextStyle(color: Color(0xFF8B949E), fontSize: 12),
              textAlign: TextAlign.center),
        ],
      ),
    );
  }
}

// ─── EMPTY STATE GENÉRICO ────────────────────────────────────
class _EmptyPanel extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _EmptyPanel(
      {required this.icon, required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 40, color: const Color(0xFF484F58)),
          const SizedBox(height: 12),
          Text(title,
              style: const TextStyle(
                  color: Color(0xFF8B949E),
                  fontSize: 14,
                  fontWeight: FontWeight.w500)),
          const SizedBox(height: 6),
          Text(subtitle,
              style: const TextStyle(
                  color: Color(0xFF484F58), fontSize: 12, height: 1.5),
              textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
