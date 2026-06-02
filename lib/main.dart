import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'services/app_state.dart';
import 'widgets/left_sidebar.dart';
import 'widgets/center_panel.dart';
import 'widgets/right_panel.dart';

void main() {
  runApp(
    ChangeNotifierProvider(
      create: (_) => AppState(),
      child: const NexusIAApp(),
    ),
  );
}

class NexusIAApp extends StatelessWidget {
  const NexusIAApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NexusIA Dev',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(),
      home: const MainShell(),
    );
  }

  ThemeData _buildTheme() {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      fontFamily: 'monospace',
      scaffoldBackgroundColor: const Color(0xFF0D1117),
      colorScheme: const ColorScheme.dark(
        primary: Color(0xFF00B4D8),
        secondary: Color(0xFF00E676),
        surface: Color(0xFF161B22),
        onSurface: Color(0xFFE6EDF3),
        outline: Color(0xFF30363D),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFF161B22),
        elevation: 0,
        titleTextStyle: TextStyle(
          color: Color(0xFFE6EDF3),
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
        iconTheme: IconThemeData(color: Color(0xFF8B949E)),
      ),
      dividerTheme: const DividerThemeData(
        color: Color(0xFF21262D),
        thickness: 1,
      ),
      cardTheme: CardThemeData(
        color: const Color(0xFF161B22),
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(6),
          side: const BorderSide(color: Color(0xFF30363D)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: const Color(0xFF0D1117),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF30363D)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF30363D)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF00B4D8), width: 1.5),
        ),
        hintStyle: const TextStyle(color: Color(0xFF484F58)),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFF238636),
          foregroundColor: Colors.white,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
          padding:
              const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          textStyle:
              const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: const Color(0xFF58A6FF),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
          padding:
              const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          foregroundColor: const Color(0xFF8B949E)),
      ),
      textTheme: const TextTheme(
        bodyLarge:
            TextStyle(color: Color(0xFFE6EDF3), fontSize: 14, height: 1.6),
        bodyMedium:
            TextStyle(color: Color(0xFF8B949E), fontSize: 13, height: 1.5),
        bodySmall:
            TextStyle(color: Color(0xFF484F58), fontSize: 12),
        titleLarge: TextStyle(
            color: Color(0xFFE6EDF3),
            fontSize: 20,
            fontWeight: FontWeight.w600),
        titleMedium: TextStyle(
            color: Color(0xFFE6EDF3),
            fontSize: 16,
            fontWeight: FontWeight.w600),
        labelLarge: TextStyle(
            color: Color(0xFF00B4D8),
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.5),
      ),
    );
  }
}

// ============================================================
// SHELL PRINCIPAL — Layout responsivo 3 colunas
// ============================================================
class MainShell extends StatelessWidget {
  const MainShell({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D1117),
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final width = constraints.maxWidth;

            // Mobile < 600px: tela única com bottom nav
            if (width < 600) {
              return const _MobileLayout();
            }
            // Tablet 600–1100px: sidebar + painel central
            if (width < 1100) {
              return const _TabletLayout();
            }
            // Desktop 1100px+: 3 colunas completas
            return const _DesktopLayout();
          },
        ),
      ),
    );
  }
}

// ─── DESKTOP: 3 colunas ─────────────────────────────────────
class _DesktopLayout extends StatelessWidget {
  const _DesktopLayout();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return Row(
      children: [
        // Coluna 1 – Sidebar esquerda (64px)
        const LeftSidebar(),
        const VerticalDivider(width: 1),
        // Coluna 2 – Painel central (flex 1)
        const Expanded(flex: 2, child: CenterPanel()),
        if (state.rightPanelVisible) ...[
          const VerticalDivider(width: 1),
          // Coluna 3 – Painel direito (flex 1.5)
          const Expanded(flex: 3, child: RightPanel()),
        ],
      ],
    );
  }
}

// ─── TABLET: sidebar + centro ───────────────────────────────
class _TabletLayout extends StatelessWidget {
  const _TabletLayout();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const LeftSidebar(),
        const VerticalDivider(width: 1),
        const Expanded(child: CenterPanel()),
      ],
    );
  }
}

// ─── MOBILE: bottom nav ─────────────────────────────────────
class _MobileLayout extends StatelessWidget {
  const _MobileLayout();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final tabs = [
      const CenterPanel(),
      const RightPanel(),
      const _AgentsTabMobile(),
    ];

    return Column(
      children: [
        Expanded(child: tabs[state.selectedNavIndex > 2 ? 0 : state.selectedNavIndex]),
        Container(
          decoration: const BoxDecoration(
            color: Color(0xFF161B22),
            border: Border(top: BorderSide(color: Color(0xFF21262D))),
          ),
          child: Row(
            children: [
              _MobileNavItem(
                  icon: Icons.chat_bubble_outline,
                  label: 'Chat',
                  index: 0,
                  selected: state.selectedNavIndex == 0),
              _MobileNavItem(
                  icon: Icons.code_rounded,
                  label: 'Código',
                  index: 1,
                  selected: state.selectedNavIndex == 1),
              _MobileNavItem(
                  icon: Icons.smart_toy_outlined,
                  label: 'Agentes',
                  index: 2,
                  selected: state.selectedNavIndex == 2),
            ],
          ),
        ),
      ],
    );
  }
}

class _MobileNavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final int index;
  final bool selected;
  const _MobileNavItem(
      {required this.icon,
      required this.label,
      required this.index,
      required this.selected});

  @override
  Widget build(BuildContext context) {
    final color =
        selected ? const Color(0xFF00B4D8) : const Color(0xFF8B949E);
    return Expanded(
      child: InkWell(
        onTap: () => context.read<AppState>().setNavIndex(index),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, color: color, size: 22),
              const SizedBox(height: 3),
              Text(label,
                  style: TextStyle(
                      color: color,
                      fontSize: 10,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.normal)),
            ],
          ),
        ),
      ),
    );
  }
}

class _AgentsTabMobile extends StatelessWidget {
  const _AgentsTabMobile();
  @override
  Widget build(BuildContext context) {
    // Reutiliza o AgentsScreen embutido no painel central
    return const CenterPanel();
  }
}
