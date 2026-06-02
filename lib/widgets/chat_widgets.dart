import 'package:flutter/material.dart';
import '../models/app_models.dart';

// ============================================================
// CHAT WIDGETS — Bolhas de mensagem do chat
// ============================================================

class ChatMessageBubble extends StatelessWidget {
  final ChatMessage message;
  const ChatMessageBubble({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    return switch (message.role) {
      MessageRole.system => _SystemMessage(message: message),
      MessageRole.user => _UserMessage(message: message),
      MessageRole.agent => _AgentMessage(message: message),
      MessageRole.tool => _ToolMessage(message: message),
    };
  }
}

// ─── Mensagem do usuário ────────────────────────────────────
class _UserMessage extends StatelessWidget {
  final ChatMessage message;
  const _UserMessage({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Avatar usuário
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: const Color(0xFF7C3AED),
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Center(
              child: Text('U',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 13,
                      fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text('Você',
                        style: TextStyle(
                            color: Color(0xFFE6EDF3),
                            fontSize: 12,
                            fontWeight: FontWeight.w700)),
                    const SizedBox(width: 6),
                    Text(
                      _formatTime(message.timestamp),
                      style: const TextStyle(
                          color: Color(0xFF484F58), fontSize: 10),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  message.content,
                  style: const TextStyle(
                      color: Color(0xFFE6EDF3),
                      fontSize: 14,
                      height: 1.6),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Mensagem do agente ────────────────────────────────────
class _AgentMessage extends StatelessWidget {
  final ChatMessage message;
  const _AgentMessage({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Avatar agente
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              gradient: const LinearGradient(
                colors: [Color(0xFF00B4D8), Color(0xFF00E676)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Center(
              child: Text('🤖', style: TextStyle(fontSize: 14)),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(message.agentName ?? 'AI Developer',
                        style: const TextStyle(
                            color: Color(0xFF00B4D8),
                            fontSize: 12,
                            fontWeight: FontWeight.w700)),
                    const SizedBox(width: 6),
                    Text(
                      _formatTime(message.timestamp),
                      style: const TextStyle(
                          color: Color(0xFF484F58), fontSize: 10),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                // Formatar markdown simples
                _MarkdownText(content: message.content),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Mensagem do sistema ───────────────────────────────────
class _SystemMessage extends StatelessWidget {
  final ChatMessage message;
  const _SystemMessage({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: const Color(0xFF161B22),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Row(
          children: [
            const Icon(Icons.info_outline, size: 14, color: Color(0xFF8B949E)),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                message.content,
                style: const TextStyle(
                    color: Color(0xFF8B949E),
                    fontSize: 12,
                    fontStyle: FontStyle.italic),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Mensagem de ferramenta ───────────────────────────────
class _ToolMessage extends StatelessWidget {
  final ChatMessage message;
  const _ToolMessage({required this.message});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: const Color(0xFF0D1117),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Row(
          children: [
            const Icon(Icons.build_outlined,
                size: 14, color: Color(0xFFF59E0B)),
            const SizedBox(width: 6),
            Text(message.toolName ?? 'tool',
                style: const TextStyle(
                    color: Color(0xFFF59E0B),
                    fontSize: 11,
                    fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message.content,
                style: const TextStyle(
                    color: Color(0xFF8B949E), fontSize: 11),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Texto com markdown simples ───────────────────────────
class _MarkdownText extends StatelessWidget {
  final String content;
  const _MarkdownText({required this.content});

  @override
  Widget build(BuildContext context) {
    // Dividir por blocos de código
    final parts = _parseContent(content);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: parts,
    );
  }

  List<Widget> _parseContent(String text) {
    final result = <Widget>[];
    final lines = text.split('\n');
    final buffer = StringBuffer();
    bool inCodeBlock = false;
    String codeLang = '';
    StringBuffer codeBuffer = StringBuffer();

    for (final line in lines) {
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          // Flush text buffer
          if (buffer.isNotEmpty) {
            result.add(_textWidget(buffer.toString().trim()));
            buffer.clear();
          }
          inCodeBlock = true;
          codeLang = line.substring(3).trim();
          codeBuffer.clear();
        } else {
          // End code block
          result.add(_codeWidget(codeBuffer.toString(), codeLang));
          inCodeBlock = false;
          codeBuffer.clear();
        }
      } else if (inCodeBlock) {
        codeBuffer.writeln(line);
      } else {
        buffer.writeln(line);
      }
    }

    if (buffer.isNotEmpty) {
      result.add(_textWidget(buffer.toString().trim()));
    }

    return result.isEmpty ? [_textWidget(text)] : result;
  }

  Widget _textWidget(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: _StyledText(text: text),
    );
  }

  Widget _codeWidget(String code, String lang) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        width: double.infinity,
        decoration: BoxDecoration(
          color: const Color(0xFF0D1117),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: const Color(0xFF30363D)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header do code block
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: const BoxDecoration(
                color: Color(0xFF161B22),
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(6),
                  topRight: Radius.circular(6),
                ),
                border: Border(bottom: BorderSide(color: Color(0xFF30363D))),
              ),
              child: Row(
                children: [
                  Text(
                    lang.isEmpty ? 'code' : lang,
                    style: const TextStyle(
                        color: Color(0xFF8B949E),
                        fontSize: 11,
                        fontWeight: FontWeight.w500),
                  ),
                  const Spacer(),
                  const Icon(Icons.copy_all_outlined,
                      size: 13, color: Color(0xFF484F58)),
                ],
              ),
            ),
            // Código
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.all(12),
              child: Text(
                code.trim(),
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
    );
  }
}

// Texto simples com bold/italic básico
class _StyledText extends StatelessWidget {
  final String text;
  const _StyledText({required this.text});

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        color: Color(0xFFE6EDF3),
        fontSize: 14,
        height: 1.6,
      ),
    );
  }
}

String _formatTime(DateTime dt) {
  return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
