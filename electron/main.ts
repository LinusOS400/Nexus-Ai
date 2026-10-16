import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StateStore } from './store';
import { ChatSessionStore } from './chat-store';
import { createToolRequest, getBuiltinToolDefinitions, streamProviderChat, TOOL_NAMES } from './ai';
import { McpManager } from './mcp';
import { buildCodeModeDescription, executeCodeMode } from './code-mode';
import { DEFAULT_PROVIDER_CATALOG_URL, getProviderCatalog as loadProviderCatalog } from './provider-catalog';
import { initializeUpdateManager } from './update-manager';
import type { AppSettings, ChatEvent, ChatRequest, HuggingFaceFile, HuggingFaceModel, McpServerSaveInput, ModelInfo, ProviderCatalogResult, ProviderInfo, ProviderKind, RuntimeStatus, ToolApprovalChoice, ToolDefinition, ToolRequest, ToolTrace } from '../shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'nexus-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let mainWindow: BrowserWindow | null = null;
let store: StateStore;
let chatSessionStore: ChatSessionStore;
let mcpManager: McpManager | null = null;
let runtimeProcess: ChildProcessWithoutNullStreams | null = null;
let runtimeStatus: RuntimeStatus = { running: false, message: 'Local runtime stopped', baseUrl: 'http://127.0.0.1:8080/v1' };
let previewRoot = '';
let previewToken = '';
const previewOverrides = new Map<string, string>();
const activeChats = new Map<string, AbortController>();
let rendererRestartAttempts = 0;
const sessionAllowedTools = new Set<string>();
const pendingToolApprovals = new Map<string, { resolve: (decision: ToolApprovalChoice) => void; requestId: string; approvalKey: string; senderId: number }>();
const pendingQuestions = new Map<string, { resolve: (answer: string) => void; requestId: string; senderId: number }>();
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.venv', '__pycache__']);
const providerCatalogCache = new Map<string, { result: ProviderCatalogResult; loadedAt: number }>();

function currentState() {
  const state = store.getState(runtimeStatus, mcpManager?.getStates() || []);
  return { ...state, sessionAllowedTools: [...sessionAllowedTools] };
}

function publishMcpState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mcp:servers', currentState().mcpServers);
}

function revokeMcpPermissions(serverId: string) {
  const prefix = `mcp:${serverId}:`;
  for (const key of sessionAllowedTools) if (key.startsWith(prefix)) sessionAllowedTools.delete(key);
  const currentAllowed = currentState().settings.alwaysAllowTools;
  const alwaysAllowTools = currentAllowed.filter((key) => !key.startsWith(prefix));
  if (alwaysAllowTools.length !== currentAllowed.length) store.updateSettings({ alwaysAllowTools });
}

async function getProviderDirectory(forceRefresh = false) {
  const url = currentState().settings.providerCatalogUrl || DEFAULT_PROVIDER_CATALOG_URL;
  const cached = providerCatalogCache.get(url);
  if (!forceRefresh && cached) return cached.result;
  const result = await loadProviderCatalog(path.join(app.getPath('userData'), 'provider-catalog.json'), url, forceRefresh);
  providerCatalogCache.set(url, { result, loadedAt: Date.now() });
  return result;
}

type ChatEventPayload =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; tool: ToolRequest }
  | { type: 'tool-trace'; trace: ToolTrace }
  | { type: 'question'; question: { id: string; question: string; options: Array<{ id: string; label: string; description?: string }> } }
  | { type: 'approval-expired'; toolId: string }
  | { type: 'done'; cancelled?: boolean }
  | { type: 'error'; message: string };

function sendChat(event: Electron.IpcMainEvent, message: ChatEvent) {
  if (!event.sender.isDestroyed()) event.sender.send('chat:event', message);
}
function emitRuntime(line: string) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:log', line);
}
function publishRuntime(message?: string) {
  const settings = currentState().settings.localRuntime;
  runtimeStatus = {
    ...runtimeStatus,
    baseUrl: `http://127.0.0.1:${settings.port}/v1`,
    message: message || runtimeStatus.message,
    pid: runtimeProcess?.pid,
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runtime:status', runtimeStatus);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: '#0c1013',
    title: 'Nexus Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const rendererContents = mainWindow.webContents;
  rendererContents.on('did-finish-load', () => {
    setTimeout(() => { if (!rendererContents.isDestroyed()) rendererRestartAttempts = 0; }, 15_000);
  });
  rendererContents.on('render-process-gone', (_event, details) => {
    console.error(`Nexus renderer exited (${details.reason}${details.exitCode === undefined ? '' : `, ${details.exitCode}`}).`);
    const crashedWindow = mainWindow;
    rendererRestartAttempts += 1;
    if (crashedWindow && !crashedWindow.isDestroyed() && rendererRestartAttempts <= 2) setTimeout(() => { if (!crashedWindow.isDestroyed()) crashedWindow.webContents.reload(); }, 350);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error(`Nexus renderer failed to load (${errorCode}): ${errorDescription} · ${validatedURL}`);
  });
  const devOrigin = process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL).origin : '';
  const productionPage = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const allowed = devOrigin ? new URL(url).origin === devOrigin : url === productionPage;
      if (!allowed) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (process.env.NEXUS_OPEN_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function safeProjectPath(relativePath: string) {
  const root = currentState().settings.activeProjectPath;
  if (!root || !path.isAbsolute(root)) throw new Error('Open a project folder first.');
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const target = path.resolve(resolvedRoot, relativePath || '.');
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('That path is outside the open project.');
  const relative = path.relative(resolvedRoot, target);
  let cursor = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are not allowed in project tool paths.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Symbolic links')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return { root: resolvedRoot, target };
}

function getProjectEntries() {
  const { root } = safeProjectPath('.');
  const entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number; extension?: string }> = [];
  const visit = (folder: string, depth: number) => {
    if (depth > 5 || entries.length >= 1800) return;
    let children: fs.Dirent[];
    try { children = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name === '.git') continue;
      if (child.isDirectory() && ignoredDirectories.has(child.name)) continue;
      const absolute = path.join(folder, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (child.isDirectory()) {
        entries.push({ name: child.name, path: relative, type: 'directory' });
        visit(absolute, depth + 1);
      } else if (child.isFile()) {
        let size = 0;
        try { size = fs.statSync(absolute).size; } catch { /* file can disappear */ }
        entries.push({ name: child.name, path: relative, type: 'file', size, extension: path.extname(child.name).toLowerCase() });
      }
      if (entries.length >= 1800) break;
    }
  };
  visit(root, 0);
  return entries;
}

function normalizeProjectRelativePath(raw: string) {
  const value = String(raw || '').replace(/\\/g, '/').trim();
  const segments = value.split('/').filter(Boolean);
  if (!segments.length || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\u0000') || segments.some((part) => part === '.' || part === '..')) throw new Error('Choose a project-relative file path.');
  return segments.join('/');
}

function ensurePreviewSession() {
  const projectPath = currentState().settings.activeProjectPath;
  if (!projectPath) throw new Error('Open a project folder before previewing files.');
  const root = fs.realpathSync(path.resolve(projectPath));
  if (root !== previewRoot) {
    previewRoot = root;
    previewToken = randomUUID();
    previewOverrides.clear();
  }
  return { root, token: previewToken };
}

function validateHtmlPreviewPath(raw: string) {
  const relative = normalizeProjectRelativePath(raw);
  if (!['.html', '.htm'].includes(path.extname(relative).toLowerCase())) throw new Error('Choose an .html or .htm file to preview.');
  const { target } = safeProjectPath(relative);
  if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error('The selected preview path is not a file.');
  return relative;
}

function buildPreviewUrl(relativePath: string) {
  const { token } = ensurePreviewSession();
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
  return `nexus-preview://${token}/${encoded}?v=${Date.now()}`;
}

function mimeTypeForProjectFile(filePath: string) {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  };
  return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function registerProjectPreviewProtocol() {
  protocol.handle('nexus-preview', async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const url = new URL(request.url);
      const { root, token } = ensurePreviewSession();
      if (!token || url.hostname !== token) return new Response('Preview session expired', { status: 403 });
      let relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!relative) relative = 'index.html';
      relative = normalizeProjectRelativePath(relative);
      let { target } = safeProjectPath(relative);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        relative = `${relative}/index.html`;
        target = safeProjectPath(relative).target;
      }
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return new Response('Forbidden path', { status: 403 });
      const key = path.relative(root, target).split(path.sep).join('/');
      let content: Buffer;
      if (previewOverrides.has(key)) content = Buffer.from(previewOverrides.get(key)!, 'utf8');
      else {
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response('Preview file not found', { status: 404 });
        const stat = fs.statSync(target);
        if (stat.size > 40 * 1024 * 1024) return new Response('Preview asset is larger than 40 MB', { status: 413 });
        content = await fs.promises.readFile(target);
      }
      const headers = {
        'Content-Type': mimeTypeForProjectFile(target),
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; media-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self';",
        'Access-Control-Allow-Origin': `nexus-preview://${token}`,
      };
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(content), { status: 200, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not load the project preview.';
      return new Response(message.slice(0, 500), { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
  });
}

function validateProviderUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter a valid provider base URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Provider URL must use HTTPS (HTTP is allowed for local networks only).');
  if (url.username || url.password || url.search || url.hash) throw new Error('Put credentials in the API key field; base URLs cannot contain credentials, queries, or fragments.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const octets = hostname.split('.').map(Number);
  const ipv4 = isIP(hostname) === 4;
  const loopbackIpv4 = ipv4 && octets[0] === 127;
  const privateIpv4 = ipv4 && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  const privateIpv6 = isIP(hostname) === 6 && (hostname.startsWith('fc') || hostname.startsWith('fd'));
  const localNetwork = ['localhost', '::1'].includes(hostname) || loopbackIpv4 || privateIpv4 || privateIpv6;
  if (url.protocol === 'http:' && !localNetwork) throw new Error('For security, public providers must use HTTPS. HTTP is allowed for loopback and private LAN addresses.');
  return url.toString().replace(/\/+$/, '');
}

function validateMcpServerInput(raw: McpServerSaveInput): McpServerSaveInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid MCP server configuration.');
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(id)) throw new Error('Server ID must use 2–41 letters, numbers, hyphens, or underscores.');
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) throw new Error('Server name must be 1–80 characters.');
  if (!['stdio', 'streamable-http', 'sse'].includes(raw.transport)) throw new Error('Choose stdio, Streamable HTTP, or legacy SSE transport.');
  const transport = raw.transport;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (transport === 'stdio' && (!command || command.length > 500 || command.includes('\u0000'))) throw new Error('Enter a local command under 500 characters.');
  const args = Array.isArray(raw.args) ? raw.args : [];
  if (args.length > 100 || args.some((arg) => typeof arg !== 'string' || arg.length > 1000 || arg.includes('\u0000')) || args.join('').length > 10_000) throw new Error('MCP command arguments are invalid or too large.');
  const cwdRaw = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  if (cwdRaw.length > 2000) throw new Error('MCP working directory paths must be under 2,000 characters.');
  let cwd: string | undefined;
  if (cwdRaw) {
    cwd = path.resolve(cwdRaw);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('The MCP working directory must exist and be a folder.');
  }
  const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (transport !== 'stdio' && rawUrl.length > 2000) throw new Error('MCP server URLs must be under 2,000 characters.');
  const url = transport === 'stdio' ? undefined : validateProviderUrl(rawUrl);
  const validateSecretMap = (input: unknown, kind: 'environment variable' | 'HTTP header') => {
    if (input === undefined) return {} as Record<string, string>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid MCP ${kind} map.`);
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 100) throw new Error(`At most 100 MCP ${kind}s may be configured.`);
    const result: Record<string, string> = {};
    let totalLength = 0;
    for (const [key, value] of entries) {
      const keyIsValid = kind === 'environment variable' ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key);
      if (!keyIsValid || typeof value !== 'string' || value.length > 4096 || value.includes('\u0000')) throw new Error(`Invalid MCP ${kind} name or value.`);
      if (kind === 'HTTP header' && /[\r\n]/.test(value)) throw new Error('HTTP header values cannot contain line breaks.');
      totalLength += key.length + value.length;
      if (totalLength > 32_000) throw new Error(`Configured MCP ${kind}s exceed the 32 KB limit.`);
      result[key] = value;
    }
    return result;
  };
  const environment = validateSecretMap(raw.environment, 'environment variable');
  const headers = validateSecretMap(raw.headers, 'HTTP header');
  return {
    id, name, transport, command: transport === 'stdio' ? command : undefined,
    args: args.map((arg) => String(arg)), cwd: transport === 'stdio' ? cwd : undefined, url,
    enabled: raw.enabled === true, environment, headers, clearSecrets: raw.clearSecrets === true,
  };
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || text; } catch { /* keep body */ }
    throw new Error(`HTTP ${response.status}: ${message.slice(0, 400) || response.statusText}`);
  }
  try { return JSON.parse(text); } catch { throw new Error('The endpoint returned an invalid JSON response.'); }
}

function providerHeaders(provider: ProviderInfo, key: string): Record<string, string> {
  if (provider.kind === 'anthropic') return key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'anthropic-version': '2023-06-01' };
  if (provider.kind === 'gemini') return key ? { 'x-goog-api-key': key } : {};
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function discoverModels(provider: ProviderInfo): Promise<ModelInfo[]> {
  const key = store.getSecret(provider.id);
  const base = provider.baseUrl.replace(/\/+$/, '');
  let raw: any;
  if (provider.kind === 'anthropic') {
    raw = await fetchJson(`${base}/v1/models?limit=1000`, { ...providerHeaders(provider, key), 'anthropic-version': '2023-06-01' });
    return (raw.data || []).map((model: any) => ({ id: model.id, name: model.display_name || model.id, contextLength: model.context_window, providerId: provider.id, family: 'Anthropic' }));
  }
  if (provider.kind === 'gemini') {
    raw = await fetchJson(`${base}/models?pageSize=1000`, providerHeaders(provider, key));
    return (raw.models || []).filter((model: any) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent'))
      .map((model: any) => ({ id: String(model.name || '').replace(/^models\//, ''), name: model.displayName || model.name, contextLength: model.inputTokenLimit, providerId: provider.id, family: model.name?.split('/').at(-1)?.split('-')[0] }));
  }
  raw = await fetchJson(`${base}/models`, providerHeaders(provider, key));
  const list = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [];
  return list.map((model: any) => ({
    id: model.id || model.name,
    name: model.name && model.name !== model.id ? model.name : model.id || model.name,
    contextLength: model.context_length || model.context_window || model.context_length_tokens,
    providerId: provider.id,
    description: model.description,
    family: model.architecture?.tokenizer || model.owned_by,
  })).filter((model: ModelInfo) => model.id);
}

function globPattern(pattern: string) {
  if (!pattern || pattern.length > 256) throw new Error('Enter a glob pattern under 256 characters.');
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') { index += 1; source += '(?:.*/)?'; }
      else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source, 'i');
}

function isBlockedPublicAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b] = octets;
    const c = octets[2];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 2 || b === 168 || b === 88 && c === 99)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(normalized) === 6) return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('::ffff:') || normalized.startsWith('2001:db8:') || normalized.startsWith('2001:10:');
  return true;
}

async function validatePublicWebUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid web URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Web tools accept only public HTTP(S) URLs without embedded credentials.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Web tools only support the standard HTTP/HTTPS ports.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private and local network destinations are blocked by web tools.');
  if (isIP(host)) {
    if (isBlockedPublicAddress(host)) throw new Error('Private and local network destinations are blocked by web tools.');
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => isBlockedPublicAddress(entry.address))) throw new Error('This hostname resolves to a private or reserved network address.');
  }
  url.hash = '';
  return url;
}

async function fetchPublicPage(rawUrl: string, maxBytes = 1_500_000) {
  let url = await validatePublicWebUrl(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(18_000), headers: { 'user-agent': 'NexusStudio/0.4.2 (web tool)', accept: 'text/html, text/plain, application/json, application/xml, */*;q=0.5' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Web server returned redirect ${response.status} without a location.`);
      url = await validatePublicWebUrl(new URL(location, url).toString());
      continue;
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error('Web response is larger than the 1.5 MB limit.');
    if (!response.body) throw new Error('Web server returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Web response is larger than the 1.5 MB limit.'); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { response, url: url.toString(), contentType: response.headers.get('content-type') || '', text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };
  }
  throw new Error('Web request exceeded the redirect limit.');
}

function htmlText(source: string) {
  const decode = (text: string) => text.replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_m, value) => String.fromCodePoint(Math.min(0x10ffff, Number(value)))).replace(/&#x([0-9a-f]+);/gi, (_m, value) => String.fromCodePoint(Math.min(0x10ffff, parseInt(value, 16))));
  return decode(source.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[\t\f\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function searchPublicWeb(query: string, count: number) {
  if (!query.trim() || query.length > 1000) throw new Error('Enter a search query under 1,000 characters.');
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
  const page = await fetchPublicPage(searchUrl, 1_500_000);
  const anchors = [...page.text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)];
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  for (const match of anchors) {
    const attributes = match[1];
    if (!/result__a|result-title-a/i.test(attributes)) continue;
    const hrefMatch = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    let resultUrl = hrefMatch[1].replace(/&amp;/g, '&');
    try {
      const parsed = new URL(resultUrl, 'https://duckduckgo.com');
      const redirect = parsed.searchParams.get('uddg');
      resultUrl = redirect ? decodeURIComponent(redirect) : parsed.toString();
      const resolved = await validatePublicWebUrl(resultUrl);
      resultUrl = resolved.toString();
    } catch { continue; }
    const title = htmlText(match[2]).slice(0, 300);
    const after = page.text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 1800);
    const snippetMatch = after.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)(?:<\/[^>]+>)/i);
    const snippet = snippetMatch ? htmlText(snippetMatch[1]).slice(0, 600) : '';
    if (title && !results.some((item) => item.url === resultUrl)) results.push({ title, url: resultUrl, snippet });
    if (results.length >= Math.max(1, Math.min(10, count))) break;
  }
  if (!results.length) return `No web results could be parsed for: ${query}. Search page: ${page.url}`;
  return results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`).join('\n\n');
}

const BUILTIN_SKILLS: Record<string, string> = {
  debugging: 'Debug systematically: reproduce the failure, inspect the relevant call path and logs, identify the smallest causal issue, make a focused fix, and run a targeted verification. Do not guess that a command succeeded.',
  'code-review': 'Review the change for correctness, regressions, security, performance, and missing tests. Prioritize concrete findings with file and line references; distinguish bugs from preferences.',
  testing: 'Plan a test matrix, identify boundary and failure cases, add focused automated tests where practical, and run them. Report exactly which commands passed or failed.',
  refactor: 'Refactor in small, behavior-preserving steps. Keep public contracts stable, remove duplication only when it improves clarity, and run typecheck/tests after each coherent change.',
  research: 'Research from current primary sources when possible. Cite URLs, compare conflicting claims, separate observed facts from inference, and note the date or version when relevant.',
};

function loadSkill(name: string) {
  if (name === 'list') return `Built-in skills: ${Object.keys(BUILTIN_SKILLS).join(', ')}. Project skills: .nexus/skills/<name>/SKILL.md. User skills: app data/skills/<name>/SKILL.md.`;
  if (BUILTIN_SKILLS[name]) return BUILTIN_SKILLS[name];
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new Error('Skill names may contain only letters, numbers, hyphens, and underscores.');
  if (currentState().settings.activeProjectPath) {
    try {
      const projectSkill = safeProjectPath(path.join('.nexus', 'skills', name, 'SKILL.md')).target;
      if (fs.existsSync(projectSkill) && fs.statSync(projectSkill).isFile()) return fs.readFileSync(projectSkill, 'utf8').slice(0, 20_000);
    } catch { /* Continue to user-level skills. */ }
  }
  const skillsRoot = path.join(app.getPath('userData'), 'skills');
  const userSkill = path.join(skillsRoot, name, 'SKILL.md');
  if (fs.existsSync(userSkill) && fs.statSync(userSkill).isFile()) {
    const realRoot = fs.realpathSync(skillsRoot);
    const realSkill = fs.realpathSync(userSkill);
    if (realSkill.startsWith(`${realRoot}${path.sep}`)) return fs.readFileSync(realSkill, 'utf8').slice(0, 20_000);
  }
  throw new Error(`Skill “${name}” was not found. Use default_skill({name:"list"}) to see available skills.`);
}

async function executeTool(name: string, args: Record<string, unknown>, maxToolCharacters = 12_000): Promise<string> {
  if (!TOOL_NAMES.has(name)) throw new Error(`Unsupported tool: ${name}`);
  if (name === 'default_read') {
    const { target } = safeProjectPath(String(args.path || '.'));
    if (!fs.existsSync(target)) throw new Error('File or directory not found.');
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(target, { withFileTypes: true }).filter((item) => item.name !== '.git' && !ignoredDirectories.has(item.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const relative = path.relative(currentState().settings.activeProjectPath, target).split(path.sep).join('/') || '.';
      return children.slice(0, 300).map((item) => `${item.isDirectory() ? 'dir ' : 'file'}  ${relative === '.' ? '' : `${relative}/`}${item.name}`).join('\n').slice(0, maxToolCharacters) || '(Empty directory.)';
    }
    if (!stat.isFile()) throw new Error('Only regular files can be read.');
    if (stat.size > 1_000_000) throw new Error('File is larger than the 1 MB tool-read limit.');
    const content = fs.readFileSync(target, 'utf8');
    if (content.includes('\u0000')) throw new Error('Binary files are not readable as text.');
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, Math.min(lines.length || 1, Number(args.offset) || 1));
    const requested = Math.max(1, Math.min(1200, Number(args.limit) || 600));
    const endLine = Math.min(lines.length, startLine + requested - 1);
    const output = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join('\n');
    return `${output}${endLine < lines.length ? `\n… ${lines.length - endLine} more lines …` : ''}`.slice(0, maxToolCharacters) || '(empty file)';
  }
  if (name === 'default_glob') {
    const pattern = globPattern(String(args.pattern || ''));
    const base = typeof args.path === 'string' && args.path.trim() ? normalizeProjectRelativePath(args.path) : '';
    const basePrefix = base ? `${base}/` : '';
    if (base) {
      const folder = safeProjectPath(base).target;
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Glob scope must be an existing project directory.');
    }
    const matches = getProjectEntries().filter((entry) => {
      if (basePrefix && !entry.path.startsWith(basePrefix)) return false;
      const candidate = basePrefix ? entry.path.slice(basePrefix.length) : entry.path;
      return pattern.test(candidate);
    });
    return matches.slice(0, 400).map((entry) => `${entry.type === 'directory' ? 'dir ' : 'file'}  ${entry.path}`).join('\n').slice(0, maxToolCharacters) || 'No paths matched that glob.';
  }
  if (name === 'default_grep') {
    const query = String(args.query || '').trim();
    if (!query || query.length > 1000) throw new Error('Enter a search phrase under 1,000 characters.');
    const base = typeof args.path === 'string' && args.path.trim() ? normalizeProjectRelativePath(args.path) : '';
    const prefix = base ? `${base}/` : '';
    if (base) {
      const folder = safeProjectPath(base).target;
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('Search scope must be an existing project directory.');
    }
    const include = typeof args.include === 'string' && args.include ? globPattern(args.include) : undefined;
    const matches: string[] = [];
    for (const entry of getProjectEntries()) {
      if (entry.type !== 'file' || (entry.size || 0) > 500_000 || (prefix && !entry.path.startsWith(prefix)) || (include && !include.test(entry.path))) continue;
      try {
        const content = fs.readFileSync(safeProjectPath(entry.path).target, 'utf8');
        if (content.includes('\u0000')) continue;
        content.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < 120 && line.toLowerCase().includes(query.toLowerCase())) matches.push(`${entry.path}:${index + 1}: ${line.trim().slice(0, 300)}`);
        });
      } catch { /* Ignore unreadable/removed files. */ }
      if (matches.length >= 120) break;
    }
    return matches.join('\n').slice(0, maxToolCharacters) || 'No matches found.';
  }
  if (name === 'default_write') {
    const relativePath = String(args.path || '');
    const content = String(args.content ?? '');
    if (!relativePath || content.length > 2_000_000) throw new Error('File path is empty or content exceeds the 2 MB limit.');
    const { target } = safeProjectPath(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return `Saved ${relativePath} (${content.length.toLocaleString()} characters).`;
  }
  if (name === 'default_edit') {
    const relativePath = String(args.path || '');
    const oldText = String(args.old_text ?? '');
    const newText = String(args.new_text ?? '');
    if (!relativePath || !oldText) throw new Error('Provide a file path and non-empty old_text.');
    const { target } = safeProjectPath(relativePath);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('File not found.');
    if (fs.statSync(target).size > 2_000_000) throw new Error('File is larger than the 2 MB edit limit.');
    const original = fs.readFileSync(target, 'utf8');
    if (original.includes('\u0000')) throw new Error('Binary files cannot be edited.');
    const occurrences = original.split(oldText).length - 1;
    if (!occurrences) throw new Error('old_text was not found exactly. Read the current file and retry with an exact snippet.');
    if (!args.replace_all && occurrences !== 1) throw new Error(`old_text matched ${occurrences} times. Supply a more specific snippet or set replace_all=true.`);
    const updated = args.replace_all === true ? original.split(oldText).join(newText) : original.replace(oldText, newText);
    if (updated.length > 2_000_000) throw new Error('Edited file would exceed the 2 MB limit.');
    fs.writeFileSync(target, updated, 'utf8');
    return `Edited ${relativePath}; replaced ${args.replace_all === true ? occurrences : 1} occurrence${occurrences === 1 ? '' : 's'}.`;
  }
  if (name === 'default_shell') {
    const command = String(args.command || '').trim();
    if (!command || command.length > 8000) throw new Error('Command is empty or longer than 8,000 characters.');
    const result = await runCommand(command);
    return `Exit code: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}\n${result.output.slice(-12_000) || '(no output)'}`;
  }
  if (name === 'default_webfetch') {
    const page = await fetchPublicPage(String(args.url || ''));
    if (!page.response.ok) throw new Error(`Web server returned ${page.response.status} ${page.response.statusText}.`);
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/.test(page.contentType)) return `Fetched ${page.url} (${page.contentType || 'unknown content type'}); binary content was not included.`;
    const body = page.contentType.includes('html') ? htmlText(page.text) : page.text;
    return `URL: ${page.url}\nContent-Type: ${page.contentType}\n\n${body}`.slice(0, maxToolCharacters);
  }
  if (name === 'default_websearch') return searchPublicWeb(String(args.query || ''), Number(args.count) || 5);
  if (name === 'default_skill') return loadSkill(String(args.name || ''));
  throw new Error(`Tool “${name}” is handled by the agent runtime, not the project tool executor.`);
}

function requestToolApproval(sender: Electron.WebContents, requestId: string, tool: ToolRequest, approvalKey: string): Promise<ToolApprovalChoice> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingToolApprovals.delete(tool.id);
      if (!sender.isDestroyed()) sender.send('chat:event', { requestId, type: 'approval-expired', toolId: tool.id } satisfies ChatEvent);
      resolve('deny');
    }, 120_000);
    pendingToolApprovals.set(tool.id, { requestId, approvalKey, senderId: sender.id, resolve: (decision) => { clearTimeout(timer); resolve(decision); } });
    if (!sender.isDestroyed()) sender.send('chat:event', { requestId, type: 'tool', tool } satisfies ChatEvent);
    else {
      pendingToolApprovals.delete(tool.id);
      resolve('deny');
    }
  });
}

function askUserQuestion(sender: Electron.WebContents, requestId: string, text: string, options: Array<{ id: string; label: string; description?: string }>): Promise<string> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingQuestions.delete(id);
      resolve('The user did not answer before the question expired.');
    }, 5 * 60_000);
    pendingQuestions.set(id, { requestId, senderId: sender.id, resolve: (answer) => { clearTimeout(timer); resolve(answer); } });
    if (!sender.isDestroyed()) sender.send('chat:event', { requestId, type: 'question', question: { id, question: text.slice(0, 1200), options } } satisfies ChatEvent);
    else {
      pendingQuestions.delete(id);
      clearTimeout(timer);
      resolve('The user window is no longer available.');
    }
  });
}

function runCommand(command: string): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  if (!command.trim() || command.length > 8000) return Promise.reject(new Error('Command is empty or longer than 8,000 characters.'));
  const settings = currentState().settings;
  let workingDirectory: string;
  if (settings.activeProjectPath) {
    try { workingDirectory = fs.realpathSync(path.resolve(settings.activeProjectPath)); }
    catch { return Promise.reject(new Error('The open project folder is no longer available. Reopen it or close the project before running shell commands.')); }
  } else {
    if (!settings.allowShellWithoutProject) return Promise.reject(new Error('Shell access without a project is off. Enable “Allow shell commands without a project” in Settings → Tools & safety.'));
    workingDirectory = os.homedir();
  }
  if (!path.isAbsolute(workingDirectory) || !fs.existsSync(workingDirectory) || !fs.statSync(workingDirectory).isDirectory()) return Promise.reject(new Error('The shell working directory is not available.'));
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const powershellCommand = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`;
    const args = isWindows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellCommand] : ['-lc', command];
    const child = spawn(shell, args, { cwd: workingDirectory, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 200_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    child.once('error', (error) => { if (finished) return; finished = true; clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ output: timedOut ? `${output}\n[Command timed out after 60 seconds.]` : output, exitCode: code, timedOut });
    });
  });
}

function askForApproval(sender: Electron.WebContents, requestId: string, name: string, args: Record<string, unknown>, approvalKey = name, description?: string, label?: string) {
  const tool = createToolRequest(name, args, description, label);
  return requestToolApproval(sender, requestId, tool, approvalKey);
}

function sanitizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const result = { ...patch };
  delete result.activeProjectPath;
  delete result.hfTokenSet;
  if (result.theme && !['system', 'dark', 'light'].includes(result.theme)) delete result.theme;
  if (result.activeTab && !['chat', 'workspace', 'models', 'settings'].includes(result.activeTab)) delete result.activeTab;
  if (result.activeProviderId) result.activeProviderId = String(result.activeProviderId).slice(0, 50);
  if (result.activeModelId) result.activeModelId = String(result.activeModelId).slice(0, 200);
  if (result.enableTools !== undefined && typeof result.enableTools !== 'boolean') delete result.enableTools;
  if (result.confirmToolCalls !== undefined && typeof result.confirmToolCalls !== 'boolean') delete result.confirmToolCalls;
  if (result.allowShellWithoutProject !== undefined && typeof result.allowShellWithoutProject !== 'boolean') delete result.allowShellWithoutProject;
  if (result.alwaysAllowTools !== undefined) {
    if (!Array.isArray(result.alwaysAllowTools)) delete result.alwaysAllowTools;
    else result.alwaysAllowTools = [...new Set(result.alwaysAllowTools.filter((key): key is string => typeof key === 'string' && key.length <= 4096))].slice(0, 500);
  }
  if (result.autoFetchModels !== undefined && typeof result.autoFetchModels !== 'boolean') delete result.autoFetchModels;
  if (result.autoDiscoverProviders !== undefined && typeof result.autoDiscoverProviders !== 'boolean') delete result.autoDiscoverProviders;
  if (result.zoomPercent !== undefined) result.zoomPercent = Math.max(75, Math.min(150, Math.round(Number(result.zoomPercent) / 10) * 10 || 100));
  if (result.providerCatalogUrl !== undefined) {
    try {
      const url = new URL(String(result.providerCatalogUrl));
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.toString().length > 1000) delete result.providerCatalogUrl;
      else result.providerCatalogUrl = url.toString();
    } catch { delete result.providerCatalogUrl; }
  }
  if (result.systemPrompt !== undefined) {
    if (typeof result.systemPrompt !== 'string') delete result.systemPrompt;
    else result.systemPrompt = result.systemPrompt.slice(0, 20_000);
  }
  if (result.contextTokens !== undefined) result.contextTokens = Math.max(512, Math.min(1_048_576, Math.floor(Number(result.contextTokens) || 8192)));
  if (result.maxOutputTokens !== undefined) result.maxOutputTokens = Math.max(256, Math.min(65_536, Math.floor(Number(result.maxOutputTokens) || 4096)));
  if (result.temperature !== undefined) result.temperature = Math.max(0, Math.min(2, Number(result.temperature) || 0));
  if (result.localRuntime) {
    const local = { ...result.localRuntime };
    const savedLocal = currentState().settings.localRuntime;
    local.executablePath = savedLocal.executablePath;
    local.modelPath = savedLocal.modelPath;
    local.host = '127.0.0.1';
    local.port = runtimeStatus.running ? savedLocal.port : Math.max(1024, Math.min(65_535, Math.floor(Number(local.port) || 8080)));
    local.contextTokens = Math.max(512, Math.min(1_048_576, Math.floor(Number(local.contextTokens) || 8192)));
    local.gpuLayers = Math.max(0, Math.min(999, Math.floor(Number(local.gpuLayers) || 0)));
    if (!['cpu', 'vulkan', 'cuda', 'auto'].includes(local.gpuBackend)) local.gpuBackend = 'auto';
    local.deviceName = String(local.deviceName || 'Vulkan0').slice(0, 100);
    result.localRuntime = local;
  }
  return result;
}

function addIpcHandlers() {
  ipcMain.handle('clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 5_000_000) throw new Error('Clipboard text is invalid or exceeds 5 MB.');
    clipboard.writeText(text);
  });
  ipcMain.handle('app:get-state', () => currentState());
  ipcMain.handle('chat-sessions:list', () => chatSessionStore.list());
  ipcMain.handle('chat-sessions:get', (_event, sessionId: string) => chatSessionStore.get(String(sessionId || '')));
  ipcMain.handle('chat-sessions:save', (_event, session: unknown) => chatSessionStore.save(session));
  ipcMain.handle('chat-sessions:delete', (_event, sessionId: string) => chatSessionStore.delete(String(sessionId || '')));
  ipcMain.handle('chat-sessions:delete-message', (_event, sessionId: string, messageId: string) => chatSessionStore.deleteMessage(String(sessionId || ''), String(messageId || '')));
  ipcMain.handle('chat-sessions:clear', () => chatSessionStore.clear());
  ipcMain.handle('app:save-settings', (_event, patch: Partial<AppSettings>) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings payload.');
    const safePatch = sanitizeSettingsPatch(patch);
    store.updateSettings(safePatch);
    if (safePatch.localRuntime?.port !== undefined) {
      const local = currentState().providers.find((provider) => provider.id === 'llamacpp');
      if (local) store.upsertProvider({ id: local.id, name: local.name, kind: local.kind, baseUrl: `http://127.0.0.1:${currentState().settings.localRuntime.port}/v1` });
    }
    publishRuntime();
    return currentState();
  });
  ipcMain.handle('provider:save', (_event, input: { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; clearKey?: boolean }) => {
    if (!input || typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(input.id)) throw new Error('Provider ID must use 2–41 letters, numbers, hyphens, or underscores.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('Provider name must be 1–80 characters.');
    if (!['openai-compatible', 'anthropic', 'gemini'].includes(input.kind)) throw new Error('Choose a supported provider protocol.');
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 500) throw new Error('Provider base URL is required and must be under 500 characters.');
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) throw new Error('API keys must be under 4,096 characters.');
    const baseUrl = validateProviderUrl(input.baseUrl);
    store.upsertProvider({ ...input, name: input.name.trim(), baseUrl });
    return currentState();
  });
  ipcMain.handle('provider:remove', (_event, providerId: string) => {
    store.removeProvider(providerId);
    return currentState();
  });
  ipcMain.handle('provider:catalog', (_event, forceRefresh?: boolean) => getProviderDirectory(Boolean(forceRefresh)));
  ipcMain.handle('provider:add-catalog', async (_event, providerId: string) => {
    if (typeof providerId !== 'string' || providerId.length > 50) throw new Error('Invalid provider catalog ID.');
    const directory = await getProviderDirectory(false);
    const entry = directory.entries.find((item) => item.id === providerId);
    if (!entry) throw new Error('That provider is not available in the current catalog. Refresh the directory and try again.');
    const current = currentState().providers.find((item) => item.id === providerId);
    if (current) return currentState();
    const baseUrl = validateProviderUrl(entry.baseUrl);
    store.upsertProvider({ id: entry.id, name: entry.name, kind: entry.kind, baseUrl, docsUrl: entry.docsUrl, source: 'catalog' });
    if (entry.models.length) store.seedProviderModels(entry.id, entry.models);
    return currentState();
  });
  ipcMain.handle('mcp:save', async (_event, raw: McpServerSaveInput) => {
    const input = validateMcpServerInput(raw);
    await mcpManager?.disconnect(input.id);
    revokeMcpPermissions(input.id);
    store.saveMcpServer(input);
    if (input.enabled) {
      try { await mcpManager?.connect(input.id); } catch { /* Keep the saved config and expose the connection error in server state. */ }
    }
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:remove', async (_event, serverId: string) => {
    if (typeof serverId !== 'string' || serverId.length > 50) throw new Error('Invalid MCP server ID.');
    await mcpManager?.disconnect(serverId);
    revokeMcpPermissions(serverId);
    store.removeMcpServer(serverId);
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:connect', async (_event, serverId: string) => {
    if (!store.getMcpServer(serverId)) throw new Error('MCP server not found.');
    store.setMcpServerEnabled(serverId, true);
    try { await mcpManager?.connect(serverId); }
    catch (error) { publishMcpState(); throw error; }
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
    if (!store.getMcpServer(serverId)) throw new Error('MCP server not found.');
    store.setMcpServerEnabled(serverId, false);
    await mcpManager?.disconnect(serverId);
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:set-enabled', async (_event, serverId: string, enabled: boolean) => {
    if (typeof enabled !== 'boolean' || !store.getMcpServer(serverId)) throw new Error('Invalid MCP server permission change.');
    store.setMcpServerEnabled(serverId, enabled);
    if (enabled) await mcpManager?.connect(serverId);
    else await mcpManager?.disconnect(serverId);
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:refresh', async (_event, serverId: string) => {
    if (!store.getMcpServer(serverId)) throw new Error('MCP server not found.');
    await mcpManager?.refresh(serverId);
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('mcp:tool-enabled', (_event, serverId: string, toolKey: string, enabled: boolean) => {
    if (typeof toolKey !== 'string' || toolKey.length > 4096 || typeof enabled !== 'boolean') throw new Error('Invalid MCP capability permission.');
    const server = mcpManager?.getStates().find((item) => item.id === serverId);
    if (!server || !server.tools.some((tool) => tool.key === toolKey)) throw new Error('MCP capability not found. Refresh the server and try again.');
    store.setMcpToolEnabled(serverId, toolKey, enabled);
    publishMcpState();
    return currentState();
  });
  ipcMain.handle('permissions:clear-session', () => {
    sessionAllowedTools.clear();
    return currentState();
  });
  ipcMain.handle('provider:refresh-models', async (_event, providerId: string) => {
    const provider = currentState().providers.find((item) => item.id === providerId);
    if (!provider) return { state: currentState(), error: 'Provider not found.' };
    try {
      const models = await discoverModels(provider);
      if (!models.length) throw new Error('The endpoint responded, but no models were returned. Check the base URL or provider permissions.');
      store.updateProviderModels(providerId, models, 'active');
      return { state: currentState() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateProviderModels(providerId, provider.models, 'inactive', message);
      return { state: currentState(), error: message };
    }
  });
  ipcMain.handle('provider:refresh-all', async () => {
    const providers = currentState().providers.filter((provider) => provider.hasKey || (provider.id === 'llamacpp' && Boolean(runtimeProcess)));
    await Promise.all(providers.map(async (provider) => {
      try {
        const models = await discoverModels(provider);
        store.updateProviderModels(provider.id, models, 'active');
      } catch (error) {
        store.updateProviderModels(provider.id, provider.models, 'inactive', error instanceof Error ? error.message : String(error));
      }
    }));
    return currentState();
  });
  ipcMain.handle('hf:set-token', (_event, token: string) => {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('Hugging Face tokens must be under 4,096 characters.');
    store.setHfToken(token);
    return currentState();
  });

  ipcMain.handle('hf:search', async (_event, query: string) => {
    const url = new URL('https://huggingface.co/api/models');
    url.searchParams.set('filter', 'gguf');
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    url.searchParams.set('limit', '24');
    if (query?.trim()) url.searchParams.set('search', query.trim().slice(0, 100));
    const headers: Record<string, string> = {};
    if (store.getHfToken()) headers.authorization = `Bearer ${store.getHfToken()}`;
    const raw = await fetchJson(url.toString(), headers);
    return (Array.isArray(raw) ? raw : []).map((model: any) => ({ id: model.id, downloads: model.downloads || 0, likes: model.likes || 0, tags: model.tags || [] })) as HuggingFaceModel[];
  });
  ipcMain.handle('hf:files', async (_event, repoId: string) => {
    if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repoId)) throw new Error('Invalid Hugging Face repository ID.');
    const headers: Record<string, string> = {};
    if (store.getHfToken()) headers.authorization = `Bearer ${store.getHfToken()}`;
    const raw = await fetchJson(`https://huggingface.co/api/models/${repoId}?blobs=true`, headers);
    return (raw.siblings || []).filter((file: any) => String(file.rfilename || '').toLowerCase().endsWith('.gguf')).map((file: any) => ({
      name: file.rfilename,
      size: file.size,
      lfsSize: file.lfs?.size,
      downloaded: false,
    })) as HuggingFaceFile[];
  });
  ipcMain.handle('hf:download', async (_event, repoId: string, filename: string) => {
    if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repoId)) throw new Error('Invalid Hugging Face repository ID.');
    const segments = String(filename).split('/');
    if (!segments.length || !segments.at(-1)?.toLowerCase().endsWith('.gguf') || segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[\w.-]+$/.test(segment))) throw new Error('Invalid GGUF model filename.');
    const targetRoot = path.join(app.getPath('userData'), 'models', repoId);
    const target = path.resolve(targetRoot, ...segments);
    if (!target.startsWith(`${path.resolve(targetRoot)}${path.sep}`)) throw new Error('Invalid model destination.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const downloadUrl = `https://huggingface.co/${repoId}/resolve/main/${segments.map(encodeURIComponent).join('/')}?download=true`;
    const headers: Record<string, string> = {};
    if (store.getHfToken()) headers.authorization = `Bearer ${store.getHfToken()}`;
    const response = await fetch(downloadUrl, { headers, signal: AbortSignal.timeout(30 * 60_000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). The repository may be gated or the file may not exist.`);
    const total = Number(response.headers.get('content-length')) || undefined;
    let received = 0;
    const body = Readable.fromWeb(response.body as never);
    const meter = new (await import('node:stream')).Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download:progress', { filename: segments.at(-1), received, total, percent: total ? Math.round(received / total * 100) : undefined });
        callback(null, chunk);
      },
    });
    try { await pipeline(body, meter, fs.createWriteStream(target)); }
    catch (error) { try { fs.unlinkSync(target); } catch { /* no-op */ } throw error; }
    if (!runtimeStatus.running) store.updateSettings({ localRuntime: { ...currentState().settings.localRuntime, modelPath: target } });
    publishRuntime();
    return target;
  });

  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined as any, { title: 'Open project folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    store.updateSettings({ activeProjectPath: path.resolve(result.filePaths[0]) });
    return result.filePaths[0];
  });
  ipcMain.handle('project:list', () => getProjectEntries());
  ipcMain.handle('project:read', (_event, relativePath: string) => {
    const { target } = safeProjectPath(String(relativePath || ''));
    const info = fs.statSync(target);
    if (!info.isFile()) throw new Error('Select a file to open.');
    if (info.size > 1_000_000) throw new Error('This file is larger than the 1 MB editor limit.');
    const content = fs.readFileSync(target, 'utf8');
    if (content.includes('\u0000')) throw new Error('Binary files cannot be opened in the text editor.');
    return content;
  });
  ipcMain.handle('project:write', (_event, relativePath: string, content: string) => {
    if (typeof content !== 'string' || content.length > 2_000_000) throw new Error('File content exceeds the 2 MB editor limit.');
    const { target } = safeProjectPath(String(relativePath || ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  });
  ipcMain.handle('project:preview-url', (_event, relativePath: string) => buildPreviewUrl(validateHtmlPreviewPath(relativePath)));
  ipcMain.handle('project:preview-update', (_event, relativePath: string, content: string) => {
    if (typeof content !== 'string' || content.length > 2_000_000) throw new Error('Preview content exceeds the 2 MB editor limit.');
    const relative = validateHtmlPreviewPath(relativePath);
    previewOverrides.set(relative, content);
    return buildPreviewUrl(relative);
  });
  ipcMain.handle('shell:run', async (_event, command: string) => runCommand(String(command || '')));
  ipcMain.handle('dialog:runtime-path', async () => {
    if (runtimeStatus.running) throw new Error('Stop the local runtime before changing its executable.');
    const result = await dialog.showOpenDialog(mainWindow || undefined as any, { title: 'Select llama-server executable', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'llama-server', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'Executable', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const localRuntime = { ...currentState().settings.localRuntime, executablePath: result.filePaths[0] };
    store.updateSettings({ localRuntime }); publishRuntime(); return result.filePaths[0];
  });
  ipcMain.handle('dialog:model-path', async () => {
    if (runtimeStatus.running) throw new Error('Stop the local runtime before changing its active GGUF.');
    const result = await dialog.showOpenDialog(mainWindow || undefined as any, { title: 'Select a GGUF model file', properties: ['openFile'], filters: [{ name: 'GGUF model', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    if (path.extname(result.filePaths[0]).toLowerCase() !== '.gguf') throw new Error('Select a .gguf model file.');
    const localRuntime = { ...currentState().settings.localRuntime, modelPath: result.filePaths[0] };
    store.updateSettings({ localRuntime }); publishRuntime(); return result.filePaths[0];
  });
  ipcMain.handle('runtime:select-model', (_event, requestedPath: string) => {
    if (runtimeStatus.running) throw new Error('Stop the local runtime before changing its active model.');
    const modelsRoot = path.resolve(app.getPath('userData'), 'models');
    const selected = path.resolve(String(requestedPath || ''));
    if (!selected.startsWith(`${modelsRoot}${path.sep}`) || path.extname(selected).toLowerCase() !== '.gguf') throw new Error('Choose a GGUF file from the downloaded model library, or use Browse to select another file.');
    if (!fs.existsSync(selected) || !fs.statSync(selected).isFile()) throw new Error('GGUF file not found.');
    const realRoot = fs.realpathSync(modelsRoot);
    const realSelected = fs.realpathSync(selected);
    if (!realSelected.startsWith(`${realRoot}${path.sep}`)) throw new Error('Model path must remain inside the downloaded model library.');
    store.updateSettings({ localRuntime: { ...currentState().settings.localRuntime, modelPath: realSelected } });
    publishRuntime();
    return currentState();
  });
  ipcMain.handle('runtime:start', async () => startLocalRuntime());
  ipcMain.handle('runtime:stop', async () => stopLocalRuntime());
  ipcMain.handle('models:local', async () => listLocalModels());

  ipcMain.on('chat:cancel', (_event, requestId: string) => {
    activeChats.get(requestId)?.abort();
    for (const [toolId, pending] of pendingToolApprovals) {
      if (pending.requestId === requestId) {
        pendingToolApprovals.delete(toolId);
        pending.resolve('deny');
      }
    }
    for (const [questionId, pending] of pendingQuestions) {
      if (pending.requestId === requestId) {
        pendingQuestions.delete(questionId);
        pending.resolve('The user cancelled this question.');
      }
    }
  });
  ipcMain.handle('tool:question-answer', (event, questionId: string, rawAnswer: string) => {
    const pending = pendingQuestions.get(questionId);
    if (!pending || pending.senderId !== event.sender.id) return;
    pendingQuestions.delete(questionId);
    pending.resolve(typeof rawAnswer === 'string' ? rawAnswer.slice(0, 8000) : '');
  });
  ipcMain.handle('tool:approval', (event, toolId: string, rawDecision: ToolApprovalChoice) => {
    const pending = pendingToolApprovals.get(toolId);
    if (!pending || pending.senderId !== event.sender.id) return currentState();
    const requestedDecision: ToolApprovalChoice = ['deny', 'once', 'session', 'always'].includes(rawDecision) ? rawDecision : 'deny';
    const staleMcpApproval = pending.approvalKey.startsWith('mcp:') && !mcpManager?.getAgentTools().some((tool) => tool.approvalKey === pending.approvalKey);
    const decision: ToolApprovalChoice = staleMcpApproval ? 'deny' : requestedDecision;
    pendingToolApprovals.delete(toolId);
    if (decision === 'session') sessionAllowedTools.add(pending.approvalKey);
    if (decision === 'always') {
      const allowed = new Set(currentState().settings.alwaysAllowTools);
      allowed.add(pending.approvalKey);
      store.updateSettings({ alwaysAllowTools: [...allowed].slice(0, 500) });
    }
    pending.resolve(decision);
    return currentState();
  });
  ipcMain.on('chat:start', async (event, payload: { requestId: string; request: ChatRequest }) => {
    const { requestId, request } = payload || {};
    if (!requestId || !request || !event.sender || event.sender.isDestroyed()) return;
    const controller = new AbortController();
    activeChats.set(requestId, controller);
    const emit = (message: ChatEventPayload) => sendChat(event, { requestId, ...message } as ChatEvent);
    try {
      const state = currentState();
      if (!Array.isArray(request.messages) || request.messages.length > 64 || request.messages.some((message) => !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 500_000)) throw new Error('Conversation payload is invalid or too large.');
      const provider = state.providers.find((item) => item.id === request.providerId);
      if (!provider) throw new Error('Choose a provider first.');
      if (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 200) throw new Error('Choose a valid model before sending a message.');
      if (typeof request.systemPrompt !== 'string' || request.systemPrompt.length > 20_000) throw new Error('System prompt is too large.');
      const key = store.getSecret(provider.id);
      const projectOpen = Boolean(state.settings.activeProjectPath);
      const toolCallingEnabled = Boolean(request.enableTools && state.settings.enableTools);
      const mcpTools = toolCallingEnabled ? (mcpManager?.getAgentTools() || []) : [];
      const builtinTools = toolCallingEnabled ? getBuiltinToolDefinitions(projectOpen, projectOpen || state.settings.allowShellWithoutProject, buildCodeModeDescription(mcpTools)) : [];
      const availableTools: ToolDefinition[] = [...builtinTools];
      const builtinNames = new Set(builtinTools.map((tool) => tool.name));
      const mcpToolsByName = new Map(mcpTools.map((tool) => [tool.name, tool]));
      const availableNames = new Set(availableTools.map((tool) => tool.name));
      const runTool = async (name: string, args: Record<string, unknown>) => {
        const traceId = randomUUID();
        const mcpTool = mcpToolsByName.get(name);
        const label = mcpTool ? `${mcpTool.serverName} · ${mcpTool.capabilityName}` : name.replace(/^default_/, 'default.');
        let displayArgs: Record<string, unknown> = args;
        try {
          const serialized = JSON.stringify(args);
          displayArgs = serialized.length > 16_000 ? { preview: `${serialized.slice(0, 15_500)}…`, truncated: true } : JSON.parse(serialized || '{}');
        } catch { displayArgs = { preview: '[Arguments could not be displayed safely]' }; }
        let traceState: ToolTrace['state'] = 'running';
        let result = '';
        emit({ type: 'tool-trace', trace: { id: traceId, name, label, arguments: displayArgs, state: traceState } });
        try {
          if (!availableNames.has(name) && !mcpTool) throw new Error(`Tool not available in this request: ${name}`);
          const approvalKey = mcpTool?.approvalKey || name;
          if (mcpTool && !mcpManager?.getAgentTools().some((tool) => tool.name === name && tool.approvalKey === approvalKey)) throw new Error('That MCP capability is no longer connected or enabled.');
          const latestSettings = currentState().settings;
          const autoAllowed = latestSettings.alwaysAllowTools.includes(approvalKey) || sessionAllowedTools.has(approvalKey);
          const mustConfirm = Boolean(mcpTool) || latestSettings.confirmToolCalls || ['default_write', 'default_edit', 'default_shell', 'default_execute'].includes(name);
          if (mustConfirm && !autoAllowed) {
            emit({ type: 'status', text: `Approval required · ${label}` });
            const decision = await askForApproval(event.sender, requestId, name, args, approvalKey, mcpTool?.description, label);
            if (decision === 'deny') {
              traceState = 'denied';
              result = 'The user denied or dismissed this tool call. Do not retry it unless the user asks.';
              return result;
            }
            if (decision === 'session') sessionAllowedTools.add(approvalKey);
            if (decision === 'always') {
              const allowlist = new Set(currentState().settings.alwaysAllowTools);
              allowlist.add(approvalKey);
              store.updateSettings({ alwaysAllowTools: [...allowlist].slice(0, 500) });
            }
          }
          emit({ type: 'status', text: `Running · ${label}` });
          if (mcpTool) {
            if (!mcpManager) throw new Error('MCP support is not initialized.');
            result = await mcpManager.callAgentTool(mcpTool, args);
          } else {
            if (!builtinNames.has(name) || !TOOL_NAMES.has(name)) throw new Error('That tool is not enabled.');
            if (name === 'default_execute') {
              result = await executeCodeMode(String(args.code || ''), mcpTools, (nestedTool, nestedArgs) => runTool(nestedTool.name, nestedArgs));
            } else if (name === 'default_question') {
              const text = String(args.question || '').trim();
              if (!text || text.length > 1200) throw new Error('Question must be 1–1,200 characters.');
              const options = Array.isArray(args.options) ? args.options.slice(0, 6).map((item, index) => {
                const option = item && typeof item === 'object' ? item as Record<string, unknown> : {};
                return { id: String(option.id || `option-${index + 1}`).slice(0, 80), label: String(option.label || '').slice(0, 200), description: typeof option.description === 'string' ? option.description.slice(0, 500) : undefined };
              }).filter((option) => option.label) : [];
              result = await askUserQuestion(event.sender, requestId, text, options);
            } else if (name === 'default_subagent') {
              const task = String(args.task || '').trim();
              if (!task || task.length > 20_000) throw new Error('Subagent task must be 1–20,000 characters.');
              const role = ['general', 'explore', 'media', 'research'].includes(String(args.role)) ? String(args.role) : 'general';
              const rolePrompt = role === 'explore' ? 'You are an explore subagent. Identify likely files, concepts, and a concise investigation plan from the context the user provided. You have no filesystem tools; never claim to have inspected files.' : role === 'media' ? 'You are a media subagent. Reason about visual, audio, or other media only from details explicitly included in the task; do not claim to have opened or generated assets.' : role === 'research' ? 'You are a research subagent. Analyze the supplied context carefully and return sourced or explicitly qualified conclusions. You have no web or filesystem tools.' : 'You are a general-purpose subagent. Solve the narrow task independently and return a concise result. You have no tools or filesystem access.';
              let childText = '';
              emit({ type: 'status', text: `Subagent running · ${role}` });
              await streamProviderChat(provider, key, { ...request, messages: [{ role: 'user', content: task }], systemPrompt: `${request.systemPrompt}\n\n${rolePrompt}`, enableTools: false, maxOutputTokens: Math.min(3_000, request.maxOutputTokens) }, controller.signal, (text) => { childText += text; }, () => {}, () => {}, async () => 'Subagent tools are disabled.', []);
              result = childText.trim() || 'The subagent returned no text.';
            } else {
              result = await executeTool(name, args, Math.max(4_000, Math.min(24_000, request.contextTokens * 1.5)));
            }
          }
          traceState = 'complete';
          return result;
        } catch (error) {
          traceState = 'error';
          result = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
          return result;
        } finally {
          emit({ type: 'tool-trace', trace: { id: traceId, name, label, arguments: displayArgs, state: traceState, result: result.slice(0, 12_000) } });
          emit({ type: 'status', text: `${traceState === 'complete' ? 'Tool complete' : traceState === 'denied' ? 'Tool denied' : 'Tool failed'} · ${label}` });
        }
      };
      await streamProviderChat(
        provider,
        key,
        { ...request, enableTools: Boolean(request.enableTools && state.settings.enableTools) },
        controller.signal,
        (text) => emit({ type: 'delta', text }),
        (text) => emit({ type: 'reasoning', text }),
        (text) => emit({ type: 'status', text }),
        runTool,
        availableTools,
      );
      emit({ type: 'done', cancelled: controller.signal.aborted });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) emit({ type: 'done', cancelled: true });
      else emit({ type: 'error', message });
    } finally {
      activeChats.delete(requestId);
    }
  });
}

async function startLocalRuntime() {
  const settings = currentState().settings.localRuntime;
  if (runtimeProcess) return currentState();
  if (!settings.executablePath || !fs.existsSync(settings.executablePath)) throw new Error('Select a llama-server executable first.');
  if (!settings.modelPath || !fs.existsSync(settings.modelPath)) throw new Error('Select or download a GGUF model first.');
  const gpuLayers = settings.gpuBackend === 'cpu' ? 0 : settings.gpuLayers;
  const args = ['--model', settings.modelPath, '--host', '127.0.0.1', '--port', String(settings.port), '--ctx-size', String(settings.contextTokens), '--n-gpu-layers', String(gpuLayers)];
  if (settings.gpuBackend === 'vulkan' || settings.gpuBackend === 'cuda') args.push('--device', settings.deviceName || (settings.gpuBackend === 'vulkan' ? 'Vulkan0' : 'CUDA0'));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(settings.executablePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    runtimeProcess = child;
  } catch (error) {
    runtimeProcess = null;
    throw new Error(`Could not start llama-server: ${error instanceof Error ? error.message : String(error)}`);
  }
  runtimeStatus = { running: true, message: 'Starting llama.cpp server…', baseUrl: `http://127.0.0.1:${settings.port}/v1`, pid: child.pid };
  child.stdout.on('data', (data: Buffer) => emitRuntime(data.toString('utf8').trimEnd()));
  child.stderr.on('data', (data: Buffer) => emitRuntime(data.toString('utf8').trimEnd()));
  child.once('error', (error) => {
    runtimeStatus = { running: false, message: `Runtime error: ${error.message}`, baseUrl: `http://127.0.0.1:${settings.port}/v1` };
    runtimeProcess = null;
    publishRuntime();
  });
  child.once('exit', (code) => {
    runtimeStatus = { running: false, message: code === 0 ? 'Local runtime stopped' : `llama-server exited (${code ?? 'unknown'})`, baseUrl: `http://127.0.0.1:${settings.port}/v1` };
    runtimeProcess = null;
    publishRuntime();
    emitRuntime(runtimeStatus.message);
  });
  publishRuntime('Starting llama.cpp server…');
  const readyUrl = `http://127.0.0.1:${settings.port}/health`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!runtimeProcess) throw new Error(runtimeStatus.message || 'llama-server exited before becoming ready.');
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(700) });
      if (response.ok) {
        runtimeStatus = { running: true, message: 'Local model is ready', baseUrl: `http://127.0.0.1:${settings.port}/v1`, pid: child.pid };
        publishRuntime('Local model is ready');
        try {
          const localProvider = currentState().providers.find((item) => item.id === 'llamacpp');
          if (localProvider) store.updateProviderModels('llamacpp', await discoverModels(localProvider), 'active');
        } catch (error) {
          emitRuntime(`Server is healthy, but model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return currentState();
      }
    } catch { /* wait for llama-server startup */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  runtimeStatus = { running: Boolean(runtimeProcess), message: 'llama-server started, but its health endpoint did not respond yet.', baseUrl: `http://127.0.0.1:${settings.port}/v1`, pid: child.pid };
  publishRuntime();
  return currentState();
}

async function stopLocalRuntime() {
  if (runtimeProcess) {
    const child = runtimeProcess;
    runtimeStatus = { ...runtimeStatus, message: 'Stopping local runtime…' };
    publishRuntime();
    child.kill();
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2500);
      child.once('exit', () => { clearTimeout(timeout); resolve(undefined); });
    });
    if (runtimeProcess === child) runtimeProcess = null;
  }
  const settings = currentState().settings.localRuntime;
  runtimeStatus = { running: false, message: 'Local runtime stopped', baseUrl: `http://127.0.0.1:${settings.port}/v1` };
  publishRuntime();
  return currentState();
}

function listLocalModels() {
  const modelRoot = path.join(app.getPath('userData'), 'models');
  const results: Array<{ name: string; path: string; size: number }> = [];
  const visit = (folder: string) => {
    if (!fs.existsSync(folder) || results.length > 500) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const itemPath = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(itemPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        try { results.push({ name: entry.name, path: itemPath, size: fs.statSync(itemPath).size }); } catch { /* skip */ }
      }
    }
  };
  visit(modelRoot);
  return results;
}

app.whenReady().then(() => {
  store = new StateStore();
  chatSessionStore = new ChatSessionStore(path.join(app.getPath('userData'), 'chat-sessions.json'));
  registerProjectPreviewProtocol();
  mcpManager = new McpManager(store, publishMcpState);
  addIpcHandlers();
  initializeUpdateManager(() => mainWindow);
  publishRuntime();
  createWindow();
  void mcpManager.connectEnabled().then(publishMcpState).catch(() => {});
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let finalizingQuit = false;
app.on('before-quit', (event) => {
  if (finalizingQuit) return;
  event.preventDefault();
  finalizingQuit = true;
  if (runtimeProcess) runtimeProcess.kill();
  void Promise.race([mcpManager?.dispose() || Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 1500))]).finally(() => app.quit());
});
