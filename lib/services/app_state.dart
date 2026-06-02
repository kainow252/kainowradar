import 'package:flutter/foundation.dart';
import '../models/app_models.dart';

class AppState extends ChangeNotifier {
  // --- Navegação ---
  int _selectedNavIndex = 0;
  PanelTab _activePanelTab = PanelTab.planner;
  bool _rightPanelVisible = true;

  int get selectedNavIndex => _selectedNavIndex;
  PanelTab get activePanelTab => _activePanelTab;
  bool get rightPanelVisible => _rightPanelVisible;

  // --- Chat / Orquestrador ---
  final List<ChatMessage> _messages = [];
  bool _isAgentRunning = false;
  String _currentTask = '';

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get isAgentRunning => _isAgentRunning;
  String get currentTask => _currentTask;

  // --- Planejador ---
  final List<PlanTask> _planTasks = [];
  List<PlanTask> get planTasks => List.unmodifiable(_planTasks);

  // --- Código ---
  final List<CodeSnippet> _codeFiles = [];
  int _activeCodeFileIndex = 0;
  List<CodeSnippet> get codeFiles => List.unmodifiable(_codeFiles);
  int get activeCodeFileIndex => _activeCodeFileIndex;
  CodeSnippet? get activeCodeFile =>
      _codeFiles.isEmpty ? null : _codeFiles[_activeCodeFileIndex];

  // --- Terminal output ---
  final List<String> _terminalLines = [];
  List<String> get terminalLines => List.unmodifiable(_terminalLines);

  // --- Projeto atual ---
  String _projectName = '';
  String _projectBranch = '';
  bool get hasProject => _projectName.isNotEmpty;
  String get projectName => _projectName;
  String get projectBranch => _projectBranch;

  // --- Agentes ---
  late final List<AgentModel> agents = _buildAgents();

  List<AgentModel> _buildAgents() => [
        AgentModel(
          id: 'dev',
          name: 'AI Developer',
          description: 'Cria sites, apps Flutter, APIs e sistemas completos',
          emoji: '🧑‍💻',
          color: const AgentColor(0xFF0D1B2A, 0xFF00B4D8),
          capabilities: [
            'Flutter/Dart', 'React/Next.js', 'Node.js',
            'Python FastAPI', 'REST APIs', 'Banco de Dados'
          ],
          specialty: 'Full-Stack Development',
        ),
        AgentModel(
          id: 'mobile',
          name: 'Mobile Dev',
          description: 'Apps iOS e Android com Flutter nativo',
          emoji: '📱',
          color: const AgentColor(0xFF0F2027, 0xFF00E676),
          capabilities: [
            'Flutter Android', 'Flutter iOS', 'Firebase',
            'Push Notifications', 'App Store Deploy', 'Play Store'
          ],
          specialty: 'Mobile Development',
        ),
        AgentModel(
          id: 'backend',
          name: 'Backend Dev',
          description: 'APIs, microserviços e integrações brasileiras',
          emoji: '⚙️',
          color: const AgentColor(0xFF1A0533, 0xFF7C3AED),
          capabilities: [
            'FastAPI', 'Node.js', 'PostgreSQL', 'Redis',
            'Pix/Open Finance', 'NF-e/NFS-e', 'WhatsApp API'
          ],
          specialty: 'Backend & APIs BR',
        ),
        AgentModel(
          id: 'ai_eng',
          name: 'AI Engineer',
          description: 'Integra LLMs, RAG, agentes e pipelines de IA',
          emoji: '🤖',
          color: const AgentColor(0xFF0A1628, 0xFFFF6B35),
          capabilities: [
            'LangChain/LangGraph', 'CrewAI', 'RAG/Vector DB',
            'OpenAI API', 'Anthropic Claude', 'Maritaca Sabiá-3'
          ],
          specialty: 'IA & LLMs',
        ),
        AgentModel(
          id: 'devops',
          name: 'DevOps',
          description: 'Deploy, CI/CD, Docker, cloud e infra',
          emoji: '🚀',
          color: const AgentColor(0xFF0D2137, 0xFFF59E0B),
          capabilities: [
            'Docker/K8s', 'GitHub Actions', 'Vercel/Netlify',
            'AWS/GCP', 'Nginx', 'SSL/Domínios'
          ],
          specialty: 'Deploy & Infra',
        ),
        AgentModel(
          id: 'qa',
          name: 'QA & Testes',
          description: 'Testes unitários, E2E e cobertura de código',
          emoji: '🧪',
          color: const AgentColor(0xFF0F2010, 0xFF4ADE80),
          capabilities: [
            'Flutter Test', 'Jest/Vitest', 'Cypress',
            'Pytest', 'CI Testing', 'Code Review'
          ],
          specialty: 'Quality Assurance',
        ),
        AgentModel(
          id: 'design',
          name: 'UI/UX Designer',
          description: 'Design de interfaces, sistemas visuais e prototipagem',
          emoji: '🎨',
          color: const AgentColor(0xFF1A0A20, 0xFFEC4899),
          capabilities: [
            'Material Design 3', 'Figma → Flutter', 'Responsivo',
            'Acessibilidade', 'Design System', 'Dark/Light Mode'
          ],
          specialty: 'Design & UI',
        ),
      ];

  // --- AÇÕES ---
  void setNavIndex(int idx) {
    _selectedNavIndex = idx;
    notifyListeners();
  }

  void setPanelTab(PanelTab tab) {
    _activePanelTab = tab;
    notifyListeners();
  }

  void toggleRightPanel() {
    _rightPanelVisible = !_rightPanelVisible;
    notifyListeners();
  }

  void sendMessage(String content) {
    _messages.add(ChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      role: MessageRole.user,
      content: content,
      timestamp: DateTime.now(),
    ));
    _isAgentRunning = true;
    _currentTask = content;
    notifyListeners();
    _simulateAgentResponse(content);
  }

  Future<void> _simulateAgentResponse(String prompt) async {
    await Future.delayed(const Duration(milliseconds: 800));

    // Mensagem do sistema
    _messages.add(ChatMessage(
      id: '${DateTime.now().millisecondsSinceEpoch}_sys',
      role: MessageRole.system,
      content: '🤖 AI Developer iniciando análise...',
      timestamp: DateTime.now(),
      agentName: 'AI Developer',
    ));
    notifyListeners();

    await Future.delayed(const Duration(milliseconds: 600));

    // Gerar plano
    _planTasks.clear();
    _planTasks.addAll(_generatePlan(prompt));
    _activePanelTab = PanelTab.planner;
    notifyListeners();

    await Future.delayed(const Duration(milliseconds: 500));

    // Resposta do agente
    final response = _generateResponse(prompt);
    _messages.add(ChatMessage(
      id: '${DateTime.now().millisecondsSinceEpoch}_agent',
      role: MessageRole.agent,
      content: response,
      timestamp: DateTime.now(),
      agentName: 'AI Developer',
    ));

    // Adicionar código de exemplo
    _codeFiles.clear();
    _codeFiles.addAll(_generateCodeFiles(prompt));

    _isAgentRunning = false;
    _addTerminalLine('✅ Análise concluída. ${_planTasks.length} tarefas planejadas.');
    notifyListeners();
  }

  List<PlanTask> _generatePlan(String prompt) {
    final lowerPrompt = prompt.toLowerCase();
    if (lowerPrompt.contains('app') || lowerPrompt.contains('flutter') || lowerPrompt.contains('mobile')) {
      return [
        PlanTask(id: '1', title: 'Configurar projeto Flutter', description: 'Criar estrutura base com pubspec.yaml e dependências', order: 1, assignedAgent: 'Mobile Dev', status: TaskStatus.done),
        PlanTask(id: '2', title: 'Criar modelos de dados', description: 'Definir entidades e DTOs do domínio', order: 2, assignedAgent: 'AI Developer', status: TaskStatus.inProgress),
        PlanTask(id: '3', title: 'Implementar UI/UX', description: 'Construir telas com Material Design 3', order: 3, assignedAgent: 'UI/UX Designer'),
        PlanTask(id: '4', title: 'Integrar APIs', description: 'Conectar com backend e serviços externos', order: 4, assignedAgent: 'Backend Dev'),
        PlanTask(id: '5', title: 'Testes e QA', description: 'Cobertura de testes unitários e de integração', order: 5, assignedAgent: 'QA & Testes'),
        PlanTask(id: '6', title: 'Deploy e publicação', description: 'Publicar na Play Store e App Store', order: 6, assignedAgent: 'DevOps'),
      ];
    } else if (lowerPrompt.contains('site') || lowerPrompt.contains('web') || lowerPrompt.contains('next')) {
      return [
        PlanTask(id: '1', title: 'Estrutura Next.js', description: 'App Router, layouts e páginas base', order: 1, assignedAgent: 'AI Developer', status: TaskStatus.done),
        PlanTask(id: '2', title: 'Componentes UI', description: 'Header, Footer, Hero section, Cards', order: 2, assignedAgent: 'UI/UX Designer', status: TaskStatus.inProgress),
        PlanTask(id: '3', title: 'Integração de dados', description: 'API Routes e banco de dados', order: 3, assignedAgent: 'Backend Dev'),
        PlanTask(id: '4', title: 'SEO e Performance', description: 'Metadata, OG tags, Core Web Vitals', order: 4, assignedAgent: 'AI Developer'),
        PlanTask(id: '5', title: 'Deploy Vercel', description: 'CI/CD automático com preview branches', order: 5, assignedAgent: 'DevOps'),
      ];
    } else if (lowerPrompt.contains('api') || lowerPrompt.contains('backend')) {
      return [
        PlanTask(id: '1', title: 'Estrutura FastAPI', description: 'Routers, modelos Pydantic, middlewares', order: 1, assignedAgent: 'Backend Dev', status: TaskStatus.done),
        PlanTask(id: '2', title: 'Banco de dados', description: 'PostgreSQL + SQLAlchemy ORM', order: 2, assignedAgent: 'Backend Dev', status: TaskStatus.inProgress),
        PlanTask(id: '3', title: 'Autenticação JWT', description: 'Auth com OAuth2 e refresh tokens', order: 3, assignedAgent: 'Backend Dev'),
        PlanTask(id: '4', title: 'Integração Pix', description: 'API Pix via Gerencianet/Asaas', order: 4, assignedAgent: 'Backend Dev'),
        PlanTask(id: '5', title: 'Documentação Swagger', description: 'OpenAPI docs automáticas', order: 5, assignedAgent: 'AI Developer'),
        PlanTask(id: '6', title: 'Docker + Deploy', description: 'Containerizar e subir na cloud', order: 6, assignedAgent: 'DevOps'),
      ];
    }
    return [
      PlanTask(id: '1', title: 'Análise de requisitos', description: 'Entender escopo e tecnologias necessárias', order: 1, assignedAgent: 'AI Developer', status: TaskStatus.done),
      PlanTask(id: '2', title: 'Arquitetura do sistema', description: 'Definir stack, camadas e padrões', order: 2, assignedAgent: 'AI Developer', status: TaskStatus.inProgress),
      PlanTask(id: '3', title: 'Implementação core', description: 'Desenvolver funcionalidades principais', order: 3, assignedAgent: 'AI Developer'),
      PlanTask(id: '4', title: 'Testes e validação', description: 'Garantir qualidade e cobertura', order: 4, assignedAgent: 'QA & Testes'),
      PlanTask(id: '5', title: 'Deploy e entrega', description: 'Publicar e monitorar em produção', order: 5, assignedAgent: 'DevOps'),
    ];
  }

  String _generateResponse(String prompt) {
    final lowerPrompt = prompt.toLowerCase();
    if (lowerPrompt.contains('flutter') || lowerPrompt.contains('app') || lowerPrompt.contains('mobile')) {
      return '''Entendido! Vou criar o projeto Flutter completo para você.

**Stack selecionada:**
• Flutter 3.35.4 + Dart 3.9
• Provider para gerenciamento de estado
• Material Design 3 com tema dark/light
• Firebase para backend (Auth + Firestore)

**Estrutura do projeto:**
```
lib/
├── main.dart
├── models/
├── screens/
├── widgets/
├── services/
└── utils/
```

Iniciando a geração dos arquivos... Acompanhe o **Planejador** ao lado para ver o progresso em tempo real.''';
    } else if (lowerPrompt.contains('pix') || lowerPrompt.contains('api') || lowerPrompt.contains('backend')) {
      return '''Perfeito! Criando a API com integração nativa a APIs brasileiras.

**Stack selecionada:**
• Python 3.12 + FastAPI
• PostgreSQL + SQLAlchemy
• Integração Pix via Gerencianet/Asaas
• JWT Auth + CORS configurado para BR

**Endpoints principais:**
• `POST /pix/cob` — Gerar cobrança Pix
• `POST /pix/webhook` — Receber confirmações
• `GET /cnpj/{cnpj}` — Consultar empresa
• `POST /nfe/emitir` — Emitir NF-e

Código sendo gerado no painel **Código** →''';
    }
    return '''Analisando sua solicitação e montando o plano de desenvolvimento...

**Tecnologias identificadas:**
• Selecionei os agentes mais adequados para este projeto
• Plano de ${_planTasks.length} tarefas criado no Planejador

**Próximos passos:**
1. Revise o plano no painel **Planejador** →
2. Confirme ou ajuste as tarefas
3. Digite **"executar"** para iniciar o desenvolvimento

Precisa de algum ajuste na abordagem?''';
  }

  List<CodeSnippet> _generateCodeFiles(String prompt) {
    final lower = prompt.toLowerCase();
    if (lower.contains('flutter') || lower.contains('app') || lower.contains('mobile')) {
      return [
        CodeSnippet(
          filename: 'main.dart',
          language: 'dart',
          content: '''import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'App',
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        colorScheme: ColorScheme.dark(
          primary: const Color(0xFF00B4D8),
        ),
      ),
      home: const HomeScreen(),
    );
  }
}''',
        ),
        CodeSnippet(
          filename: 'pubspec.yaml',
          language: 'yaml',
          content: '''name: my_app
description: "Generated by NexusIA"
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  provider: 6.1.5+1
  shared_preferences: 2.5.3
  http: 1.5.0
  firebase_core: 3.6.0''',
        ),
      ];
    } else if (lower.contains('api') || lower.contains('backend') || lower.contains('pix')) {
      return [
        CodeSnippet(
          filename: 'main.py',
          language: 'python',
          content: '''from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="API BR", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"status": "ok", "version": "1.0.0"}

@app.post("/pix/cob")
async def criar_cobranca(valor: float, descricao: str):
    # Integração Gerencianet/Asaas
    return {"txid": "abc123", "valor": valor, "status": "ATIVA"}''',
        ),
        CodeSnippet(
          filename: 'requirements.txt',
          language: 'text',
          content: '''fastapi==0.115.0
uvicorn==0.30.6
sqlalchemy==2.0.35
pydantic==2.9.2
python-jose==3.3.0
passlib==1.7.4
httpx==0.27.2''',
        ),
      ];
    }
    return [
      CodeSnippet(
        filename: 'README.md',
        language: 'markdown',
        content: '''# Projeto Gerado por NexusIA

## Sobre
Este projeto foi gerado automaticamente pelo NexusIA Dev Platform.

## Como rodar
\`\`\`bash
# Instalar dependências
npm install

# Desenvolvimento
npm run dev

# Build
npm run build
\`\`\`

## Tecnologias
- Next.js 15
- TypeScript
- Tailwind CSS
- Prisma ORM
''',
      ),
    ];
  }

  void _addTerminalLine(String line) {
    _terminalLines.add('[${DateTime.now().toString().substring(11, 19)}] $line');
    if (_terminalLines.length > 200) _terminalLines.removeAt(0);
  }

  void addTerminalLine(String line) {
    _addTerminalLine(line);
    notifyListeners();
  }

  void setProject(String name, String branch) {
    _projectName = name;
    _projectBranch = branch;
    notifyListeners();
  }

  void setCodeFileIndex(int idx) {
    _activeCodeFileIndex = idx;
    notifyListeners();
  }

  void clearMessages() {
    _messages.clear();
    _planTasks.clear();
    _codeFiles.clear();
    _terminalLines.clear();
    _isAgentRunning = false;
    _currentTask = '';
    notifyListeners();
  }
}
