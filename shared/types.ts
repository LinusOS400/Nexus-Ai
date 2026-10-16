export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';
export type ThemeMode = 'system' | 'dark' | 'light';
export type GpuBackend = 'cpu' | 'vulkan' | 'cuda' | 'auto';
export type NavigationTab = 'chat' | 'workspace' | 'models' | 'settings';
export type ToolApprovalChoice = 'deny' | 'once' | 'session' | 'always';
export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';
export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  outputLength?: number;
  providerId: string;
  description?: string;
  family?: string;
  downloads?: number;
  updatedAt?: string;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  isFree?: boolean;
  supportsTools?: boolean;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  docsUrl?: string;
  modelCount: number;
  freeModelCount: number;
  freeTierHint?: string;
  models: ModelInfo[];
}

export interface ProviderCatalogResult {
  entries: ProviderCatalogEntry[];
  fetchedAt?: string;
  source: 'live' | 'cache' | 'builtin';
  warning?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  hasKey: boolean;
  status: 'unknown' | 'active' | 'inactive';
  lastChecked?: string;
  lastError?: string;
  models: ModelInfo[];
  isPreset?: boolean;
  source?: 'builtin' | 'catalog' | 'custom';
  docsUrl?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  enabled: boolean;
  environmentKeys: string[];
  headerKeys: string[];
  disabledTools: string[];
}

export interface McpToolInfo {
  key: string;
  approvalKey: string;
  name: string;
  kind: 'tool' | 'prompt' | 'resource';
  description?: string;
  enabled: boolean;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgumentInfo {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments: McpPromptArgumentInfo[];
}

export interface McpServerInfo extends McpServerConfig {
  status: McpConnectionStatus;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  serverVersion?: string;
  lastError?: string;
}

export interface McpServerSaveInput {
  id: string;
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled?: boolean;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  clearSecrets?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LocalRuntimeSettings {
  executablePath: string;
  modelPath: string;
  host: string;
  port: number;
  contextTokens: number;
  gpuBackend: GpuBackend;
  gpuLayers: number;
  deviceName: string;
}

export interface AppSettings {
  theme: ThemeMode;
  activeTab: NavigationTab;
  activeProviderId: string;
  activeModelId: string;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  enableTools: boolean;
  confirmToolCalls: boolean;
  allowShellWithoutProject: boolean;
  alwaysAllowTools: string[];
  autoFetchModels: boolean;
  autoDiscoverProviders: boolean;
  zoomPercent: number;
  providerCatalogUrl: string;
  systemPrompt: string;
  activeProjectPath: string;
  hfTokenSet: boolean;
  localRuntime: LocalRuntimeSettings;
}

export interface RuntimeStatus {
  running: boolean;
  message: string;
  baseUrl: string;
  pid?: number;
}

export interface AppState {
  settings: AppSettings;
  providers: ProviderInfo[];
  runtime: RuntimeStatus;
  mcpServers: McpServerInfo[];
  sessionAllowedTools: string[];
  desktop: boolean;
}

export interface ProjectEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
}

export interface HuggingFaceModel {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
  files?: HuggingFaceFile[];
}

export interface HuggingFaceFile {
  name: string;
  size?: number;
  lfsSize?: number;
  downloaded?: boolean;
  localPath?: string;
}

export interface ToolRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  description: string;
  label?: string;
  requiresApproval: boolean;
}

export interface ToolTrace {
  id: string;
  name: string;
  label?: string;
  arguments: Record<string, unknown>;
  state: 'running' | 'complete' | 'error' | 'denied';
  result?: string;
}

export interface UserQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserQuestionRequest {
  id: string;
  question: string;
  options: UserQuestionOption[];
}

export type ChatEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'reasoning'; text: string }
  | { requestId: string; type: 'status'; text: string }
  | { requestId: string; type: 'tool'; tool: ToolRequest }
  | { requestId: string; type: 'tool-trace'; trace: ToolTrace }
  | { requestId: string; type: 'question'; question: UserQuestionRequest }
  | { requestId: string; type: 'approval-expired'; toolId: string }
  | { requestId: string; type: 'done'; cancelled?: boolean }
  | { requestId: string; type: 'error'; message: string };

export interface ChatMessageInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolTraces?: ToolTrace[];
  error?: boolean;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  modelId: string;
  messages: ChatMessageRecord[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  providerId: string;
  modelId: string;
  messageCount: number;
}

export interface ChatDeleteMessageResult {
  session: ChatSession | null;
  sessions: ChatSessionSummary[];
}

export interface ChatRequest {
  providerId: string;
  model: string;
  messages: ChatMessageInput[];
  systemPrompt: string;
  enableTools: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
}

export type UpdateStatus = {
  state: 'idle' | 'unavailable' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
};

export interface NexusBridge {
  getState(): Promise<AppState>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  saveSettings(settings: Partial<AppSettings>): Promise<AppState>;
  saveProvider(provider: Omit<ProviderInfo, 'hasKey' | 'status' | 'lastChecked' | 'lastError' | 'models'> & { apiKey?: string; clearKey?: boolean }): Promise<AppState>;
  removeProvider(providerId: string): Promise<AppState>;
  refreshModels(providerId: string): Promise<{ state: AppState; error?: string }>;
  refreshAllModels(): Promise<AppState>;
  getProviderCatalog(forceRefresh?: boolean): Promise<ProviderCatalogResult>;
  addCatalogProvider(providerId: string): Promise<AppState>;
  copyToClipboard(text: string): Promise<void>;
  getChatSessions(): Promise<ChatSessionSummary[]>;
  getChatSession(sessionId: string): Promise<ChatSession | null>;
  saveChatSession(session: ChatSession): Promise<ChatSessionSummary[]>;
  deleteChatSession(sessionId: string): Promise<ChatSessionSummary[]>;
  deleteChatMessage(sessionId: string, messageId: string): Promise<ChatDeleteMessageResult>;
  clearChatSessions(): Promise<ChatSessionSummary[]>;
  saveMcpServer(input: McpServerSaveInput): Promise<AppState>;
  removeMcpServer(serverId: string): Promise<AppState>;
  connectMcpServer(serverId: string): Promise<AppState>;
  disconnectMcpServer(serverId: string): Promise<AppState>;
  refreshMcpServer(serverId: string): Promise<AppState>;
  setMcpServerEnabled(serverId: string, enabled: boolean): Promise<AppState>;
  setMcpToolEnabled(serverId: string, toolName: string, enabled: boolean): Promise<AppState>;
  onMcpServers(callback: (servers: McpServerInfo[]) => void): () => void;
  clearSessionPermissions(): Promise<AppState>;
  setHuggingFaceToken(token: string): Promise<AppState>;
  searchHuggingFace(query: string): Promise<HuggingFaceModel[]>;
  getHuggingFaceFiles(repoId: string): Promise<HuggingFaceFile[]>;
  downloadHuggingFaceFile(repoId: string, filename: string): Promise<string>;
  openProject(): Promise<string | null>;
  listProjectFiles(): Promise<ProjectEntry[]>;
  readProjectFile(relativePath: string): Promise<string>;
  writeProjectFile(relativePath: string, content: string): Promise<void>;
  getProjectPreviewUrl(relativePath: string): Promise<string>;
  updateProjectPreview(relativePath: string, content: string): Promise<string>;
  runShellCommand(command: string): Promise<{ output: string; exitCode: number | null }>;
  setRuntimePath(): Promise<string | null>;
  setLocalModelPath(): Promise<string | null>;
  selectLocalModel(modelPath: string): Promise<AppState>;
  startLocalRuntime(): Promise<AppState>;
  stopLocalRuntime(): Promise<AppState>;
  startChat(request: ChatRequest, requestId?: string): Promise<string>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
  cancelChat(requestId: string): void;
  respondToTool(toolId: string, decision: ToolApprovalChoice): Promise<AppState>;
  answerQuestion(questionId: string, answer: string): Promise<void>;
  onDownloadProgress(callback: (data: { filename: string; received: number; total?: number; percent?: number }) => void): () => void;
  onRuntimeLog(callback: (line: string) => void): () => void;
  onRuntimeStatus(callback: (status: RuntimeStatus) => void): () => void;
  getLocalModels(): Promise<Array<{ name: string; path: string; size: number }>>;
  previewMode: boolean;
}

declare global {
  interface Window {
    nexus?: NexusBridge;
  }
}
