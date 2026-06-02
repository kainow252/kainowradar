// ============================================================
// MODELOS DE DADOS — NexusIA Dev Platform
// ============================================================

enum AgentStatus { idle, running, paused, done, error }
enum MessageRole { user, agent, system, tool }
enum TaskStatus { pending, inProgress, done, failed }
enum PanelTab { planner, code, browser, terminal, preview }

// --- AGENTE ---
class AgentModel {
  final String id;
  final String name;
  final String description;
  final String emoji;
  final AgentColor color;
  AgentStatus status;
  final List<String> capabilities;
  final String specialty; // ex: "Flutter", "Python", "APIs BR"

  AgentModel({
    required this.id,
    required this.name,
    required this.description,
    required this.emoji,
    required this.color,
    this.status = AgentStatus.idle,
    required this.capabilities,
    required this.specialty,
  });
}

class AgentColor {
  final int bg;
  final int accent;
  const AgentColor(this.bg, this.accent);
}

// --- MENSAGEM DE CHAT ---
class ChatMessage {
  final String id;
  final MessageRole role;
  final String content;
  final DateTime timestamp;
  final String? agentName;
  final String? toolName;
  final bool isStreaming;

  ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.timestamp,
    this.agentName,
    this.toolName,
    this.isStreaming = false,
  });

  ChatMessage copyWith({String? content, bool? isStreaming}) {
    return ChatMessage(
      id: id,
      role: role,
      content: content ?? this.content,
      timestamp: timestamp,
      agentName: agentName,
      toolName: toolName,
      isStreaming: isStreaming ?? this.isStreaming,
    );
  }
}

// --- TAREFA DO PLANEJADOR ---
class PlanTask {
  final String id;
  final String title;
  final String description;
  TaskStatus status;
  final int order;
  final String? assignedAgent;

  PlanTask({
    required this.id,
    required this.title,
    required this.description,
    this.status = TaskStatus.pending,
    required this.order,
    this.assignedAgent,
  });
}

// --- PROJETO ---
class ProjectModel {
  final String id;
  final String name;
  final String description;
  final String type; // web, mobile, api, fullstack
  final DateTime createdAt;
  final List<String> agentsUsed;

  ProjectModel({
    required this.id,
    required this.name,
    required this.description,
    required this.type,
    required this.createdAt,
    required this.agentsUsed,
  });
}

// --- SNIPPET DE CÓDIGO ---
class CodeSnippet {
  final String filename;
  final String language;
  final String content;
  final String? description;

  CodeSnippet({
    required this.filename,
    required this.language,
    required this.content,
    this.description,
  });
}
