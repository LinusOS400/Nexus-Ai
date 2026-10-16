import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BadgeCheck, BookOpen, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, Cloud, Code2, Command, Copy, Cpu, Download, ExternalLink,
  Eye, File, FileCode2, FilePlus2, FileText, Folder, FolderOpen, Gauge, HardDrive, KeyRound,
  LayoutGrid, LoaderCircle, LockKeyhole, MessageSquare, Minus, Moon, Monitor, MoreHorizontal, PanelLeft, Play,
  Plus, PlugZap, Puzzle, RefreshCw, Rocket, Search, Send, Server, Settings, Shield, SlidersHorizontal, Smartphone, Sparkles, Square,
  Sun, Tablet, Terminal, Trash2, Unplug, Upload, WandSparkles, Workflow, X, Zap,
} from 'lucide-react';
import { bridge } from './bridge';
import type { AppSettings, AppState, ChatMessageInput, ChatMessageRecord, ChatSession, ChatSessionSummary, HuggingFaceFile, HuggingFaceModel, McpServerInfo, McpServerSaveInput, ModelInfo, NavigationTab, ProjectEntry, ProviderCatalogEntry, ProviderCatalogResult, ProviderInfo, ProviderKind, ThemeMode, ToolApprovalChoice, ToolRequest, UpdateStatus, UserQuestionRequest } from '../shared/types';
import { DEFAULT_SYSTEM_PROMPT } from '../shared/defaults';
import { parseMarkdownParts, codeFileName } from './markdown';
import { highlightSource } from './syntax-highlight';

type Message = ChatMessageRecord;
type ProviderForm = { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey: string; clearKey?: boolean };
type SettingsSection = 'general' | 'providers' | 'tools' | 'local' | 'advanced' | 'updates';
type ModelSection = 'hosted' | 'local' | 'endpoints';
type ProviderView = 'connected' | 'discover';
type PreviewDevice = 'desktop' | 'laptop' | 'tablet' | 'mobile';

const sectionNames: Record<NavigationTab, string> = { chat: 'New conversation', workspace: 'Workspace', models: 'Model library', settings: 'Settings' };

const formatBytes = (bytes?: number) => {
  if (!bytes || !Number.isFinite(bytes)) return 'Size unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
};
const compactNumber = (number: number) => number >= 1_000_000 ? `${(number / 1_000_000).toFixed(1)}m` : number >= 1000 ? `${(number / 1000).toFixed(1)}k` : String(number || 0);
const trimConversation = (messages: ChatMessageInput[], contextTokens: number, outputTokens: number) => {
  const budget = Math.max(512, contextTokens - outputTokens - 512);
  const kept: ChatMessageInput[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const estimate = Math.ceil(message.content.length / 4) + 8;
    if (kept.length && used + estimate > budget) break;
    kept.unshift(message);
    used += estimate;
  }
  return kept;
};
const providerInitial = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const dateLabel = (date?: string) => date ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date)) : 'Never synced';
const parseKeyValueLines = (source: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    const colon = line.indexOf(':');
    const split = equals >= 0 ? equals : colon;
    if (split <= 0) continue;
    const key = line.slice(0, split).trim();
    if (key) result[key] = line.slice(split + 1).trim();
  }
  return result;
};

function approvalToolLabel(key: string, servers: McpServerInfo[]) {
  if (key.startsWith('mcp:')) {
    const rest = key.slice(4);
    const separator = rest.indexOf(':');
    const serverId = separator < 0 ? rest : rest.slice(0, separator);
    const capabilityKey = separator < 0 ? '' : rest.slice(separator + 1);
    const server = servers.find((item) => item.id === serverId);
    const capability = server?.tools.find((item) => item.approvalKey === key || item.key === capabilityKey);
    const name = capability?.name || capabilityKey.replace(/^(tool|prompt|resource):/, '').slice(0, 140);
    return server ? `${server.name} · ${name}` : `MCP capability · ${name}`;
  }
  const builtins: Record<string, string> = { default_read: 'Read files', default_write: 'Write files', default_edit: 'Edit files', default_glob: 'Find project paths', default_grep: 'Search project files', default_shell: 'Run shell commands', default_webfetch: 'Fetch a webpage', default_websearch: 'Search the web', default_question: 'Ask you a question', default_skill: 'Load a skill', default_subagent: 'Start a subagent', default_execute: 'Run Code Mode', list_files: 'List project files', read_file: 'Read project files', search_files: 'Search project files', write_file: 'Write project files', run_shell: 'Run shell commands' };
  return builtins[key] || key;
}

function CodeBlock({ code, language, filename }: { code: string; language: string; filename?: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const name = codeFileName(language, filename);
  const displayLanguage = language || 'code';

  const copyCode = async () => {
    try {
      await bridge.copyToClipboard(code);
      setCopyState('copied');
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Clipboard write failed.');
        setCopyState('copied');
      } catch {
        setCopyState('failed');
      }
    }
    window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const downloadCode = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="code-block">
    <div className="code-toolbar">
      <div className="code-ident"><span className="code-language">{displayLanguage}</span><span className="code-filename">{name}</span></div>
      <div className="code-actions">
        <button className={`code-action ${copyState === 'copied' ? 'success' : ''} ${copyState === 'failed' ? 'error' : ''}`} onClick={() => void copyCode()} title="Copy code" aria-label="Copy code">
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
        <button className="code-action" onClick={downloadCode} title={`Download ${name}`} aria-label={`Download ${name}`}><Download size={13} />Download</button>
      </div>
    </div>
    <pre className="code-pre"><code className={language ? `language-${language}` : undefined} dangerouslySetInnerHTML={{ __html: highlightSource(code, language) }} /></pre>
  </div>;
}

function Markup({ text }: { text: string }) {
  const sections = parseMarkdownParts(text);
  if (sections.length === 1 && sections[0].type === 'text') return <InlineMarkup text={sections[0].text} />;
  return <>{sections.map((section, index) => section.type === 'code'
    ? <CodeBlock key={`code-${index}`} code={section.code} language={section.language} filename={section.filename} />
    : <InlineMarkup key={`text-${index}`} text={section.text} />)}</>;
}

function InlineMarkup({ text }: { text: string }) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return <span className="rich-text">{tokens.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code className="inline-code" key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    return <span key={index}>{part}</span>;
  })}</span>;
}

function StatusDot({ status }: { status: ProviderInfo['status'] }) {
  return <span className={`status-dot ${status}`} aria-label={status} />;
}

function ProviderTile({ provider, onEdit, onRefresh, onRemove, refreshing }: {
  provider: ProviderInfo; onEdit: () => void; onRefresh: () => void; onRemove?: () => void; refreshing?: boolean;
}) {
  return <article className="provider-tile">
    <div className={`provider-mark provider-mark-${provider.id}`}>{providerInitial(provider.name)}</div>
    <div className="provider-info">
      <div className="provider-title-row"><h3>{provider.name}</h3><span className={`mini-status ${provider.status}`}><StatusDot status={provider.status} />{provider.status === 'active' ? 'Connected' : provider.status === 'inactive' ? 'Unavailable' : provider.hasKey ? 'Key saved' : provider.id === 'llamacpp' ? 'Local' : 'Not configured'}</span></div>
      <p className="provider-url" title={provider.baseUrl}>{provider.baseUrl}</p>
      <div className="provider-meta"><span>{provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}</span>{provider.models.some((model) => model.isFree) && <><span className="meta-separator">·</span><span>{provider.models.filter((model) => model.isFree).length} free-listed</span></>}<span className="meta-separator">·</span><span>Checked {dateLabel(provider.lastChecked)}</span></div>
      {provider.lastError && <div className="provider-error"><CircleHelp size={13} /> {provider.lastError}</div>}
    </div>
    <div className="provider-actions">
      <button className="icon-button" title="Sync models" aria-label={`Sync ${provider.name}`} onClick={onRefresh} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
      <button className="secondary-button compact" onClick={onEdit}>{provider.hasKey ? 'Manage' : 'Connect'}</button>
      {onRemove && <button className="icon-button danger-hover" title="Remove custom provider" aria-label="Remove provider" onClick={onRemove}><Trash2 size={15} /></button>}
    </div>
  </article>;
}

function ProviderEditor({ initial, onClose, onSave }: { initial?: ProviderInfo; onClose: () => void; onSave: (form: ProviderForm) => void }) {
  const [form, setForm] = useState<ProviderForm>(initial ? { id: initial.id, name: initial.name, kind: initial.kind, baseUrl: initial.baseUrl, apiKey: '' } : { id: `custom-${Math.random().toString(36).slice(2, 7)}`, name: '', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: '' });
  const [showKey, setShowKey] = useState(false);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal provider-modal" onSubmit={(event) => { event.preventDefault(); onSave(form); }}>
      <div className="modal-header"><div><div className="eyebrow">MODEL CONNECTION</div><h2>{initial ? 'Configure provider' : 'Add an endpoint'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <p className="modal-copy">Connect a hosted API or any OpenAI-compatible endpoint. Keys are encrypted by the desktop operating system and never exposed to the model UI.</p>
      <label className="field-label">Provider name<input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My inference endpoint" required /></label>
      <div className="form-row two-col">
        <label className="field-label">Protocol<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label>
        <label className="field-label">Provider ID<input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} disabled={Boolean(initial)} required /></label>
      </div>
      <label className="field-label">Base URL<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" spellCheck={false} required /><small>Use the API base path, for example <code>https://api.openai.com/v1</code>. HTTPS is required for public hosts; HTTP is accepted on loopback/private LAN addresses.</small></label>
      <label className="field-label">API key {initial?.hasKey && <span className="field-inline-note">Key saved · leave blank to keep it</span>}<span className="secret-input"><input type={showKey ? 'text' : 'password'} autoComplete="new-password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.kind === 'openai-compatible' && form.id === 'llamacpp' ? 'Not required for local endpoint' : 'Paste provider key'} /><button type="button" className="secret-toggle" onClick={() => setShowKey(!showKey)} aria-label={showKey ? 'Hide key' : 'Show key'}><Eye size={16} /></button></span></label>
      {initial?.hasKey && <label className="clear-key-option"><input type="checkbox" checked={Boolean(form.clearKey)} onChange={(event) => setForm({ ...form, clearKey: event.target.checked })} /> Remove the saved key</label>}
      <div className="security-note"><LockKeyhole size={15} /><span>Saved with OS-backed encryption in the installed desktop app. This browser preview does not persist secrets.</span></div>
      <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><KeyRound size={15} /> Save connection</button></div>
    </form>
  </div>;
}

function McpEditor({ initial, preset, onClose, onSave }: { initial?: McpServerInfo; preset?: McpServerSaveInput | null; onClose: () => void; onSave: (input: McpServerSaveInput) => void }) {
  const seed = initial || preset || { id: `mcp-${Math.random().toString(36).slice(2, 7)}`, name: '', transport: 'stdio' as const, command: '', args: [], enabled: false };
  const [form, setForm] = useState({
    id: seed.id,
    name: seed.name,
    transport: seed.transport,
    command: seed.command || '',
    args: (seed.args || []).join('\n'),
    cwd: seed.cwd || '',
    url: seed.url || '',
    environment: '',
    headers: '',
  });
  const [clearSecrets, setClearSecrets] = useState(false);
  const editing = Boolean(initial);
  const hasSavedSecrets = Boolean(initial?.environmentKeys.length || initial?.headerKeys.length);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal mcp-modal" onSubmit={(event) => {
      event.preventDefault();
      onSave({
        id: form.id, name: form.name.trim(), transport: form.transport,
        command: form.transport === 'stdio' ? form.command.trim() : undefined,
        args: form.transport === 'stdio' ? form.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean) : [],
        cwd: form.transport === 'stdio' ? form.cwd.trim() || undefined : undefined,
        url: form.transport === 'stdio' ? undefined : form.url.trim(),
        enabled: initial?.enabled ?? preset?.enabled ?? false,
        environment: parseKeyValueLines(form.environment),
        headers: parseKeyValueLines(form.headers),
        clearSecrets,
      });
    }}>
      <div className="modal-header"><div><div className="eyebrow">MODEL CONTEXT PROTOCOL</div><h2>{editing ? 'Configure MCP server' : 'Add MCP server'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <p className="modal-copy">Connect local stdio tools or a remote MCP endpoint. Nexus discovers its tools, prompts, and resources and can offer them to the model after connection.</p>
      <div className="form-row two-col">
        <label className="field-label">Server name<input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Filesystem tools" required /></label>
        <label className="field-label">Server ID<input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} disabled={editing} required /></label>
      </div>
      <label className="field-label">Transport<select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as McpServerSaveInput['transport'] })}><option value="stdio">Local command · stdio</option><option value="streamable-http">Remote · Streamable HTTP</option><option value="sse">Remote · legacy SSE</option></select></label>
      {form.transport === 'stdio' ? <>
        <label className="field-label">Command<input value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="npx" required spellCheck={false} /><small>Executable is launched directly without a command shell.</small></label>
        <label className="field-label">Arguments<textarea value={form.args} onChange={(event) => setForm({ ...form, args: event.target.value })} placeholder={'-y\n@playwright/mcp@latest'} rows={3} spellCheck={false} /><small>One argument per line; do not add shell quotes.</small></label>
        <label className="field-label">Working directory <span className="field-inline-note">Optional · absolute path</span><input value={form.cwd} onChange={(event) => setForm({ ...form, cwd: event.target.value })} placeholder="Leave blank to inherit the app directory" spellCheck={false} /></label>
        <label className="field-label">Environment variables {initial?.environmentKeys.length ? <span className="field-inline-note">{initial.environmentKeys.length} saved · blank keeps existing</span> : null}<textarea value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })} placeholder={'API_KEY=…\nMODE=production'} rows={3} spellCheck={false} autoComplete="off" /></label>
      </> : <>
        <label className="field-label">MCP server URL<input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://mcp.example.com/mcp" required spellCheck={false} /><small>Public servers require HTTPS. HTTP is limited to loopback/private LAN. Put credentials in headers, not the URL.</small></label>
      </>}
      <label className="field-label">HTTP headers {initial?.headerKeys.length ? <span className="field-inline-note">{initial.headerKeys.length} saved · blank keeps existing</span> : null}<textarea value={form.headers} onChange={(event) => setForm({ ...form, headers: event.target.value })} placeholder={'Authorization: Bearer …\nX-Api-Key: …'} rows={2} spellCheck={false} autoComplete="off" /><small>Use one <code>Name: value</code> or <code>Name=value</code> per line. Header values are encrypted locally.</small></label>
      {hasSavedSecrets && <label className="clear-key-option"><input type="checkbox" checked={clearSecrets} onChange={(event) => setClearSecrets(event.target.checked)} /> Clear all saved environment values and headers</label>}
      <div className="security-note"><Shield size={15} /><span>Connecting a local stdio server runs its command with your Windows account permissions; it is not sandboxed. Saving only stores the config. Press Connect after reviewing the command and source.</span></div>
      <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><Server size={15} /> Save server</button></div>
    </form>
  </div>;
}

function Toggle({ checked, onChange, title, description }: { checked: boolean; onChange: (value: boolean) => void; title: string; description: string }) {
  return <button className={`toggle-row ${checked ? 'checked' : ''}`} onClick={() => onChange(!checked)} type="button" role="switch" aria-checked={checked}>
    <span className="toggle-copy"><strong>{title}</strong><small>{description}</small></span><span className="switch"><span /></span>
  </button>;
}

function UpdatePanel({ status, busy, onCheck, onDownload, onInstall }: { status: UpdateStatus; busy: boolean; onCheck: () => void; onDownload: () => void; onInstall: () => void }) {
  const working = busy || status.state === 'checking' || status.state === 'downloading';
  const title = status.state === 'available' ? `Version ${status.version} is ready` : status.state === 'downloaded' ? 'Update downloaded' : status.state === 'not-available' ? 'You’re up to date' : status.state === 'error' ? 'Couldn’t check for updates' : status.state === 'unavailable' ? 'Updates unavailable here' : status.state === 'checking' ? 'Checking for updates…' : status.state === 'downloading' ? 'Downloading update…' : 'Check for updates';
  const Icon = status.state === 'error' ? CircleHelp : status.state === 'downloaded' || status.state === 'not-available' ? CheckCircle2 : status.state === 'checking' || status.state === 'downloading' ? LoaderCircle : RefreshCw;
  return <div className="settings-panel">
    <div className="settings-panel-head"><div className="eyebrow">NEXUS SOFTWARE</div><h2>Stay up to date.</h2><p>Check the official public release feed, review what changed, then choose when to download and restart. Updates never install without your approval.</p></div>
    <div className={`settings-block update-card update-${status.state}`}>
      <div className="update-card-main"><div className="update-mark"><Icon size={20} className={working ? 'spin' : ''} /></div><div className="update-copy"><span className="config-label">CURRENT VERSION · {status.currentVersion || '—'}</span><h3>{title}</h3><p>{status.message || 'Nexus checks the official GitHub Releases feed when you ask it to.'}</p></div></div>
      {status.state === 'available' && status.releaseNotes && <div className="update-notes"><strong>Release notes</strong><p>{status.releaseNotes}</p></div>}
      {status.state === 'downloading' && <div className="update-progress"><div className="progress-track"><span style={{ width: `${status.percent ?? 0}%` }} /></div><small>{status.percent ?? 0}%{status.total ? ` · ${formatBytes(status.transferred || 0)} of ${formatBytes(status.total)}` : ''}{status.bytesPerSecond ? ` · ${formatBytes(status.bytesPerSecond)}/s` : ''}</small></div>}
      <div className="update-footer"><span><Shield size={13} /> Source: LinusOS400/Nexus-Ai · GitHub Releases</span>
        {status.state === 'available'
          ? <button className="primary-button" onClick={onDownload} disabled={working}><Download size={15} /> Download {status.version}</button>
          : status.state === 'downloaded'
            ? <button className="primary-button" onClick={onInstall} disabled={busy}><RefreshCw size={15} /> Install & restart</button>
            : <button className="secondary-button" onClick={onCheck} disabled={working || status.state === 'unavailable'}>{working ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{working ? (status.state === 'downloading' ? 'Downloading…' : 'Checking…') : 'Check for updates'}</button>}
      </div>
    </div>
    <div className="advanced-note update-security-note"><Shield size={16} /><div><strong>Updates are delivered over HTTPS.</strong><p>Use releases from the official Nexus-Ai repository only. The current Windows builds are unsigned, so Windows may still show its usual SmartScreen warning.</p></div></div>
  </div>;
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle', currentVersion: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [composer, setComposer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [chatStatus, setChatStatus] = useState('Ready when you are');
  const [toast, setToast] = useState('');
  const [providerEditor, setProviderEditor] = useState<ProviderInfo | null | undefined>(undefined);
  const [mcpEditor, setMcpEditor] = useState<McpServerInfo | null | undefined>(undefined);
  const [mcpPreset, setMcpPreset] = useState<McpServerSaveInput | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [providerView, setProviderView] = useState<ProviderView>('connected');
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [addingProviderId, setAddingProviderId] = useState('');
  const [providerCatalogUrlDraft, setProviderCatalogUrlDraft] = useState('https://models.dev/api.json');
  const [systemPromptDraft, setSystemPromptDraft] = useState(DEFAULT_SYSTEM_PROMPT);
  const [modelSection, setModelSection] = useState<ModelSection>('hosted');
  const [refreshingId, setRefreshingId] = useState('');
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewPath, setPreviewPath] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>('desktop');
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [showTerminal, setShowTerminal] = useState(true);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('Nexus Terminal · commands run in the current folder and require confirmation.\n');
  const [shellConfirm, setShellConfirm] = useState('');
  const [pendingTool, setPendingTool] = useState<ToolRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestionRequest | null>(null);
  const [questionDraft, setQuestionDraft] = useState('');
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  const [toolTraceExpanded, setToolTraceExpanded] = useState<Record<string, boolean>>({});
  const [hfQuery, setHfQuery] = useState('');
  const [hfModels, setHfModels] = useState<HuggingFaceModel[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [repoFiles, setRepoFiles] = useState<HuggingFaceFile[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [localModels, setLocalModels] = useState<Array<{ name: string; path: string; size: number }>>([]);
  const [downloadProgress, setDownloadProgress] = useState<{ filename: string; received: number; total?: number; percent?: number } | null>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);
  const [hfTokenInput, setHfTokenInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const activeRequestRef = useRef('');
  const assistantMessageRef = useRef('');
  const settingsSaveSequence = useRef(0);

  const selectedProvider = useMemo(() => {
    const providers = Array.isArray(state?.providers) ? state.providers : [];
    const provider = providers.find((item) => item?.id === state?.settings?.activeProviderId) || providers[0];
    return provider ? { ...provider, models: Array.isArray(provider.models) ? provider.models : [] } : undefined;
  }, [state]);
  const selectedModel = useMemo(() => {
    const models = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
    return models.find((model) => model?.id === state?.settings?.activeModelId) || models[0];
  }, [selectedProvider, state?.settings?.activeModelId]);
  const filteredCatalogEntries = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    return (providerCatalog?.entries || []).filter((entry) => (!freeOnly || entry.freeModelCount > 0 || Boolean(entry.freeTierHint)) && (!query || `${entry.name} ${entry.id} ${entry.baseUrl}`.toLowerCase().includes(query)));
  }, [providerCatalog, catalogQuery, freeOnly]);
  const previewFiles = useMemo(() => projectEntries.filter((entry) => entry.type === 'file' && ['.html', '.htm'].includes((entry.extension || '').toLowerCase())), [projectEntries]);
  const activeTab = state?.settings.activeTab || 'chat';

  useEffect(() => {
    let mounted = true;
    let startupSyncTimer: number | undefined;
    Promise.all([bridge.getState(), bridge.getChatSessions().catch(() => [] as ChatSessionSummary[])]).then(async ([next, sessions]) => {
      if (!mounted) return;
      const orderedSessions = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      setChatSessions(orderedSessions);
      const recent = orderedSessions[0];
      if (recent) {
        try {
          const saved = await bridge.getChatSession(recent.id);
          if (mounted && saved) { setActiveSessionId(saved.id); setChatMessages(saved.messages); }
        } catch { /* Keep the workbench available if a session file is damaged. */ }
      }
      if (!mounted) return;
      setState(next); setLoading(false);
      setProviderCatalogUrlDraft(next.settings.providerCatalogUrl);
      setSystemPromptDraft(next.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT);
      if (next.settings.autoDiscoverProviders) void loadProviderCatalog(false);
      if (next.settings.autoFetchModels && !bridge.previewMode) {
        startupSyncTimer = window.setTimeout(() => {
          void bridge.refreshAllModels().then((fresh) => setState((current) => current ? { ...current, providers: fresh.providers, runtime: fresh.runtime } : fresh)).catch(() => {});
        }, 700);
      }
    }).catch((error) => { setLoadError(error instanceof Error ? error.message : 'Could not load Nexus settings.'); setLoading(false); });
    const unsubscribeChat = bridge.onChatEvent((event) => {
      if (event.requestId !== activeRequestRef.current) return;
      if (event.type === 'delta') {
        setChatMessages((messages) => messages.map((message) => message.id === assistantMessageRef.current ? { ...message, content: message.content + event.text } : message));
        setChatStatus('Receiving response');
      } else if (event.type === 'reasoning') {
        setChatMessages((messages) => messages.map((message) => message.id === assistantMessageRef.current ? { ...message, reasoning: (message.reasoning || '') + event.text } : message));
      } else if (event.type === 'status') setChatStatus(event.text);
      else if (event.type === 'tool') setPendingTool(event.tool);
      else if (event.type === 'question') { setPendingQuestion(event.question); setQuestionDraft(''); }
      else if (event.type === 'tool-trace') {
        setChatMessages((messages) => messages.map((message) => {
          if (message.id !== assistantMessageRef.current) return message;
          const traces = message.toolTraces || [];
          const index = traces.findIndex((trace) => trace.id === event.trace.id);
          return { ...message, toolTraces: index >= 0 ? traces.map((trace, position) => position === index ? event.trace : trace) : [...traces, event.trace] };
        }));
      } else if (event.type === 'approval-expired') {
        setPendingTool((tool) => tool?.id === event.toolId ? null : tool);
        setChatStatus('Tool approval timed out');
      } else if (event.type === 'done') {
        setStreaming(false);
        setPendingTool(null);
        setPendingQuestion(null);
        setChatStatus(event.cancelled ? 'Stopped' : 'Response complete');
        activeRequestRef.current = '';
      } else if (event.type === 'error') {
        setChatMessages((messages) => messages.map((message) => message.id === assistantMessageRef.current ? { ...message, error: true, content: message.content ? `${message.content}\n\nConnection error: ${event.message}` : `Connection error: ${event.message}` } : message));
        setStreaming(false); setPendingTool(null); setPendingQuestion(null); setChatStatus('Connection error'); activeRequestRef.current = '';
      }
    });
    const unsubscribeDownload = bridge.onDownloadProgress((progress) => setDownloadProgress(progress));
    const unsubscribeRuntime = bridge.onRuntimeLog((line) => setRuntimeLogs((logs) => [...logs.slice(-199), line]));
    const unsubscribeRuntimeStatus = bridge.onRuntimeStatus((runtime) => setState((current) => current ? { ...current, runtime } : current));
    const unsubscribeMcp = bridge.onMcpServers((mcpServers) => setState((current) => current ? { ...current, mcpServers } : current));
    const unsubscribeUpdates = bridge.onUpdateStatus(setUpdateStatus);
    void bridge.getUpdateStatus().then(setUpdateStatus).catch(() => {});
    const hotkeys = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.altKey) {
        const zoomIn = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
        const zoomOut = event.key === '-' || event.code === 'NumpadSubtract';
        const resetZoom = event.key === '0' || event.code === 'Numpad0';
        if (zoomIn || zoomOut || resetZoom) {
          event.preventDefault();
          const currentZoom = Number.parseInt(document.documentElement.style.zoom, 10) || 100;
          const zoomPercent = resetZoom ? 100 : Math.max(75, Math.min(150, currentZoom + (zoomIn ? 10 : -10)));
          document.documentElement.style.zoom = `${zoomPercent}%`;
          void saveSettings({ zoomPercent });
          return;
        }
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener('keydown', hotkeys);
    return () => { mounted = false; if (startupSyncTimer) window.clearTimeout(startupSyncTimer); unsubscribeChat(); unsubscribeDownload(); unsubscribeRuntime(); unsubscribeRuntimeStatus(); unsubscribeMcp(); unsubscribeUpdates(); window.removeEventListener('keydown', hotkeys); };
  }, []);

  useEffect(() => {
    if (!state) return;
    const apply = () => {
      const theme = state.settings.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : state.settings.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.zoom = `${state.settings.zoomPercent || 100}%`;
    };
    apply();
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener?.('change', apply);
    return () => media.removeEventListener?.('change', apply);
  }, [state?.settings.theme, state?.settings.zoomPercent]);

  useEffect(() => {
    if (!state) return;
    setProviderCatalogUrlDraft(state.settings.providerCatalogUrl);
    setSystemPromptDraft(state.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  }, [state?.settings.providerCatalogUrl, state?.settings.systemPrompt]);

  useEffect(() => {
    if (activeTab === 'settings' && settingsSection === 'providers' && providerView === 'discover' && !providerCatalog && !catalogLoading) void loadProviderCatalog(false);
  }, [activeTab, settingsSection, providerView, providerCatalog, catalogLoading]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chatMessages, streaming]);

  useEffect(() => {
    if (!activeSessionId || chatMessages.length === 0) return;
    const session = buildChatSessionSnapshot(activeSessionId, chatMessages);
    const timer = window.setTimeout(() => {
      void bridge.saveChatSession(session).then(setChatSessions).catch((error) => showToast(error instanceof Error ? error.message : 'Could not save this conversation.'));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, chatMessages, selectedProvider?.id, selectedModel?.id]);

  useEffect(() => {
    if (activeTab === 'workspace' && state?.settings.activeProjectPath) void loadProjectFiles();
    if (activeTab === 'models' && modelSection === 'local') {
      void bridge.getLocalModels().then(setLocalModels).catch(() => {});
      if (!hfModels.length) void searchHuggingFace('');
    }
  }, [activeTab, modelSection, state?.settings.activeProjectPath]);

  useEffect(() => {
    if (!state?.settings.activeProjectPath || !previewVisible || !previewPath || !previewFiles.some((entry) => entry.path === previewPath)) {
      setPreviewUrl('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const request = currentFile === previewPath ? bridge.updateProjectPreview(previewPath, fileContent) : bridge.getProjectPreviewUrl(previewPath);
      void request.then((url) => { if (!cancelled) setPreviewUrl(url); }).catch(() => { if (!cancelled) setPreviewUrl(''); });
    }, currentFile === previewPath ? 500 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [state?.settings.activeProjectPath, previewVisible, previewPath, previewFiles, currentFile, fileContent, previewRevision]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }

  async function checkSoftwareUpdates() {
    setUpdateBusy(true);
    try { setUpdateStatus(await bridge.checkForUpdates()); }
    catch (error) { setUpdateStatus((current) => ({ state: 'error', currentVersion: current.currentVersion, message: error instanceof Error ? error.message : 'Could not check for updates.' })); }
    finally { setUpdateBusy(false); }
  }

  async function downloadSoftwareUpdate() {
    setUpdateBusy(true);
    try { setUpdateStatus(await bridge.downloadUpdate()); }
    catch (error) { setUpdateStatus((current) => ({ state: 'error', currentVersion: current.currentVersion, message: error instanceof Error ? error.message : 'Could not download the update.' })); }
    finally { setUpdateBusy(false); }
  }

  async function installSoftwareUpdate() {
    setUpdateBusy(true);
    try { await bridge.installUpdate(); }
    catch (error) { setUpdateStatus((current) => ({ state: 'error', currentVersion: current.currentVersion, message: error instanceof Error ? error.message : 'Could not install the update.' })); setUpdateBusy(false); }
  }

  function buildChatSessionSnapshot(sessionId: string, messages: Message[]): ChatSession {
    const firstUser = messages.find((message) => message.role === 'user')?.content.trim() || 'New conversation';
    return {
      id: sessionId,
      title: firstUser.replace(/\s+/g, ' ').slice(0, 100),
      createdAt: messages[0]?.createdAt || Date.now(),
      updatedAt: Date.now(),
      providerId: selectedProvider?.id || '',
      modelId: selectedModel?.id || '',
      messages,
    };
  }

  async function persistCurrentSession() {
    if (!activeSessionId || !chatMessages.length) return;
    try { setChatSessions(await bridge.saveChatSession(buildChatSessionSnapshot(activeSessionId, chatMessages))); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not save this conversation.'); }
  }

  async function loadProviderCatalog(forceRefresh = false) {
    setCatalogLoading(true);
    try { setProviderCatalog(await bridge.getProviderCatalog(forceRefresh)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Provider directory could not be loaded.'); }
    finally { setCatalogLoading(false); }
  }

  async function addCatalogProvider(entry: ProviderCatalogEntry) {
    setAddingProviderId(entry.id);
    try {
      let next = await bridge.addCatalogProvider(entry.id);
      const provider = next.providers.find((item) => item.id === entry.id);
      if (provider) {
        next = await bridge.saveSettings({ activeProviderId: provider.id, activeModelId: provider.models[0]?.id || '' });
        setProviderEditor(next.providers.find((item) => item.id === entry.id) || provider);
      }
      setState(next);
      showToast(`${entry.name} added and selected in the model picker`);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not add provider.'); }
    finally { setAddingProviderId(''); }
  }

  async function saveProviderCatalogUrl() {
    let url: URL;
    try { url = new URL(providerCatalogUrlDraft.trim()); }
    catch { showToast('Enter a valid HTTPS JSON catalog URL.'); return; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) { showToast('Provider catalog URLs must use HTTPS and cannot include credentials or fragments.'); return; }
    try {
      const next = await bridge.saveSettings({ providerCatalogUrl: url.toString() });
      setState(next);
      await loadProviderCatalog(true);
      showToast('Provider directory refreshed');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not save the provider catalog URL.'); }
  }

  async function fetchActiveProviderModels() {
    if (!selectedProvider) return;
    if (!bridge.previewMode && selectedProvider.id !== 'llamacpp' && !selectedProvider.hasKey) {
      setProviderEditor(selectedProvider);
      showToast('Add an API key, then fetch the provider’s live model list.');
      return;
    }
    await refreshProvider(selectedProvider.id);
  }

  async function saveSettings(patch: Partial<AppSettings>) {
    if (!state) return;
    const sequence = ++settingsSaveSequence.current;
    setState((current) => current ? { ...current, settings: { ...current.settings, ...patch, localRuntime: { ...current.settings.localRuntime, ...(patch.localRuntime || {}) } } } : current);
    try {
      const next = await bridge.saveSettings(patch);
      if (!next || !next.settings || !Array.isArray(next.providers)) throw new Error('The settings response was incomplete; your current workspace was kept.');
      const safeNext: AppState = { ...next, providers: next.providers.map((provider) => ({ ...provider, models: Array.isArray(provider.models) ? provider.models : [] })) };
      if (sequence === settingsSaveSequence.current) setState((current) => current ? { ...current, ...safeNext, settings: { ...current.settings, ...safeNext.settings, localRuntime: { ...current.settings.localRuntime, ...safeNext.settings.localRuntime } } } : safeNext);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not save settings.'); }
  }

  async function navigate(tab: NavigationTab) {
    if (!state) return;
    await saveSettings({ activeTab: tab });
  }

  async function selectProvider(providerId: string) {
    if (!state) return;
    const provider = state.providers.find((item) => item.id === providerId);
    if (!provider) { showToast('That provider is no longer available. Refresh the provider list and try again.'); return; }
    const modelId = Array.isArray(provider.models) ? provider.models[0]?.id || '' : '';
    await saveSettings({ activeProviderId: provider.id, activeModelId: modelId });
  }

  async function refreshProvider(providerId: string) {
    setRefreshingId(providerId);
    try {
      const result = await bridge.refreshModels(providerId);
      setState(result.state);
      if (result.error) showToast(result.error);
      else showToast(`Synced ${result.state.providers.find((provider) => provider.id === providerId)?.models.length || 0} models`);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Model sync failed.'); }
    finally { setRefreshingId(''); }
  }

  async function refreshAll() {
    setRefreshingId('all');
    try { const next = await bridge.refreshAllModels(); setState(next); showToast('Provider catalog refreshed'); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Refresh failed.'); }
    finally { setRefreshingId(''); }
  }

  async function saveProvider(form: ProviderForm) {
    try {
      const next = await bridge.saveProvider(form);
      setState(next); setProviderEditor(undefined);
      showToast(bridge.previewMode ? 'Provider saved for this preview (API keys are not stored here).' : 'Provider connection saved securely · syncing models…');
      if (!bridge.previewMode) window.setTimeout(() => { void refreshProvider(form.id); }, 180);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not save provider.'); }
  }

  async function removeProvider(provider: ProviderInfo) {
    if (!window.confirm(`Remove ${provider.name}? This removes its saved provider configuration and encrypted key.`)) return;
    try { setState(await bridge.removeProvider(provider.id)); showToast(`${provider.name} removed`); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not remove provider.'); }
  }

  async function saveMcpServer(input: McpServerSaveInput) {
    try {
      setState(await bridge.saveMcpServer(input));
      setMcpEditor(undefined); setMcpPreset(null);
      showToast('MCP server saved. Review the command, then Connect to discover its capabilities.');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not save MCP server.'); }
  }

  async function connectMcpServer(server: McpServerInfo) {
    if (bridge.previewMode) { showToast('MCP processes can only be launched by the desktop app.'); return; }
    try { setState(await bridge.connectMcpServer(server.id)); showToast(`${server.name} connected · tools discovered`); }
    catch (error) { showToast(error instanceof Error ? error.message : `Could not connect ${server.name}.`); }
  }

  async function disconnectMcpServer(server: McpServerInfo) {
    try { setState(await bridge.disconnectMcpServer(server.id)); showToast(`${server.name} disconnected`); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not disconnect MCP server.'); }
  }

  async function refreshMcpServer(server: McpServerInfo) {
    try { setState(await bridge.refreshMcpServer(server.id)); showToast(`Refreshed ${server.name} capabilities`); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not refresh MCP capabilities.'); }
  }

  async function removeMcpServer(server: McpServerInfo) {
    if (!window.confirm(`Remove ${server.name}? Its encrypted MCP headers and environment values will also be deleted.`)) return;
    try { setState(await bridge.removeMcpServer(server.id)); showToast(`${server.name} removed`); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not remove MCP server.'); }
  }

  async function setMcpCapability(server: McpServerInfo, toolKey: string, enabled: boolean) {
    try { setState(await bridge.setMcpToolEnabled(server.id, toolKey, enabled)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not update MCP capability.'); }
  }

  function startNewChat() {
    if (streaming) return;
    void persistCurrentSession();
    activeRequestRef.current = '';
    assistantMessageRef.current = '';
    setActiveSessionId('');
    setChatMessages([]);
    setComposer('');
    void navigate('chat');
    window.setTimeout(() => composerRef.current?.focus(), 80);
  }

  async function openChatSession(sessionId: string) {
    if (streaming) return;
    await persistCurrentSession();
    try {
      const session = await bridge.getChatSession(sessionId);
      if (!session) { setChatSessions(await bridge.getChatSessions()); showToast('That conversation could not be found.'); return; }
      activeRequestRef.current = '';
      assistantMessageRef.current = '';
      setActiveSessionId(session.id);
      setChatMessages(session.messages);
      setComposer('');
      void navigate('chat');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not open that conversation.'); }
  }

  async function deleteChatSession(sessionId: string) {
    const target = chatSessions.find((session) => session.id === sessionId);
    if (!target) return;
    if (streaming && sessionId === activeSessionId) { showToast('Stop the active response before deleting this conversation.'); return; }
    if (!window.confirm(`Delete “${target.title}” and all its messages? This cannot be undone.`)) return;
    try {
      const sessions = await bridge.deleteChatSession(sessionId);
      setChatSessions(sessions);
      if (activeSessionId === sessionId) {
        activeRequestRef.current = '';
        assistantMessageRef.current = '';
        setActiveSessionId(''); setChatMessages([]); setComposer('');
        const fallback = sessions[0] ? await bridge.getChatSession(sessions[0].id) : null;
        if (fallback) { setActiveSessionId(fallback.id); setChatMessages(fallback.messages); }
        void navigate('chat');
      }
      showToast('Conversation deleted');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not delete that conversation.'); }
  }

  async function deleteChatMessage(messageId: string) {
    if (!activeSessionId || streaming) return;
    if (!window.confirm('Delete this message from the conversation?')) return;
    try {
      const result = await bridge.deleteChatMessage(activeSessionId, messageId);
      setChatSessions(result.sessions);
      if (result.session) setChatMessages(result.session.messages);
      else {
        setActiveSessionId(''); setChatMessages([]);
        const fallback = result.sessions[0] ? await bridge.getChatSession(result.sessions[0].id) : null;
        if (fallback) { setActiveSessionId(fallback.id); setChatMessages(fallback.messages); }
      }
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not delete that message.'); }
  }

  async function clearAllChatSessions() {
    if (streaming) { showToast('Stop the active response before deleting saved conversations.'); return; }
    if (!chatSessions.length || !window.confirm(`Delete all ${chatSessions.length} saved conversations and their messages? This cannot be undone.`)) return;
    try {
      await bridge.clearChatSessions();
      setChatSessions([]); setActiveSessionId(''); setChatMessages([]); setComposer('');
      showToast('All conversations deleted');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not clear conversations.'); }
  }

  async function sendMessage(text = composer) {
    if (!state || !text.trim() || streaming) return;
    const userMessage: Message = { id: `user-${crypto.randomUUID()}`, role: 'user', content: text.trim(), createdAt: Date.now() };
    const assistantMessage: Message = { id: `assistant-${crypto.randomUUID()}`, role: 'assistant', content: '', createdAt: Date.now() };
    const requestId = crypto.randomUUID();
    const sessionId = activeSessionId || crypto.randomUUID();
    activeRequestRef.current = requestId;
    if (!activeSessionId) setActiveSessionId(sessionId);
    const nextMessages = [...chatMessages, userMessage, assistantMessage];
    setChatMessages(nextMessages); setComposer(''); setStreaming(true); setChatStatus('Connecting to model…');
    assistantMessageRef.current = assistantMessage.id;
    const input = trimConversation(nextMessages.filter((message) => message.content).slice(-32).map(({ role, content }) => ({ role, content })), state.settings.contextTokens, state.settings.maxOutputTokens);
    const request = {
      providerId: selectedProvider?.id || state.settings.activeProviderId,
      model: selectedModel?.id || state.settings.activeModelId,
      messages: input,
      systemPrompt: state.settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      enableTools: state.settings.enableTools,
      contextTokens: state.settings.contextTokens,
      maxOutputTokens: state.settings.maxOutputTokens,
      temperature: state.settings.temperature,
    };
    try {
      await bridge.startChat(request, requestId);
      if (bridge.previewMode) setChatStatus('Preview · simulated stream');
    } catch (error) {
      activeRequestRef.current = '';
      setStreaming(false);
      setChatMessages((messages) => messages.map((message) => message.id === assistantMessage.id ? { ...message, error: true, content: error instanceof Error ? error.message : 'Could not start model request.' } : message));
    }
  }

  function stopStreaming() {
    if (activeRequestRef.current) bridge.cancelChat(activeRequestRef.current);
    activeRequestRef.current = '';
    setPendingTool(null);
    setPendingQuestion(null);
    setStreaming(false); setChatStatus('Stopped');
  }

  function handleComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  }

  async function pickProject() {
    const folder = await bridge.openProject();
    if (folder) {
      const next = await bridge.getState(); setState(next); setOpenFiles([]); setCurrentFile(''); setFileContent(''); setPreviewVisible(false); setPreviewUrl(''); setPreviewPath('');
      await loadProjectFiles(); showToast(`Opened ${folder.split(/[\\/]/).filter(Boolean).at(-1) || folder}`);
    }
  }

  async function loadProjectFiles() {
    try {
      const entries = await bridge.listProjectFiles();
      setProjectEntries(entries);
      const htmlFiles = entries.filter((entry) => entry.type === 'file' && ['.html', '.htm'].includes((entry.extension || '').toLowerCase()));
      setPreviewPath((current) => htmlFiles.some((entry) => entry.path === current) ? current : htmlFiles[0]?.path || '');
    } catch { setProjectEntries([]); setPreviewPath(''); }
  }

  async function openFile(entry: ProjectEntry) {
    if (entry.type !== 'file') {
      setExpandedFolders((folders) => { const next = new Set(folders); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); return next; });
      return;
    }
    try {
      const content = await bridge.readProjectFile(entry.path);
      setCurrentFile(entry.path); setFileContent(content); setFileDirty(false);
      if (['.html', '.htm'].includes((entry.extension || '').toLowerCase())) setPreviewPath(entry.path);
      setOpenFiles((files) => files.includes(entry.path) ? files : [...files, entry.path]);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not open file.'); }
  }

  async function switchFile(file: string) {
    const entry = projectEntries.find((item) => item.path === file);
    if (entry) await openFile(entry);
    else { setCurrentFile(file); setFileContent(''); setFileDirty(false); }
  }

  async function saveCurrentFile() {
    if (!currentFile) return;
    try { await bridge.writeProjectFile(currentFile, fileContent); setFileDirty(false); showToast('File saved'); await loadProjectFiles(); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not save file.'); }
  }

  async function createProjectFile(event: React.FormEvent) {
    event.preventDefault();
    const relativePath = newFilePath.trim().replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) { showToast('Enter a project-relative file path.'); return; }
    if (projectEntries.some((entry) => entry.path === relativePath)) { showToast('A file or folder with that path already exists.'); return; }
    try {
      await bridge.writeProjectFile(relativePath, '');
      setShowNewFile(false); setCurrentFile(relativePath); setFileContent(''); setFileDirty(false);
      if (['.html', '.htm'].includes(`.${relativePath.split('.').at(-1)?.toLowerCase()}`)) setPreviewPath(relativePath);
      setOpenFiles((files) => files.includes(relativePath) ? files : [...files, relativePath]);
      await loadProjectFiles(); showToast('New file created');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not create file.'); }
  }

  async function searchHuggingFace(query = hfQuery) {
    setHfLoading(true);
    try { setHfModels(await bridge.searchHuggingFace(query)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Model search failed.'); }
    finally { setHfLoading(false); }
  }

  async function chooseHfRepo(repoId: string) {
    setSelectedRepo(repoId); setRepoFiles([]); setHfLoading(true);
    try { setRepoFiles(await bridge.getHuggingFaceFiles(repoId)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not load GGUF files.'); }
    finally { setHfLoading(false); }
  }

  async function downloadModel(repoId: string, file: HuggingFaceFile) {
    setDownloadProgress({ filename: file.name, received: 0 });
    try {
      const filePath = await bridge.downloadHuggingFaceFile(repoId, file.name);
      const next = await bridge.getState(); setState(next);
      setDownloadProgress(null); setLocalModels(await bridge.getLocalModels());
      showToast(bridge.previewMode ? 'Preview only: the desktop app will download this GGUF file.' : `Downloaded ${file.name}`);
      if (!bridge.previewMode) setHfModels((models) => [...models]);
      return filePath;
    } catch (error) { setDownloadProgress(null); showToast(error instanceof Error ? error.message : 'Model download failed.'); return null; }
  }

  async function setRuntimePath() {
    if (state?.runtime.running) { showToast('Stop the local runtime before changing its executable.'); return; }
    const value = await bridge.setRuntimePath(); if (value) { const next = await bridge.getState(); setState(next); showToast('llama-server path selected'); }
  }
  async function setLocalModelPath() {
    if (state?.runtime.running) { showToast('Stop the local runtime before changing its active GGUF.'); return; }
    const value = await bridge.setLocalModelPath(); if (value) { const next = await bridge.getState(); setState(next); showToast('GGUF model selected'); }
  }
  async function startRuntime() {
    try { const next = await bridge.startLocalRuntime(); setState(next); showToast(next.runtime.running ? 'Local model is ready' : next.runtime.message); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not start local runtime.'); }
  }
  async function stopRuntime() {
    try { setState(await bridge.stopLocalRuntime()); showToast('Local runtime stopped'); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not stop runtime.'); }
  }

  async function executeShell() {
    const command = shellConfirm;
    setShellConfirm('');
    if (!command) return;
    setTerminalOutput((output) => `${output}\n$ ${command}\n`);
    try {
      const result = await bridge.runShellCommand(command);
      setTerminalOutput((output) => `${output}${result.output || '(no output)'}\n[exit ${result.exitCode ?? 'unknown'}]\n`);
    } catch (error) { setTerminalOutput((output) => `${output}Error: ${error instanceof Error ? error.message : String(error)}\n`); }
  }

  async function respondTool(decision: ToolApprovalChoice) {
    if (!pendingTool) return;
    const toolId = pendingTool.id;
    setPendingTool(null);
    try {
      setState(await bridge.respondToTool(toolId, decision));
      if (decision === 'deny') showToast('Tool request denied');
      else if (decision === 'session') showToast('Allowed for this session');
      else if (decision === 'always') showToast('Always allowed for this tool');
    } catch (error) { showToast(error instanceof Error ? error.message : 'Could not save tool approval.'); }
  }

  async function answerQuestion(answer: string) {
    if (!pendingQuestion) return;
    const questionId = pendingQuestion.id;
    setPendingQuestion(null);
    try { await bridge.answerQuestion(questionId, answer); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not send your answer.'); }
  }

  async function saveHfToken(event: React.FormEvent) {
    event.preventDefault();
    try { const next = await bridge.setHuggingFaceToken(hfTokenInput); setState(next); setHfTokenInput(''); showToast(bridge.previewMode ? 'Preview only · token was not stored' : 'Hugging Face token saved securely'); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not save token.'); }
  }

  function setActiveTab(tab: NavigationTab) { void navigate(tab); }
  function patchLocalRuntime(patch: Partial<AppSettings['localRuntime']>) {
    if (!state) return;
    void saveSettings({ localRuntime: { ...state.settings.localRuntime, ...patch } });
  }

  if (loading) return <div className="boot-screen"><div className="brand-mark"><Sparkles size={19} /></div><div className="boot-loader" /><p>Preparing your workbench</p></div>;
  if (!state) return <div className="fatal-screen"><div className="fatal-card"><div className="fatal-icon"><CircleHelp size={20} /></div><p className="eyebrow">WORKBENCH RECOVERY</p><h1>Couldn’t load Nexus.</h1><p className="fatal-copy">{loadError || 'The settings service did not return a workspace.'}</p><button className="primary-button" onClick={() => window.location.reload()}><RefreshCw size={15} /> Try again</button></div></div>;

  const visibleEntries = projectEntries.filter((entry) => {
    const parts = entry.path.split('/');
    const parentPaths = parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
    return parentPaths.every((folder) => expandedFolders.has(folder));
  });
  const activeProviderName = selectedProvider?.name || 'Choose provider';
  const shellDirectoryLabel = state.settings.activeProjectPath ? `the project folder ${state.settings.activeProjectPath}` : state.settings.allowShellWithoutProject ? 'your home folder' : 'no folder (home-folder shell access is disabled)';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark"><Sparkles size={19} strokeWidth={2.3} /></div><div className="brand-name">nexus<span>studio</span><small>AI WORKBENCH</small></div><button className="icon-button sidebar-collapse" title="Collapse sidebar"><PanelLeft size={16} /></button></div>
      <button className="new-chat-button" onClick={startNewChat} disabled={streaming}><Plus size={16} strokeWidth={2.2} /><span>New conversation</span><kbd>Ctrl K</kbd></button>
      <div className="nav-caption">WORKSPACE</div>
      <nav className="main-nav" aria-label="Primary navigation">
        <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}><MessageSquare size={17} /><span>Chat</span><span className="nav-indicator" /></button>
        <button className={activeTab === 'workspace' ? 'active' : ''} onClick={() => setActiveTab('workspace')}><Code2 size={17} /><span>Workspace</span>{state.settings.activeProjectPath && <span className="nav-project-dot" />}</button>
        <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}><Workflow size={17} /><span>Model library</span><span className="nav-count">{state.providers.reduce((count, provider) => count + provider.models.length, 0) || '—'}</span></button>
        <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}><Settings size={17} /><span>Settings</span></button>
      </nav>
      <div className="sidebar-model-picker">
        <div className="sidebar-model-picker-head"><span>ACTIVE MODEL</span><span className="sidebar-model-status"><StatusDot status={selectedProvider?.status || 'unknown'} />{selectedModel ? 'Ready' : 'Needs setup'}</span></div>
        <label className="sr-only" htmlFor="sidebar-provider-select">Provider</label>
        <select id="sidebar-provider-select" aria-label="Active provider" value={selectedProvider?.id || ''} onChange={(event) => void selectProvider(event.target.value)}>
          {state.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        <label className="sr-only" htmlFor="sidebar-model-select">Model</label>
        <select id="sidebar-model-select" aria-label="Active AI model" value={selectedModel?.id || ''} onChange={(event) => void saveSettings({ activeModelId: event.target.value })}>
          {selectedProvider?.models.length ? selectedProvider.models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.isFree ? ' · Free' : ''}</option>) : <option value="">No models synced yet</option>}
        </select>
        <button className="sidebar-fetch-models" onClick={() => void fetchActiveProviderModels()} disabled={refreshingId === selectedProvider?.id}>
          {refreshingId === selectedProvider?.id ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Fetch models
        </button>
      </div>
      <div className="sidebar-divider" />
      <div className="sidebar-section-heading"><span>PROJECT</span><button className="icon-button small" onClick={() => void pickProject()} title="Open project"><Plus size={15} /></button></div>
      {state.settings.activeProjectPath ? <button className="project-mini" onClick={() => setActiveTab('workspace')}><span className="project-mini-icon"><FolderOpen size={15} /></span><span className="project-mini-copy"><strong>{state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</strong><small>Open workspace</small></span><ChevronRight size={14} /></button> : <button className="project-empty" onClick={() => void pickProject()}><Folder size={15} /><span>Open a code project</span><ArrowRight size={13} /></button>}
      <section className="sidebar-chat-history">
        <div className="sidebar-section-heading history-heading"><span>RECENT CHATS</span>{chatSessions.length > 0 && <button className="icon-button small" title="Delete all conversations" aria-label="Delete all conversations" onClick={() => void clearAllChatSessions()}><Trash2 size={13} /></button>}</div>
        {chatSessions.length ? <div className="chat-session-list">{chatSessions.map((session) => <div className={`chat-session-row ${activeSessionId === session.id ? 'active' : ''}`} key={session.id}>
          <button className="chat-session-open" onClick={() => void openChatSession(session.id)} disabled={streaming} title={session.title}><MessageSquare size={13} /><span><strong>{session.title || 'New conversation'}</strong><small>{session.messageCount} {session.messageCount === 1 ? 'message' : 'messages'} · {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(session.updatedAt))}</small></span></button>
          <button className="chat-session-delete" onClick={() => void deleteChatSession(session.id)} disabled={streaming && activeSessionId === session.id} title="Delete conversation" aria-label={`Delete ${session.title}`}><Trash2 size={13} /></button>
        </div>)}</div> : <p className="chat-history-empty">Saved conversations appear here.</p>}
      </section>
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom">
        <div className={`local-state-card ${state.runtime.running ? 'runtime-on' : ''}`}>
          <span className="local-state-icon"><Cpu size={16} /></span><span className="local-state-copy"><strong>{state.runtime.running ? 'Local model online' : 'Local runtime'}</strong><small>{state.runtime.running ? 'llama.cpp · ready' : 'Connect a GGUF model'}</small></span><span className="local-led" />
          <button className="card-open-hit" aria-label="Configure local runtime" onClick={() => { void navigate('settings'); setSettingsSection('local'); }} />
        </div>
        <div className="user-row"><div className="user-avatar"><Sparkles size={15} /></div><div><strong>Nexus workbench</strong><small>{bridge.previewMode ? 'INTERACTIVE PREVIEW' : 'DESKTOP APP'}</small></div><button className="icon-button small" onClick={() => setActiveTab('settings')} title="Open settings"><MoreHorizontal size={17} /></button></div>
      </div>
    </aside>

    <main className="main-shell">
      <header className="topbar">
        <div className="breadcrumb"><span className="breadcrumb-parent">Nexus</span><ChevronRight size={13} /><strong>{sectionNames[activeTab]}</strong>{activeTab === 'workspace' && state.settings.activeProjectPath && <><ChevronRight size={13} /><span>{state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span></>}</div>
        <div className="topbar-actions">
          <div className="model-switcher" title="Select the model for new messages">
            <span className={`model-switcher-mark ${selectedProvider?.id || ''}`}>{selectedProvider?.id === 'llamacpp' ? <Cpu size={14} /> : <Sparkles size={13} />}</span>
            <select aria-label="Provider" value={selectedProvider?.id || ''} onChange={(event) => void selectProvider(event.target.value)}>
              {state.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select><span className="switcher-separator" />
            <select aria-label="Model" value={selectedModel?.id || ''} onChange={(event) => void saveSettings({ activeModelId: event.target.value })}>
              {selectedProvider?.models.length ? selectedProvider.models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.isFree ? ' · Free' : ''}</option>) : <option value="">No models synced</option>}
            </select><ChevronDown size={13} className="switcher-chevron" />
          </div>
          <button className="fetch-models-button" onClick={() => void fetchActiveProviderModels()} disabled={!selectedProvider || refreshingId === selectedProvider?.id} title="Fetch the latest model list from this provider">
            {refreshingId === selectedProvider?.id ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}<span>Fetch models</span>
          </button>
          <span className={`top-connection ${selectedProvider?.status === 'active' ? 'connected' : ''}`}><span />{selectedProvider?.status === 'active' ? 'Connected' : selectedProvider?.id === 'llamacpp' ? 'Local' : selectedProvider?.hasKey ? 'Ready' : 'Setup'}</span>
          <button className="top-icon-button" onClick={() => setActiveTab('settings')} title="Settings"><SlidersHorizontal size={16} /></button>
        </div>
      </header>

      {bridge.previewMode && <div className="preview-notice"><span><Eye size={14} /> Preview mode</span><span>This browser preview simulates model output. Use the Windows app to connect real providers, save encrypted keys, stream tokens, and run tools.</span><button onClick={() => setActiveTab('settings')}>Configure <ArrowRight size={13} /></button></div>}

      {activeTab === 'chat' && <section className="chat-view">
        <div className="chat-scroll-area">
          {chatMessages.length === 0 ? <div className="welcome-wrap">
            <div className="welcome-overline"><span className="welcome-pulse" /> YOUR THINKING SPACE <span className="welcome-line" /></div>
            <div className="welcome-orb-wrap"><div className="welcome-orb"><div className="orb-core"><Sparkles size={25} /></div><span className="orb-ring ring-a" /><span className="orb-ring ring-b" /><span className="orb-ring ring-c" /><span className="orb-dot dot-a" /><span className="orb-dot dot-b" /></div></div>
            <h1>Make space for<br /><span>better thinking.</span></h1>
            <p className="welcome-copy">A focused workspace for ideas, code, and the models you choose.<br />Bring your own cloud endpoint or run a model locally.</p>
            <div className="welcome-prompts">
              <button onClick={() => setComposer('Help me plan a feature for my project.')}><span className="suggestion-icon mint"><Code2 size={15} /></span><span><strong>Build something</strong><small>Plan and implement a feature</small></span><ArrowUp size={14} /></button>
              <button onClick={() => setComposer('Explain a concept to me step by step.')}><span className="suggestion-icon lavender"><BookOpen size={15} /></span><span><strong>Learn deeply</strong><small>Explore a hard idea, clearly</small></span><ArrowUp size={14} /></button>
              <button onClick={() => setComposer('Help me debug an issue. Start by asking what you need.')}><span className="suggestion-icon amber"><WandSparkles size={15} /></span><span><strong>Find a way through</strong><small>Debug, reason, and refine</small></span><ArrowUp size={14} /></button>
            </div>
            {!selectedModel && <button className="setup-inline" onClick={() => setActiveTab('models')}><span><Zap size={16} /></span><span><strong>Choose your first model</strong><small>Connect a provider or download a local GGUF.</small></span><ArrowRight size={15} /></button>}
          </div> : <div className="conversation">
            <div className="conversation-heading"><span className="conversation-pill"><Sparkles size={12} /> NEXUS SESSION</span><span className="conversation-date">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())}</span><button className="icon-button small" title="New conversation" onClick={startNewChat} disabled={streaming}><Plus size={15} /></button></div>
            {chatMessages.map((message) => <article className={`message-row ${message.role}`} key={message.id}>
              {message.role === 'assistant' ? <div className="assistant-avatar"><Sparkles size={15} /></div> : <div className="user-avatar message-avatar"><span>Y</span></div>}
              <div className="message-body">
                <div className="message-meta"><strong>{message.role === 'assistant' ? 'Nexus' : 'You'}</strong>{message.role === 'assistant' && selectedModel && <><span className="message-meta-dot">·</span><span>{selectedModel.name}</span></>}<span className="message-time">{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(message.createdAt)}</span></div>
                {message.role === 'assistant' && Boolean(message.reasoning) && <details className="reasoning-panel" open={reasoningExpanded[message.id] ?? (streaming && message.id === assistantMessageRef.current)} onToggle={(event) => { const isOpen = event.currentTarget.open; setReasoningExpanded((current) => ({ ...current, [message.id]: isOpen })); }}>
                  <summary><span className="reasoning-led" />{streaming && message.id === assistantMessageRef.current ? 'Thinking · live' : 'Thinking'}<ChevronDown size={13} /></summary>
                  <div className="reasoning-content"><Markup text={message.reasoning || ''} /></div>
                </details>}
                <div className={`message-content ${message.error ? 'message-error' : ''}`}>{message.content ? <Markup text={message.content} /> : streaming && message.id === assistantMessageRef.current && !message.reasoning ? <span className="thinking-label"><span className="typing-dots"><i /><i /><i /></span>Thinking…</span> : null}</div>
                {message.role === 'assistant' && message.toolTraces?.map((trace) => <details className={`tool-trace ${trace.state}`} key={trace.id} open={toolTraceExpanded[trace.id] ?? trace.state === 'running'} onToggle={(event) => { const isOpen = event.currentTarget.open; setToolTraceExpanded((current) => ({ ...current, [trace.id]: isOpen })); }}>
                  <summary><span className="tool-trace-indicator">{trace.state === 'running' ? <LoaderCircle size={13} className="spin" /> : trace.state === 'error' ? <CircleHelp size={13} /> : trace.state === 'denied' ? <Shield size={13} /> : <CheckCircle2 size={13} />}</span><strong>{trace.label || trace.name.replace(/^default_/, 'default.')}</strong><span className="tool-trace-state">{trace.state === 'running' ? 'Running' : trace.state === 'error' ? 'Failed' : trace.state === 'denied' ? 'Denied' : 'Complete'}</span><ChevronDown size={13} /></summary>
                  <div className="tool-trace-content"><details><summary>Arguments</summary><pre>{JSON.stringify(trace.arguments, null, 2)}</pre></details>{trace.result && <details open={trace.state === 'error'}><summary>Tool output</summary><pre>{trace.result}</pre></details>}</div>
                </details>)}
                {message.content && <div className="message-tools">{message.role === 'assistant' && <><button onClick={() => { void navigator.clipboard?.writeText(message.content).then(() => showToast('Copied to clipboard')); }}><Copy size={13} /> Copy</button><button onClick={() => setComposer('Continue from where you left off.')}><ArrowRight size={13} /> Continue</button></>}<button className="delete-message-action" onClick={() => void deleteChatMessage(message.id)} disabled={streaming || !activeSessionId} title="Delete this message"><Trash2 size={13} /> Delete</button></div>}
              </div>
            </article>)}
            <div ref={messagesEndRef} />
          </div>}
        </div>
        <div className="composer-zone">
          {streaming && <div className="streaming-status"><span className="streaming-dot" /><span>{chatStatus}</span><span className="streaming-live">LIVE STREAM</span><button onClick={stopStreaming}><Square size={11} fill="currentColor" /> Stop</button></div>}
          <div className="composer-box">
            <textarea ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={handleComposerKey} placeholder={state.settings.activeProjectPath ? `Ask about ${state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}…` : 'Ask, think, or build something…'} rows={1} disabled={streaming} />
            <div className="composer-footer">
              <div className="composer-tools"><button className={`composer-tool ${state.settings.enableTools ? 'tool-enabled' : ''}`} onClick={() => void saveSettings({ enableTools: !state.settings.enableTools })} title={state.settings.enableTools ? 'Tool calling enabled — approvals are required' : 'Enable agent tools'}><Workflow size={14} /><span>Tools {state.settings.enableTools ? 'on' : 'off'}</span><span className="tool-mini-dot" /></button><span className="composer-divider" />{state.settings.activeProjectPath ? <span className="composer-project"><FolderOpen size={13} /> {state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span> : <button className="composer-tool" onClick={() => void pickProject()} title="Attach a project"><Folder size={14} /><span>Project</span></button>}</div>
              <div className="composer-right"><span className="composer-hint">Enter to send <kbd>⇧</kbd> for newline</span>{streaming ? <button className="send-button stop-button" onClick={stopStreaming} aria-label="Stop response"><Square size={14} fill="currentColor" /></button> : <button className="send-button" onClick={() => void sendMessage()} disabled={!composer.trim()} aria-label="Send message"><ArrowUp size={18} strokeWidth={2.5} /></button>}</div>
            </div>
          </div>
          <div className="composer-footnote"><span>AI can make mistakes. Verify important details.</span><span><Shield size={12} /> Your key stays on your device</span></div>
        </div>
      </section>}

      {activeTab === 'workspace' && <section className="workspace-view">
        <div className="workspace-toolbar"><div className="workspace-heading"><div className="workspace-heading-icon"><Code2 size={17} /></div><div><div className="eyebrow">PROJECT WORKSPACE</div><h1>{state.settings.activeProjectPath ? state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1) : 'Your workspace'}</h1></div></div><div className="workspace-actions"><button className="secondary-button" onClick={() => void pickProject()}><FolderOpen size={15} />{state.settings.activeProjectPath ? 'Change folder' : 'Open folder'}</button>{currentFile && <button className="primary-button" onClick={() => void saveCurrentFile()} disabled={!fileDirty}><Check size={15} />{fileDirty ? 'Save changes' : 'Saved'}</button>}<button className={`secondary-button compact preview-toggle ${previewVisible ? 'selected' : ''}`} onClick={() => { setPreviewVisible(!previewVisible); if (!previewPath && previewFiles[0]) setPreviewPath(previewFiles[0].path); }} disabled={!previewFiles.length} title={previewFiles.length ? 'Toggle responsive HTML preview' : 'Add an HTML file to enable preview'}><Monitor size={14} />Preview</button><button className={`icon-button ${showTerminal ? 'selected' : ''}`} onClick={() => setShowTerminal(!showTerminal)} title="Toggle terminal"><Terminal size={16} /></button></div></div>
        {!state.settings.activeProjectPath ? <div className={`workspace-no-project ${showTerminal && state.settings.allowShellWithoutProject ? 'with-shell' : ''}`}>
          <div className="workspace-empty"><div className="empty-illustration"><div className="empty-window"><div className="empty-window-top"><i /><i /><i /></div><div className="empty-folder"><FolderOpen size={36} /></div><span className="empty-code-line long" /><span className="empty-code-line" /><span className="empty-code-line short" /></div><span className="empty-sparkle"><Sparkles size={20} /></span></div><h2>A place for your next idea.</h2><p>Open a project folder to browse files and edit code. You can also run shell commands from your home folder after enabling that option in Tools &amp; safety.</p><button className="primary-button large" onClick={() => void pickProject()}><FolderOpen size={16} /> Open a project</button><div className="workspace-empty-note"><LockKeyhole size={13} /> Project files remain on your device</div></div>
          {showTerminal && state.settings.allowShellWithoutProject && <div className="terminal-panel terminal-no-project"><div className="terminal-header"><div><Terminal size={14} /><span>TERMINAL</span><span className="terminal-project">HOME</span></div><button className="icon-button small" title="Clear terminal" onClick={() => setTerminalOutput('Nexus Terminal · commands run in your home folder and require confirmation.\n')}><Trash2 size={13} /></button></div><pre className="terminal-output">{terminalOutput}</pre><form className="terminal-input-row" onSubmit={(event) => { event.preventDefault(); if (terminalInput.trim()) { setShellConfirm(terminalInput.trim()); setTerminalInput(''); } }}><span className="terminal-prompt">$</span><input value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Type a command…" spellCheck={false} /><button type="submit" disabled={!terminalInput.trim()} aria-label="Run command"><ArrowUp size={15} /></button></form></div>}
        </div> : <div className={`ide-layout ${showTerminal ? '' : 'terminal-hidden'} ${previewVisible ? 'preview-open' : ''}`}>
          <aside className="file-explorer"><div className="explorer-top"><span>EXPLORER</span><div><button className="icon-button small" title="Refresh files" onClick={() => void loadProjectFiles()}><RefreshCw size={14} /></button><button className="icon-button small" title="Open another folder" onClick={() => void pickProject()}><FolderOpen size={14} /></button></div></div><div className="explorer-project"><ChevronDown size={14} /><span>{state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span><MoreHorizontal size={15} /></div><div className="file-tree">{visibleEntries.map((entry) => {
            const depth = entry.path.split('/').length - 1;
            const expanded = expandedFolders.has(entry.path);
            return <button key={entry.path} className={`tree-item ${entry.type} ${currentFile === entry.path ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 15 }} onClick={() => void openFile(entry)} title={entry.path}>
              {entry.type === 'directory' ? (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="tree-indent" />}{entry.type === 'directory' ? <Folder size={14} className={expanded ? 'folder-open-icon' : ''} /> : <TreeFileIcon extension={entry.extension || ''} />}<span>{entry.name}</span>
            </button>;
          })}{!projectEntries.length && <div className="tree-empty">No files to display</div>}</div><div className="explorer-bottom"><span><CircleHelp size={13} /> Local-only workspace</span><button className="icon-button small" title="Open project settings" onClick={() => setActiveTab('settings')}><Settings size={13} /></button></div></aside>
          <div className="editor-workarea"><div className="editor-tabs">{openFiles.length ? openFiles.map((file) => <button key={file} className={`editor-tab ${currentFile === file ? 'active' : ''}`} onClick={() => void switchFile(file)}><TreeFileIcon extension={file.split('.').at(-1) || ''} /><span>{file.split('/').at(-1)}</span>{currentFile === file && fileDirty && <i className="dirty-dot" />}<span className="tab-close" onClick={(event) => { event.stopPropagation(); const next = openFiles.filter((item) => item !== file); setOpenFiles(next); if (currentFile === file) void switchFile(next.at(-1) || ''); }}>×</span></button>) : <span className="no-file-tab">No file open</span>}<div className="editor-tab-spacer" /><button className="icon-button small" title="Create file" onClick={() => { setNewFilePath(''); setShowNewFile(true); }}><FilePlus2 size={14} /></button></div>
            <div className="editor-split-area">
              <div className="editor-pane">{currentFile ? <div className="editor-container"><div className="editor-breadcrumb"><span>{state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span><ChevronRight size={12} /><span>{currentFile.split('/').slice(0, -1).join('/')}</span>{currentFile.includes('/') && <ChevronRight size={12} />}<strong>{currentFile.split('/').at(-1)}</strong><span className="editor-language">{currentFile.split('.').at(-1)?.toUpperCase() || 'TEXT'}</span></div><div className="editor-content"><div className="line-numbers">{fileContent.split('\n').map((_line, index) => <span key={index}>{index + 1}</span>)}</div><textarea className="code-editor" value={fileContent} onChange={(event) => { setFileContent(event.target.value); setFileDirty(true); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" /></div></div> : <div className="editor-welcome"><div className="editor-welcome-icon"><FileCode2 size={24} /></div><h3>Choose a file to open</h3><p>Select a file in the explorer to read or edit it.</p><div className="editor-tip"><Sparkles size={14} /> Ask the model to inspect this project in Chat.</div></div>}</div>
              {previewVisible && <aside className="live-preview-panel"><div className="live-preview-toolbar"><div className="preview-page-picker"><Eye size={14} /><select aria-label="HTML preview file" value={previewPath} onChange={(event) => setPreviewPath(event.target.value)}>{previewFiles.map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}</select></div><div className="preview-device-controls">{([['desktop', 'Fluid', Monitor], ['laptop', '1280', Monitor], ['tablet', '768', Tablet], ['mobile', '390', Smartphone]] as const).map(([device, label, Icon]) => <button key={device} className={previewDevice === device ? 'active' : ''} title={`${label} preview`} aria-label={`${label} responsive preview`} onClick={() => setPreviewDevice(device)}><Icon size={13} /></button>)}<button className="icon-button small preview-refresh" title="Refresh preview" onClick={() => setPreviewRevision((revision) => revision + 1)}><RefreshCw size={13} /></button></div></div><div className={`preview-stage preview-${previewDevice}`}>
                {previewUrl && !bridge.previewMode ? <div className={`preview-frame-shell preview-frame-${previewDevice}`} style={{ width: previewDevice === 'desktop' ? '100%' : previewDevice === 'laptop' ? '1280px' : previewDevice === 'tablet' ? '768px' : '390px', height: previewDevice === 'mobile' ? '844px' : '100%', maxWidth: '100%' }}><iframe key={previewUrl} title={`Preview of ${previewPath}`} src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" /></div> : <div className="preview-empty-state"><div className="preview-empty-icon"><Monitor size={18} /></div><strong>{bridge.previewMode ? 'Live preview runs in the desktop app' : previewPath ? 'Preparing the page…' : 'Choose an HTML file'}</strong><p>{bridge.previewMode ? 'Open a project in the Windows app to load its HTML and local assets in the isolated browser pane.' : 'The local page and its project assets are served read-only with external network access blocked.'}</p></div>}
              </div><div className="preview-status"><span className={previewUrl && !bridge.previewMode ? 'preview-status-dot live' : 'preview-status-dot'} />{bridge.previewMode ? 'Desktop browser preview' : previewUrl ? `${previewPath} · isolated local preview` : 'Waiting for an HTML page'}</div></aside>}
            </div>
            {showTerminal && <div className="terminal-panel"><div className="terminal-header"><div><Terminal size={14} /><span>TERMINAL</span><span className="terminal-project">{state.settings.activeProjectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span></div><button className="icon-button small" title="Clear terminal" onClick={() => setTerminalOutput('Nexus Terminal · commands run in the selected project folder and require confirmation.\n')}><Trash2 size={13} /></button></div><pre className="terminal-output">{terminalOutput}</pre><form className="terminal-input-row" onSubmit={(event) => { event.preventDefault(); if (terminalInput.trim()) { setShellConfirm(terminalInput.trim()); setTerminalInput(''); } }}><span className="terminal-prompt">$</span><input value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} placeholder="Type a command…" spellCheck={false} /><button type="submit" disabled={!terminalInput.trim()} aria-label="Run command"><ArrowUp size={15} /></button></form></div>}
          </div>
        </div>}
      </section>}
      {activeTab === 'models' && <section className="models-view">
        <div className="page-heading-row"><div><div className="eyebrow">YOUR MODEL ROUTER</div><h1>One workbench. <span>Every model.</span></h1><p>Connect API providers, discover current models, or bring a GGUF model onto your device.</p></div><button className="secondary-button" onClick={() => void refreshAll()} disabled={refreshingId === 'all'}>{refreshingId === 'all' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Sync providers</button></div>
        <div className="model-tabs"><button className={modelSection === 'hosted' ? 'active' : ''} onClick={() => setModelSection('hosted')}><Cloud size={15} /> Hosted models <span>{state.providers.reduce((sum, provider) => sum + provider.models.length, 0)}</span></button><button className={modelSection === 'local' ? 'active' : ''} onClick={() => setModelSection('local')}><HardDrive size={15} /> Local GGUF <span>{localModels.length}</span></button><button className={modelSection === 'endpoints' ? 'active' : ''} onClick={() => setModelSection('endpoints')}><Workflow size={15} /> Endpoints</button><div className="model-tab-spacer" /><button className="primary-button" onClick={() => setProviderEditor(null)}><Plus size={15} /> Add provider</button></div>
        {modelSection === 'hosted' && <div className="model-section-content">
          <div className="section-lead"><div><h2>Connected providers</h2><p>Model lists come from live provider APIs; inactive providers remain visible for quick diagnosis.</p></div><div className="model-count-pill"><Activity size={13} /> {state.providers.filter((provider) => provider.status === 'active').length} active</div></div>
          <div className="provider-list">{state.providers.map((provider) => <div className="provider-group" key={provider.id}><ProviderTile provider={provider} refreshing={refreshingId === provider.id} onRefresh={() => void refreshProvider(provider.id)} onEdit={() => setProviderEditor(provider)} onRemove={!provider.isPreset ? () => void removeProvider(provider) : undefined} />{provider.models.length > 0 && <div className="model-chip-row">{provider.models.slice(0, 8).map((model) => <button key={model.id} className={`model-chip ${selectedModel?.id === model.id && selectedProvider?.id === provider.id ? 'selected' : ''}`} onClick={() => { void saveSettings({ activeProviderId: provider.id, activeModelId: model.id }); showToast(`${model.name} selected`); }}><span className="model-chip-icon"><Sparkles size={11} /></span><span>{model.name}</span>{model.isFree ? <small className="free-model-tag">FREE</small> : model.contextLength && <small>{compactNumber(model.contextLength)} ctx</small>}<ArrowUp size={12} /></button>)}{provider.models.length > 8 && <span className="more-models">+{provider.models.length - 8} more</span>}</div>}</div>)}</div>
          <div className="provider-footer-card"><div className="footer-card-icon"><Plus size={17} /></div><div><strong>Bring your own endpoint</strong><p>Works with vLLM, LM Studio, Ollama OpenAI-compatible APIs, Together, Fireworks, Groq, and more.</p></div><button className="secondary-button" onClick={() => setProviderEditor(null)}>Configure endpoint <ArrowRight size={14} /></button></div>
        </div>}
        {modelSection === 'local' && <div className="model-section-content local-model-content">
          <div className="local-model-hero"><div className="local-hero-icon"><Cpu size={22} /></div><div className="local-hero-text"><div className="eyebrow">ON-DEVICE INFERENCE</div><h2>Run your own weights.</h2><p>Launch GGUF models through llama.cpp. Vulkan acceleration is available when your llama-server build includes Vulkan support.</p></div><div className={`runtime-hero-status ${state.runtime.running ? 'online' : ''}`}><span />{state.runtime.running ? 'Runtime online' : 'Runtime offline'}</div></div>
          <div className="local-config-strip"><div><span className="config-label">LLAMA SERVER</span><strong title={state.settings.localRuntime.executablePath}>{state.settings.localRuntime.executablePath ? state.settings.localRuntime.executablePath.split(/[\\/]/).at(-1) : 'Not selected'}</strong></div><div><span className="config-label">CURRENT GGUF</span><strong title={state.settings.localRuntime.modelPath}>{state.settings.localRuntime.modelPath ? state.settings.localRuntime.modelPath.split(/[\\/]/).at(-1) : 'No model selected'}</strong></div><div><span className="config-label">CONTEXT</span><strong>{compactNumber(state.settings.localRuntime.contextTokens)} tokens</strong></div><button className="secondary-button" onClick={() => { void navigate('settings'); setSettingsSection('local'); }}><Settings size={14} /> Configure</button></div>
          <div className="hf-search-card"><div className="hf-search-header"><div><div className="eyebrow">HUGGING FACE MODEL HUB</div><h3>Find a GGUF model</h3><p>Search public GGUF repositories. Large files download to your local Nexus model library.</p></div><span className="hf-badge"><Download size={12} /> Hugging Face</span></div>
            <form className="hf-search-form" onSubmit={(event) => { event.preventDefault(); void searchHuggingFace(); }}><Search size={16} /><input value={hfQuery} onChange={(event) => setHfQuery(event.target.value)} placeholder="Search models · e.g. Qwen Coder 7B" /><button className="primary-button" type="submit" disabled={hfLoading}>{hfLoading ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />} Search GGUF</button></form>
            <div className="hf-results-grid">{hfModels.map((model) => <button className={`hf-model-card ${selectedRepo === model.id ? 'selected' : ''}`} key={model.id} onClick={() => void chooseHfRepo(model.id)}><div className="hf-model-head"><div className="hf-model-avatar"><Cpu size={16} /></div><ChevronRight size={15} /></div><strong>{model.id.split('/').at(-1)}</strong><span className="hf-model-owner">{model.id.split('/')[0]}</span><div className="hf-model-stats"><span><Download size={12} />{compactNumber(model.downloads)}</span><span><span className="like-star">✦</span>{compactNumber(model.likes)}</span><span className="gguf-label">GGUF</span></div></button>)}</div>
            {selectedRepo && <div className="repo-file-panel"><div className="repo-file-heading"><div><span className="eyebrow">QUANTIZATION FILES</span><h4>{selectedRepo}</h4></div><button className="icon-button" onClick={() => { setSelectedRepo(''); setRepoFiles([]); }} aria-label="Close file list"><X size={16} /></button></div>{hfLoading && !repoFiles.length ? <div className="inline-loading"><LoaderCircle className="spin" size={16} /> Loading repository files…</div> : repoFiles.length ? <div className="repo-file-list">{repoFiles.map((file) => <div className="repo-file-row" key={file.name}><div className="file-gguf-icon"><FileCode2 size={15} /></div><div className="repo-file-name"><strong>{file.name}</strong><small>{formatBytes(file.lfsSize || file.size)} · GGUF weights</small></div><button className="secondary-button compact" disabled={Boolean(downloadProgress)} onClick={() => void downloadModel(selectedRepo, file)}><Download size={14} /> Download</button></div>)}</div> : <div className="empty-inline">No GGUF files were found in this repository.</div>}</div>}
            {downloadProgress && <div className="download-progress-card"><div className="download-progress-label"><span><LoaderCircle size={14} className="spin" /> Downloading {downloadProgress.filename}</span><strong>{downloadProgress.percent !== undefined ? `${downloadProgress.percent}%` : formatBytes(downloadProgress.received)}</strong></div><div className="progress-track"><span style={{ width: `${downloadProgress.percent ?? Math.min(92, downloadProgress.received / 1_000_000 * 2)}%` }} /></div><small>{formatBytes(downloadProgress.received)}{downloadProgress.total ? ` of ${formatBytes(downloadProgress.total)}` : ''} · Keep Nexus open while downloading</small></div>}
          </div>
          <div className="installed-models"><div className="section-lead"><div><h2>Downloaded to this device</h2><p>Choose a GGUF file for the local runtime.</p></div><button className="icon-button" title="Refresh local models" onClick={() => void bridge.getLocalModels().then(setLocalModels)}><RefreshCw size={15} /></button></div>
            {localModels.length ? <div className="installed-model-list">{localModels.map((model) => <div className={`installed-model-row ${state.settings.localRuntime.modelPath === model.path ? 'selected' : ''}`} key={model.path}><div className="file-gguf-icon"><HardDrive size={15} /></div><div className="installed-model-name"><strong>{model.name}</strong><small>{formatBytes(model.size)} · {model.path}</small></div>{state.settings.localRuntime.modelPath === model.path ? <span className="selected-badge"><CheckCircle2 size={13} /> Selected</span> : <button className="secondary-button compact" disabled={state.runtime.running} onClick={() => { void bridge.selectLocalModel(model.path).then(setState).then(() => showToast('Local model selected')).catch((error) => showToast(error instanceof Error ? error.message : 'Could not select model.')); }}>Use model</button>}</div>)}</div> : <div className="empty-models"><HardDrive size={18} /><span>No local GGUF files found yet.</span><small>Download a model above or choose a file in Local runtime settings.</small></div>}
          </div>
        </div>}
        {modelSection === 'endpoints' && <div className="model-section-content"><div className="section-lead"><div><h2>Endpoint health</h2><p>Saved provider base URLs and their latest connectivity check.</p></div><button className="secondary-button" onClick={() => void refreshAll()}><RefreshCw size={14} /> Check all</button></div><div className="endpoint-table"><div className="endpoint-table-head"><span>PROVIDER</span><span>BASE URL</span><span>MODELS</span><span>STATUS</span><span /></div>{state.providers.map((provider) => <div className="endpoint-row" key={provider.id}><div className="endpoint-provider"><div className={`provider-mark tiny provider-mark-${provider.id}`}>{providerInitial(provider.name)}</div><strong>{provider.name}</strong></div><code title={provider.baseUrl}>{provider.baseUrl}</code><span>{provider.models.length}</span><span className={`endpoint-status ${provider.status}`}><StatusDot status={provider.status} />{provider.status === 'active' ? 'Active' : provider.status === 'inactive' ? 'Inactive' : 'Not checked'}</span><button className="icon-button" onClick={() => void refreshProvider(provider.id)} title="Test endpoint">{refreshingId === provider.id ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button></div>)}</div><div className="endpoint-security-note"><Shield size={15} /> Endpoint requests are made by the desktop process. The renderer never receives provider keys.</div></div>}
      </section>}

      {activeTab === 'settings' && <section className="settings-view">
        <div className="settings-sidebar"><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Shape your workspace.</p><nav>{([
          ['general', 'General', SlidersHorizontal], ['providers', 'Providers', KeyRound], ['tools', 'Tools & safety', Shield], ['local', 'Local runtime', Cpu], ['advanced', 'Advanced', Gauge], ['updates', 'Updates', RefreshCw],
        ] as const).map(([key, label, Icon]) => <button key={key} className={settingsSection === key ? 'active' : ''} onClick={() => setSettingsSection(key)}><Icon size={16} />{label}{settingsSection === key && <ChevronRight size={14} />}</button>)}</nav><div className="settings-sidebar-foot"><LockKeyhole size={14} /><span>Keys are encrypted locally</span></div></div>
        <div className="settings-content">
          {settingsSection === 'general' && <div className="settings-panel"><div className="settings-panel-head"><div className="eyebrow">BASIC PREFERENCES</div><h2>Make it yours.</h2><p>Choose how Nexus looks and how much context each conversation can use.</p></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Appearance</h3><p>Follow your system preference or choose a fixed theme.</p></div></div><div className="theme-options">{([['system', 'System', MonitorGlyph], ['dark', 'Dark', Moon], ['light', 'Light', Sun]] as const).map(([theme, label, Icon]) => <button key={theme} className={`theme-card ${state.settings.theme === theme ? 'selected' : ''}`} onClick={() => void saveSettings({ theme })}><div className={`theme-preview theme-${theme}`}><span /><span /><span /><i /></div><div className="theme-card-label"><Icon size={14} /><span>{label}</span>{state.settings.theme === theme && <CheckCircle2 size={14} />}</div></button>)}</div></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Interface zoom</h3><p>Scale the whole workbench. Keyboard shortcuts: Ctrl +, Ctrl −, and Ctrl 0.</p></div></div><div className="zoom-settings-row"><div className="zoom-controls"><button className="icon-button" aria-label="Zoom out" title="Zoom out" disabled={state.settings.zoomPercent <= 75} onClick={() => void saveSettings({ zoomPercent: Math.max(75, state.settings.zoomPercent - 10) })}><Minus size={15} /></button><strong>{state.settings.zoomPercent}%</strong><button className="icon-button" aria-label="Zoom in" title="Zoom in" disabled={state.settings.zoomPercent >= 150} onClick={() => void saveSettings({ zoomPercent: Math.min(150, state.settings.zoomPercent + 10) })}><Plus size={15} /></button><button className="secondary-button compact" onClick={() => void saveSettings({ zoomPercent: 100 })}>Reset</button></div><span>75%–150%</span></div></div>
            <div className="settings-block settings-block-tight"><div className="block-heading"><div><h3>Startup & discovery</h3><p>Keep provider and model lists fresh without interrupting chat.</p></div></div><Toggle checked={state.settings.autoFetchModels} onChange={(autoFetchModels) => void saveSettings({ autoFetchModels })} title="Fetch connected provider models on startup" description="Refreshes model lists for providers with saved keys when Nexus opens." /><Toggle checked={state.settings.autoDiscoverProviders} onChange={(autoDiscoverProviders) => void saveSettings({ autoDiscoverProviders })} title="Discover providers automatically" description="Checks the provider directory for new compatible APIs; you choose which providers to add." /></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Default model</h3><p>Used for new conversations. You can switch models at any time.</p></div></div><div className="form-row two-col"><label className="field-label">Provider<select value={state.settings.activeProviderId} onChange={(event) => void selectProvider(event.target.value)}>{state.providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><label className="field-label">Model<select value={selectedModel?.id || ''} onChange={(event) => void saveSettings({ activeModelId: event.target.value })}>{selectedProvider?.models.length ? selectedProvider.models.map((model) => <option value={model.id} key={model.id}>{model.name}{model.isFree ? ' · Free' : ''}</option>) : <option value="">No models available — fetch provider models</option>}</select></label></div></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Context & output</h3><p>Controls local context size and the maximum response length requested from a provider.</p></div></div><div className="range-setting"><div><span>Context window</span><strong>{Number(state.settings.contextTokens).toLocaleString()} tokens</strong></div><input type="range" min="2048" max="131072" step="1024" value={state.settings.contextTokens} onChange={(event) => void saveSettings({ contextTokens: Number(event.target.value) })} /><div className="range-labels"><span>2K</span><span>128K</span></div></div><div className="form-row two-col"><label className="field-label">Max output tokens<input type="number" min="256" max="65536" step="256" value={state.settings.maxOutputTokens} onChange={(event) => void saveSettings({ maxOutputTokens: Math.max(256, Number(event.target.value)) })} /></label><label className="field-label">Temperature <span className="field-value-inline">{state.settings.temperature.toFixed(1)}</span><input type="range" min="0" max="2" step="0.1" value={state.settings.temperature} onChange={(event) => void saveSettings({ temperature: Number(event.target.value) })} /></label></div></div>
          </div>}
          {settingsSection === 'providers' && <div className="settings-panel"><div className="settings-panel-head settings-head-actions"><div><div className="eyebrow">CLOUD & CUSTOM APIS</div><h2>Provider connections.</h2><p>Keys are encrypted by Windows DPAPI on Windows. Provider requests run in the isolated desktop main process.</p></div><button className="primary-button" onClick={() => setProviderEditor(null)}><Plus size={15} /> Add provider</button></div>
            <div className="provider-mode-bar">
              <div className="provider-view-tabs"><button className={providerView === 'connected' ? 'active' : ''} onClick={() => setProviderView('connected')}>Connected <span>{state.providers.length}</span></button><button className={providerView === 'discover' ? 'active' : ''} onClick={() => { setProviderView('discover'); if (!providerCatalog) void loadProviderCatalog(false); }}>Discover providers <span>{providerCatalog?.entries.length || '↗'}</span></button></div>
              {providerView === 'discover' && <button className="secondary-button compact" onClick={() => void loadProviderCatalog(true)} disabled={catalogLoading}>{catalogLoading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Refresh catalog</button>}
            </div>
            {providerView === 'connected' ? <>
              <div className="provider-list settings-provider-list">{state.providers.map((provider) => <ProviderTile key={provider.id} provider={provider} refreshing={refreshingId === provider.id} onRefresh={() => void refreshProvider(provider.id)} onEdit={() => setProviderEditor(provider)} onRemove={!provider.isPreset ? () => void removeProvider(provider) : undefined} />)}</div>
              <div className="provider-presets-note"><span className="preset-spark"><Sparkles size={15} /></span><div><strong>Bring your own endpoint</strong><p>Discover compatible hosted APIs or add any OpenAI-compatible, Anthropic, or Gemini endpoint. Local Ollama and LM Studio endpoints are supported too.</p></div><button className="secondary-button compact" onClick={() => { setProviderView('discover'); if (!providerCatalog) void loadProviderCatalog(false); }}>Browse directory <ArrowRight size={13} /></button></div>
            </> : <div className="provider-directory">
              <div className="catalog-toolbar"><label className="catalog-search"><Search size={15} /><input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Search providers or endpoint names…" /></label><button className={`catalog-free-filter ${freeOnly ? 'selected' : ''}`} onClick={() => setFreeOnly(!freeOnly)}><Sparkles size={14} /> Free access</button></div>
              <div className="catalog-summary"><span>{providerCatalog?.source === 'live' ? 'Live provider catalog' : providerCatalog?.source === 'cache' ? 'Cached provider catalog' : 'Built-in provider directory'} · {providerCatalog?.entries.length || 0} compatible endpoints</span>{catalogLoading && <span><LoaderCircle size={12} className="spin" /> Checking for updates…</span>}</div>
              {providerCatalog?.warning && <div className="catalog-warning"><CircleHelp size={14} />{providerCatalog.warning} Showing cached or built-in providers so you can keep working.</div>}
              <div className="provider-directory-grid">{filteredCatalogEntries.map((entry) => {
                const addedProvider = state.providers.find((provider) => provider.id === entry.id);
                return <article className="catalog-provider-card" key={entry.id}>
                  <div className="catalog-card-heading"><div className={`provider-mark provider-mark-${entry.id}`}>{providerInitial(entry.name)}</div><div className="catalog-card-title"><strong>{entry.name}</strong><small>{entry.id} · {entry.kind === 'openai-compatible' ? 'OpenAI-compatible' : entry.kind === 'gemini' ? 'Gemini API' : 'Anthropic API'}</small></div>{entry.freeModelCount > 0 ? <span className="free-count-badge">{entry.freeModelCount} free</span> : entry.freeTierHint ? <span className="free-hint-badge">Free access</span> : null}</div>
                  <div className="catalog-card-meta"><span>{entry.modelCount ? `${entry.modelCount} catalog models` : 'Live models load after connecting'}</span><span className="catalog-meta-dot">·</span><span>{entry.baseUrl.replace(/^https?:\/\//, '')}</span></div>
                  <p>{entry.freeModelCount > 0 ? 'Zero-priced models are listed in the catalog; account access and rate limits are set by the provider.' : entry.freeTierHint || 'Add a provider key to discover its current live model list.'}</p>
                  {entry.models.length > 0 && <div className="catalog-model-samples">{entry.models.slice(0, 3).map((model) => <span key={model.id} title={model.id}>{model.name}{model.isFree && <i>FREE</i>}</span>)}</div>}
                  <button className={addedProvider ? 'secondary-button compact catalog-add-button' : 'primary-button catalog-add-button'} onClick={() => addedProvider ? setProviderEditor(addedProvider) : void addCatalogProvider(entry)} disabled={addingProviderId === entry.id}>
                    {addingProviderId === entry.id ? <LoaderCircle size={14} className="spin" /> : addedProvider ? <KeyRound size={14} /> : <Plus size={14} />}{addingProviderId === entry.id ? 'Adding…' : addedProvider ? (addedProvider.hasKey ? 'Manage connection' : 'Connect provider') : 'Add & connect'}
                  </button>
                </article>;
              })}{!filteredCatalogEntries.length && <div className="catalog-empty"><Search size={18} /><strong>No matching providers</strong><span>Try another search, or add a custom endpoint.</span><button className="secondary-button compact" onClick={() => setProviderEditor(null)}><Plus size={13} /> Custom endpoint</button></div>}</div>
              <p className="catalog-disclaimer">Nexus refreshes this community catalog automatically. Free availability is not guaranteed: provider limits, pricing, and model availability can change at any time.</p>
            </div>}
          </div>}
          {settingsSection === 'tools' && <div className="settings-panel"><div className="settings-panel-head"><div className="eyebrow">AGENT BEHAVIOR</div><h2>Capability, with control.</h2><p>Built-in project tools, scoped approvals, and connected MCP servers all appear to the model only when agent tools are enabled.</p></div>
            <div className="settings-block settings-block-tight"><Toggle checked={state.settings.enableTools} onChange={(enableTools) => void saveSettings({ enableTools })} title="Enable agent tools" description="Allow available project, shell, and connected MCP tools to be called by the model." /><Toggle checked={state.settings.confirmToolCalls} onChange={(confirmToolCalls) => void saveSettings({ confirmToolCalls })} title="Ask before tool use" description="Request approval for ordinary tool calls too. Writes, shell, and MCP calls still require approval unless that exact tool has an allow rule." /><Toggle checked={state.settings.allowShellWithoutProject} onChange={(allowShellWithoutProject) => void saveSettings({ allowShellWithoutProject })} title="Allow shell commands without a project" description="When enabled, shell starts in your home folder and can access anything your Windows account can access. Approval is still required unless you explicitly allow run_shell." /></div>
            <div className="tool-permissions"><div className="tool-permission-title"><Shield size={16} /><strong>Built-in tool scope</strong></div><div className="permission-row"><span className="permission-icon read"><Eye size={14} /></span><div><strong>Read files & search code</strong><small>Only inside an open project. Without a project these tools are not offered.</small></div><span className="permission-pill">Project-scoped</span></div><div className="permission-row"><span className="permission-icon write"><FileCode2 size={14} /></span><div><strong>Create or edit a file</strong><small>Project-only paths; approval card previews the target and contents.</small></div><span className="permission-pill approval">Approval-gated</span></div><div className="permission-row"><span className="permission-icon shell"><Terminal size={14} /></span><div><strong>Run a shell command</strong><small>{state.settings.activeProjectPath ? 'Runs from the open project folder.' : state.settings.allowShellWithoutProject ? 'Runs from your home folder; can list drives and other accessible paths.' : 'Unavailable until home-folder shell access is explicitly enabled.'} 60-second limit.</small></div><span className={`permission-pill ${state.settings.allowShellWithoutProject ? 'approval' : ''}`}>{state.settings.allowShellWithoutProject ? 'Home access on' : 'Home access off'}</span></div></div>
            <div className="settings-block approval-rules-block"><div className="block-heading"><div><h3>Approval rules</h3><p>“Always allow” rules apply only to the named tool and remain editable here. Session approvals clear when the app closes.</p></div></div><div className="approval-rule-section"><div className="approval-rule-heading"><strong>Always allowed</strong><span>{state.settings.alwaysAllowTools.length}</span></div>{state.settings.alwaysAllowTools.length ? <div className="approval-rule-list">{state.settings.alwaysAllowTools.map((key) => <div className="approval-rule-row" key={key}><span><CheckCircle2 size={13} />{approvalToolLabel(key, state.mcpServers)}</span><button className="icon-button small danger-hover" title="Revoke always-allow rule" onClick={() => void saveSettings({ alwaysAllowTools: state.settings.alwaysAllowTools.filter((item) => item !== key) })}><X size={14} /></button></div>)}</div> : <p className="permission-empty">No persistent tool allow rules.</p>}</div><div className="approval-rule-section"><div className="approval-rule-heading"><strong>Allowed for this session</strong><span>{state.sessionAllowedTools.length}</span></div>{state.sessionAllowedTools.length ? <div className="approval-rule-list">{state.sessionAllowedTools.map((key) => <div className="approval-rule-row" key={key}><span><CheckCircle2 size={13} />{approvalToolLabel(key, state.mcpServers)}</span></div>)}</div> : <p className="permission-empty">No session approvals yet.</p>}<button className="secondary-button compact" disabled={!state.sessionAllowedTools.length} onClick={() => void bridge.clearSessionPermissions().then(setState)}>Clear session approvals</button></div></div>
            <div className="safety-callout"><LockKeyhole size={17} /><div><strong>Nothing runs silently by default.</strong><p>Tool requests are shown in chat. Project file tools reject paths and symlinks outside the open folder. “Always allow” is an explicit per-tool opt-in; revoke it above at any time.</p></div></div>

            <div className="mcp-section"><div className="mcp-section-heading"><div><div className="eyebrow">PLUGINS & CONNECTED TOOLS</div><h3>MCP servers</h3><p>Use local stdio commands or remote Streamable HTTP / legacy SSE servers. Discovered tools, resources, and prompts can be exposed to the model.</p></div><button className="primary-button compact" onClick={() => { setMcpPreset(null); setMcpEditor(null); }}><Plus size={14} /> Add server</button></div>
              <div className="mcp-recommendation"><div className="mcp-recommendation-icon"><Puzzle size={16} /></div><div><strong>Browser automation with Playwright MCP</strong><p>Preset: <code>npx -y @playwright/mcp@latest</code>. Adds page navigation, snapshots, interactions, and screenshots through discovered MCP tools.</p></div><button className="secondary-button compact" onClick={() => { setMcpEditor(null); setMcpPreset({ id: 'playwright', name: 'Playwright Browser', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: false }); }}><Plus size={13} /> Add preset</button></div>
              <div className="mcp-recommendation context7-recommendation"><div className="mcp-recommendation-icon"><BookOpen size={16} /></div><div><strong>Current library docs with Context7</strong><p>Remote Streamable HTTP preset at <code>https://mcp.context7.com/mcp</code>. No local package install is needed; an API key can be added as an encrypted header if you have one.</p></div><button className="secondary-button compact" onClick={() => { setMcpEditor(null); setMcpPreset({ id: 'context7', name: 'Context7 Docs', transport: 'streamable-http', url: 'https://mcp.context7.com/mcp', enabled: false }); }}><Plus size={13} /> Add preset</button></div>
              <div className="mcp-security-note"><Shield size={14} /><span>Local server commands are not sandboxed. The Playwright preset downloads and runs code through npx when you explicitly Connect; inspect sources and approvals before use.</span></div>
              {state.mcpServers.length ? <div className="mcp-server-list">{state.mcpServers.map((server) => {
                const enabledTools = server.tools.filter((tool) => tool.enabled).length;
                const transportLabel = server.transport === 'stdio' ? 'Local stdio' : server.transport === 'sse' ? 'Remote SSE' : 'Streamable HTTP';
                return <article className={`mcp-server-card status-${server.status}`} key={server.id}>
                  <div className="mcp-server-header"><span className="mcp-server-icon"><Server size={16} /></span><div className="mcp-server-title"><strong>{server.name}</strong><small>{server.id} · {transportLabel}{server.serverVersion ? ` · ${server.serverVersion}` : ''}</small></div><span className={`mcp-status-pill ${server.status}`}><i />{server.status === 'connected' ? 'Connected' : server.status === 'connecting' ? 'Connecting' : server.status === 'error' ? 'Error' : server.enabled ? 'Enabled · offline' : 'Disconnected'}</span></div>
                  <code className="mcp-command-line" title={server.transport === 'stdio' ? `${server.command || ''} ${(server.args || []).join(' ')}` : server.url}>{server.transport === 'stdio' ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim() : server.url}</code>
                  <div className="mcp-capability-summary"><span><Workflow size={13} />{enabledTools} / {server.tools.length} exposed</span><span><BookOpen size={13} />{server.resources.length} resources</span><span><Sparkles size={13} />{server.prompts.length} prompts</span>{(server.environmentKeys.length + server.headerKeys.length) > 0 && <span><LockKeyhole size={12} />{server.environmentKeys.length + server.headerKeys.length} encrypted values</span>}</div>
                  {server.lastError && <div className="mcp-error"><CircleHelp size={13} />{server.lastError}</div>}
                  {server.tools.length > 0 && <details className="mcp-capabilities"><summary>{server.tools.length} model capabilities · click to manage</summary><div className="mcp-capability-list">{server.tools.map((tool) => <div className={`mcp-capability-row ${tool.enabled ? '' : 'disabled'}`} key={tool.key}><span className={`mcp-kind-pill ${tool.kind}`}>{tool.kind}</span><div><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</div><button className={`capability-toggle ${tool.enabled ? 'enabled' : ''}`} onClick={() => void setMcpCapability(server, tool.key, !tool.enabled)}>{tool.enabled ? 'On' : 'Off'}</button></div>)}</div></details>}
                  <div className="mcp-server-actions"><button className="secondary-button compact" onClick={() => { setMcpPreset(null); setMcpEditor(server); }}>Edit</button><button className="secondary-button compact" disabled={bridge.previewMode || server.status === 'connecting'} onClick={() => server.status === 'connected' ? void disconnectMcpServer(server) : void connectMcpServer(server)}>{server.status === 'connecting' ? <LoaderCircle size={13} className="spin" /> : server.status === 'connected' ? <Unplug size={13} /> : <PlugZap size={13} />}{server.status === 'connected' ? 'Disconnect' : server.status === 'error' ? 'Retry' : 'Connect'}</button><button className="icon-button small" title="Refresh discovered MCP capabilities" disabled={server.status !== 'connected'} onClick={() => void refreshMcpServer(server)}><RefreshCw size={14} /></button><button className="icon-button small danger-hover" title="Remove server and encrypted secrets" onClick={() => void removeMcpServer(server)}><Trash2 size={14} /></button></div>
                </article>;
              })}</div> : <div className="mcp-empty"><Puzzle size={17} /><strong>No MCP servers connected yet</strong><span>Add a local or remote server. Its discovered capabilities will appear here and become available to the model when connected.</span></div>}
            </div>
          </div>}
          {settingsSection === 'local' && <div className="settings-panel"><div className="settings-panel-head settings-head-actions"><div><div className="eyebrow">LOCAL INFERENCE · LLAMA.CPP</div><h2>Your model, your machine.</h2><p>Point Nexus at a llama.cpp server binary and a GGUF file. The executable is never downloaded or run without your choice.</p></div><span className={`runtime-pill ${state.runtime.running ? 'online' : ''}`}><span />{state.runtime.running ? 'ONLINE' : 'OFFLINE'}</span></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Runtime files</h3><p>Use a llama.cpp build that includes the backend you want (for example, Vulkan).</p></div></div><div className="path-picker-row"><div className="path-picker-icon"><Command size={16} /></div><div className="path-picker-copy"><strong>llama-server executable</strong><small title={state.settings.localRuntime.executablePath}>{state.settings.localRuntime.executablePath || 'No executable selected'}</small></div><button className="secondary-button compact" disabled={state.runtime.running} onClick={() => void setRuntimePath()}><FolderOpen size={14} /> Browse</button></div><div className="path-picker-row"><div className="path-picker-icon model"><HardDrive size={16} /></div><div className="path-picker-copy"><strong>GGUF model file</strong><small title={state.settings.localRuntime.modelPath}>{state.settings.localRuntime.modelPath || 'No GGUF selected'}</small></div><button className="secondary-button compact" disabled={state.runtime.running} onClick={() => void setLocalModelPath()}><FolderOpen size={14} /> Browse</button></div></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Performance</h3><p>GPU options depend on your llama.cpp build and hardware. Changes take effect when the runtime next starts.</p></div></div><div className="form-row two-col"><label className="field-label">Backend<select value={state.settings.localRuntime.gpuBackend} onChange={(event) => patchLocalRuntime({ gpuBackend: event.target.value as AppSettings['localRuntime']['gpuBackend'] })}><option value="auto">Auto-detect</option><option value="cpu">CPU only</option><option value="vulkan">Vulkan</option><option value="cuda">CUDA</option></select></label><label className="field-label">GPU device name<input value={state.settings.localRuntime.deviceName} onChange={(event) => patchLocalRuntime({ deviceName: event.target.value })} placeholder="Vulkan0" /><small>Passed to llama-server as <code>--device</code>.</small></label></div><div className="form-row two-col"><label className="field-label">Context window<input type="number" min="512" max="1048576" step="512" value={state.settings.localRuntime.contextTokens} onChange={(event) => patchLocalRuntime({ contextTokens: Math.max(512, Number(event.target.value)) })} /><small>Passed to llama-server as <code>--ctx-size</code>.</small></label><label className="field-label">GPU layers<input type="number" min="0" max="999" value={state.settings.localRuntime.gpuLayers} onChange={(event) => patchLocalRuntime({ gpuLayers: Math.max(0, Math.min(999, Number(event.target.value))) })} /><small>Offload layers to GPU; set 0 for CPU-only.</small></label></div><label className="field-label port-field">Local server port<input type="number" min="1024" max="65535" disabled={state.runtime.running} value={state.settings.localRuntime.port} onChange={(event) => patchLocalRuntime({ port: Math.max(1024, Math.min(65535, Number(event.target.value))) })} /><small>Server binds to 127.0.0.1 only.</small></label></div>
            <div className="runtime-action-card"><div className="runtime-action-copy"><span className={`runtime-led ${state.runtime.running ? 'online' : ''}`} /><div><strong>{state.runtime.running ? 'Local model is running' : 'Ready to launch locally'}</strong><small>{state.runtime.message}</small></div></div>{state.runtime.running ? <button className="danger-button" onClick={() => void stopRuntime()}><Square size={13} fill="currentColor" /> Stop runtime</button> : <button className="primary-button" onClick={() => void startRuntime()}><Play size={14} fill="currentColor" /> Start local model</button>}</div>
            <div className="runtime-logs"><div className="runtime-logs-head"><Terminal size={13} /> RUNTIME OUTPUT</div><pre>{runtimeLogs.length ? runtimeLogs.slice(-80).join('\n') : 'Runtime output will appear here when llama-server starts.'}</pre></div>
          </div>}
          {settingsSection === 'advanced' && <div className="settings-panel"><div className="settings-panel-head"><div className="eyebrow">ADVANCED GENERAL</div><h2>Fine-tune your setup.</h2><p>Set the live provider catalog source, model behavior, and advanced access options.</p></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Hugging Face access</h3><p>A token is optional for public GGUF files. Use one for gated models or higher API limits.</p></div><span className={`token-state ${state.settings.hfTokenSet ? 'set' : ''}`}><span />{state.settings.hfTokenSet ? 'Token saved' : 'Optional'}</span></div><form className="hf-token-form" onSubmit={(event) => void saveHfToken(event)}><span className="secret-input"><input type="password" autoComplete="new-password" value={hfTokenInput} onChange={(event) => setHfTokenInput(event.target.value)} placeholder={state.settings.hfTokenSet ? 'Saved securely · paste a new token to replace' : 'hf_…'} /><KeyRound size={15} /></span><button className="secondary-button" type="submit" disabled={!hfTokenInput.trim()}><LockKeyhole size={14} /> Save token</button>{state.settings.hfTokenSet && <button type="button" className="icon-button danger-hover" title="Remove saved token" onClick={() => { void bridge.setHuggingFaceToken('').then(setState); showToast('Hugging Face token removed'); }}><Trash2 size={15} /></button>}</form><p className="field-help">Stored encrypted via OS-backed secure storage. Do not use a token with write permissions unless required.</p></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Default agent temperature</h3><p>Lower is more deterministic; higher is more exploratory.</p></div><strong className="value-badge">{state.settings.temperature.toFixed(1)}</strong></div><input className="full-range" type="range" min="0" max="2" step="0.1" value={state.settings.temperature} onChange={(event) => void saveSettings({ temperature: Number(event.target.value) })} /></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Provider catalog source</h3><p>Nexus reads a models.dev-compatible JSON directory to discover new supported providers and model metadata.</p></div><span className="token-state set"><span />{providerCatalog?.source === 'live' ? 'Live' : providerCatalog?.source === 'cache' ? 'Cached' : 'Built-in'}</span></div><label className="field-label">HTTPS catalog URL<input value={providerCatalogUrlDraft} onChange={(event) => setProviderCatalogUrlDraft(event.target.value)} placeholder="https://models.dev/api.json" spellCheck={false} /><small>Catalog sync is read-only. Provider keys are never sent to this catalog.</small></label><div className="catalog-url-action-row"><span>{providerCatalog?.fetchedAt ? `Updated ${dateLabel(providerCatalog.fetchedAt)}` : 'Not synced yet'}</span><button className="secondary-button" onClick={() => void saveProviderCatalogUrl()} disabled={catalogLoading}>{catalogLoading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />} Save & fetch</button></div></div>
            <div className="settings-block"><div className="block-heading"><div><h3>Default system prompt</h3><p>Advanced instructions sent with each model request. Keep provider-specific rules here if needed.</p></div></div><textarea className="system-prompt-editor" value={systemPromptDraft} onChange={(event) => setSystemPromptDraft(event.target.value)} rows={7} maxLength={20_000} spellCheck={false} /><div className="system-prompt-footer"><small>{systemPromptDraft.length.toLocaleString()} / 20,000 characters</small><div><button className="secondary-button compact" onClick={() => { setSystemPromptDraft(DEFAULT_SYSTEM_PROMPT); void saveSettings({ systemPrompt: DEFAULT_SYSTEM_PROMPT }); }}>Reset default</button><button className="primary-button compact" onClick={() => { void saveSettings({ systemPrompt: systemPromptDraft }); showToast('System prompt saved'); }} disabled={systemPromptDraft === state.settings.systemPrompt}><Check size={13} /> Save prompt</button></div></div></div>
            <div className="advanced-note"><BadgeCheck size={16} /><div><strong>Automatic discovery stays provider-controlled.</strong><p>Nexus fetches model catalogs from each endpoint you configure; it does not silently scrape providers or install executable runtimes. GGUF model files are downloaded only after you pick a repository file.</p></div></div>
          </div>}
          {settingsSection === 'updates' && <UpdatePanel status={updateStatus} busy={updateBusy} onCheck={() => void checkSoftwareUpdates()} onDownload={() => void downloadSoftwareUpdate()} onInstall={() => void installSoftwareUpdate()} />}
        </div>
      </section>}
    </main>

    <nav className="mobile-nav" aria-label="Mobile navigation">
      <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}><MessageSquare size={17} /><span>Chat</span></button>
      <button className={activeTab === 'workspace' ? 'active' : ''} onClick={() => setActiveTab('workspace')}><Code2 size={17} /><span>Workspace</span></button>
      <button className={activeTab === 'models' ? 'active' : ''} onClick={() => setActiveTab('models')}><Workflow size={17} /><span>Models</span></button>
      <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}><Settings size={17} /><span>Settings</span></button>
    </nav>

    {showNewFile && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNewFile(false); }}><form className="modal new-file-modal" onSubmit={(event) => void createProjectFile(event)}><div className="modal-header"><div><div className="eyebrow">PROJECT FILE</div><h2>Create a new file.</h2></div><button type="button" className="icon-button" onClick={() => setShowNewFile(false)} aria-label="Close"><X size={18} /></button></div><p className="modal-copy">The file will be created inside the selected project folder.</p><label className="field-label">Relative path<input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="src/new-feature.ts" spellCheck={false} required /></label><div className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowNewFile(false)}>Cancel</button><button type="submit" className="primary-button"><FilePlus2 size={15} /> Create file</button></div></form></div>}
    {providerEditor !== undefined && <ProviderEditor initial={providerEditor || undefined} onClose={() => setProviderEditor(undefined)} onSave={(form) => void saveProvider(form)} />}
    {mcpEditor !== undefined && <McpEditor initial={mcpEditor || undefined} preset={mcpPreset} onClose={() => { setMcpEditor(undefined); setMcpPreset(null); }} onSave={(input) => void saveMcpServer(input)} />}
    {pendingTool && <div className="modal-backdrop"><div className="modal approval-modal"><div className="modal-header"><div><div className="eyebrow approval-eyebrow"><Shield size={13} /> MODEL REQUESTED ACTION</div><h2>Allow this tool?</h2></div><button className="icon-button" onClick={() => void respondTool('deny')} aria-label="Dismiss"><X size={18} /></button></div><p className="modal-copy">The assistant wants to use <strong>{pendingTool.label || pendingTool.name}</strong>. Review the details before choosing how broadly to allow it.</p><div className="approval-description">{pendingTool.description}</div><div className="approval-args">{renderToolArguments(pendingTool)}</div><div className="approval-warning"><Shield size={14} /> Always allow saves a rule for this specific tool. Shell and MCP tools run with your account’s permissions.</div><div className="modal-footer approval-choices"><button className="secondary-button" onClick={() => void respondTool('deny')}>Deny</button><button className="secondary-button" onClick={() => void respondTool('once')}>Allow once</button><button className="secondary-button" onClick={() => void respondTool('session')}>For session</button><button className="primary-button" onClick={() => void respondTool('always')}><Check size={15} /> Always allow</button></div></div></div>}
    {pendingQuestion && <div className="modal-backdrop"><div className="modal question-modal"><div className="modal-header"><div><div className="eyebrow">YOUR INPUT NEEDED</div><h2>Quick question</h2></div><button className="icon-button" onClick={() => void answerQuestion('The user skipped this question.')} aria-label="Skip question"><X size={18} /></button></div><p className="modal-copy">{pendingQuestion.question}</p>{pendingQuestion.options.map((option) => <button className="question-option" key={option.id} onClick={() => void answerQuestion(option.label)}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}<label className="field-label">Or write an answer<textarea value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} rows={3} maxLength={8000} autoFocus placeholder="Type your answer…" /></label><div className="modal-footer"><button className="secondary-button" onClick={() => void answerQuestion('The user skipped this question.')}>Skip</button><button className="primary-button" disabled={!questionDraft.trim()} onClick={() => void answerQuestion(questionDraft.trim())}><Send size={14} /> Send answer</button></div></div></div>}
    {shellConfirm && <div className="modal-backdrop"><div className="modal shell-confirm-modal"><div className="modal-header"><div><div className="eyebrow approval-eyebrow"><Terminal size={13} /> SHELL COMMAND</div><h2>Run this command?</h2></div><button className="icon-button" onClick={() => setShellConfirm('')} aria-label="Cancel"><X size={18} /></button></div><p className="modal-copy">This command will run in <strong>{shellDirectoryLabel}</strong>. Commands can access anything permitted to your account.</p><pre className="shell-command-preview">{shellConfirm}</pre><div className="approval-warning"><Shield size={14} /> Commands are executed on your machine. Check before continuing.</div><div className="modal-footer"><button className="secondary-button" onClick={() => setShellConfirm('')}>Cancel</button><button className="primary-button" onClick={() => void executeShell()} disabled={!state.settings.activeProjectPath && !state.settings.allowShellWithoutProject}><Play size={14} fill="currentColor" /> Run command</button></div></div></div>}
    {toast && <div className="toast"><CheckCircle2 size={15} />{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>;
}

function TreeFileIcon({ extension }: { extension: string }) {
  const code = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.cpp', '.c', '.java', '.css', '.html'].includes(extension.startsWith('.') ? extension : `.${extension}`);
  if (code) return <FileCode2 size={14} className={`file-icon file-${extension.replace('.', '')}`} />;
  if (['.md', '.txt', '.json', '.yaml', '.yml', '.toml'].includes(extension.startsWith('.') ? extension : `.${extension}`)) return <FileText size={14} className="file-icon" />;
  return <File size={14} className="file-icon" />;
}

function renderToolArguments(tool: ToolRequest) {
  const args = tool.arguments;
  if (tool.name === 'default_shell' || tool.name === 'run_shell') return <pre className="shell-command-preview">{String(args.command || '(empty command)')}</pre>;
  if (tool.name === 'default_write' || tool.name === 'write_file') return <div className="write-preview"><div><FileCode2 size={14} /><strong>{String(args.path || 'unknown file')}</strong></div><pre>{String(args.content || '').slice(0, 6000)}{String(args.content || '').length > 6000 ? '\n… preview truncated …' : ''}</pre></div>;
  if (tool.name === 'default_edit') return <div className="write-preview"><div><FileCode2 size={14} /><strong>{String(args.path || 'unknown file')} · exact text edit</strong></div><pre>− {String(args.old_text || '').slice(0, 2500)}\n+ {String(args.new_text || '').slice(0, 2500)}</pre></div>;
  return <pre className="json-preview">{JSON.stringify(args, null, 2)}</pre>;
}

function MonitorGlyph({ size = 14 }: { size?: number }) { return <LayoutGrid size={size} />; }

export default App;
