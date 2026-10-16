import fs from 'node:fs';
import path from 'node:path';
import type { ChatDeleteMessageResult, ChatMessageRecord, ChatSession, ChatSessionSummary, ToolTrace } from '../shared/types';

const MAX_SESSIONS = 60;
const MAX_MESSAGES = 240;
const MAX_SESSION_BYTES = 3_000_000;
const MAX_FILE_BYTES = 24_000_000;
const MAX_MESSAGE_CHARS = 120_000;
const MAX_REASONING_CHARS = 120_000;
const MAX_TOOL_TRACES = 40;

function safeString(value: unknown, max: number, fallback = '') {
  return (typeof value === 'string' ? value : fallback).slice(0, max);
}

function normalizeTrace(raw: unknown): ToolTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const trace = raw as Record<string, unknown>;
  const state = ['running', 'complete', 'error', 'denied'].includes(String(trace.state)) ? trace.state as ToolTrace['state'] : 'complete';
  let args: Record<string, unknown> = {};
  try {
    const encoded = JSON.stringify(trace.arguments && typeof trace.arguments === 'object' ? trace.arguments : {});
    args = encoded.length <= 16_000 ? JSON.parse(encoded) : { preview: `${encoded.slice(0, 15_000)}…`, truncated: true };
  } catch { args = { preview: '[Arguments omitted]' }; }
  return {
    id: safeString(trace.id, 120, `trace-${Date.now()}`),
    name: safeString(trace.name, 160, 'tool'),
    ...(typeof trace.label === 'string' ? { label: safeString(trace.label, 200) } : {}),
    arguments: args,
    state,
    ...(typeof trace.result === 'string' ? { result: trace.result.slice(0, 12_000) } : {}),
  };
}

function normalizeMessage(raw: unknown): ChatMessageRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const traces = Array.isArray(message.toolTraces) ? message.toolTraces.slice(-MAX_TOOL_TRACES).map(normalizeTrace).filter((item): item is ToolTrace => Boolean(item)) : [];
  return {
    id: safeString(message.id, 120, `message-${Date.now()}`),
    role: message.role,
    content: safeString(message.content, MAX_MESSAGE_CHARS),
    ...(typeof message.reasoning === 'string' && message.reasoning ? { reasoning: message.reasoning.slice(0, MAX_REASONING_CHARS) } : {}),
    ...(traces.length ? { toolTraces: traces } : {}),
    ...(message.error === true ? { error: true } : {}),
    createdAt: Number.isFinite(Number(message.createdAt)) ? Number(message.createdAt) : Date.now(),
  };
}

function normalizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as Record<string, unknown>;
  const id = safeString(session.id, 80);
  if (!/^[a-z0-9_-]{8,80}$/i.test(id)) return null;
  const messages = Array.isArray(session.messages) ? session.messages.slice(-MAX_MESSAGES).map(normalizeMessage).filter((item): item is ChatMessageRecord => Boolean(item)) : [];
  const firstUser = messages.find((message) => message.role === 'user')?.content.trim();
  const title = safeString(session.title, 100, firstUser || 'New conversation').trim() || firstUser?.slice(0, 100) || 'New conversation';
  const createdAt = Number.isFinite(Number(session.createdAt)) ? Number(session.createdAt) : Date.now();
  return {
    id,
    title,
    createdAt,
    updatedAt: Number.isFinite(Number(session.updatedAt)) ? Number(session.updatedAt) : createdAt,
    providerId: safeString(session.providerId, 80),
    modelId: safeString(session.modelId, 200),
    messages,
  };
}

function summary(session: ChatSession): ChatSessionSummary {
  return { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, providerId: session.providerId, modelId: session.modelId, messageCount: session.messages.length };
}

export class ChatSessionStore {
  private sessions = new Map<string, ChatSession>();

  constructor(private readonly filePath: string) {
    this.read();
  }

  private read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { sessions?: unknown[] };
      const rows = Array.isArray(raw.sessions) ? raw.sessions : [];
      this.sessions = new Map(rows.map(normalizeSession).filter((item): item is ChatSession => Boolean(item)).map((session) => [session.id, session]));
      this.trim();
    } catch { this.sessions = new Map(); }
  }

  private ordered() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private trim() {
    const rows = this.ordered();
    for (const session of rows) {
      let encoded = JSON.stringify(session);
      while (Buffer.byteLength(encoded, 'utf8') > MAX_SESSION_BYTES && session.messages.length > 1) {
        session.messages.shift();
        encoded = JSON.stringify(session);
      }
      if (!session.messages.length) this.sessions.delete(session.id);
    }
    const retained = this.ordered().slice(0, MAX_SESSIONS);
    this.sessions = new Map(retained.map((session) => [session.id, session]));
    let fileBytes = Buffer.byteLength(JSON.stringify({ version: 1, sessions: this.ordered() }), 'utf8');
    while (fileBytes > MAX_FILE_BYTES && this.sessions.size > 1) {
      const oldest = this.ordered().at(-1);
      if (!oldest) break;
      this.sessions.delete(oldest.id);
      fileBytes = Buffer.byteLength(JSON.stringify({ version: 1, sessions: this.ordered() }), 'utf8');
    }
  }

  private persist() {
    this.trim();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: this.ordered() }), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  list(): ChatSessionSummary[] { return this.ordered().map(summary); }

  get(sessionId: string): ChatSession | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  save(raw: unknown): ChatSessionSummary[] {
    const session = normalizeSession(raw);
    if (!session) throw new Error('Invalid chat session.');
    if (!session.messages.length) {
      this.sessions.delete(session.id);
      this.persist();
      return this.list();
    }
    const previous = this.sessions.get(session.id);
    if (previous) session.createdAt = previous.createdAt;
    session.updatedAt = Date.now();
    const firstUser = session.messages.find((message) => message.role === 'user')?.content.trim();
    if (firstUser) session.title = firstUser.replace(/\s+/g, ' ').slice(0, 100);
    this.sessions.set(session.id, session);
    this.persist();
    return this.list();
  }

  delete(sessionId: string): ChatSessionSummary[] {
    this.sessions.delete(sessionId);
    this.persist();
    return this.list();
  }

  deleteMessage(sessionId: string, messageId: string): ChatDeleteMessageResult {
    const current = this.sessions.get(sessionId);
    if (!current) return { session: null, sessions: this.list() };
    const remaining = current.messages.filter((message) => message.id !== messageId);
    if (remaining.length === current.messages.length) return { session: structuredClone(current), sessions: this.list() };
    if (!remaining.length) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { ...current, messages: remaining, updatedAt: Date.now() });
    this.persist();
    return { session: this.get(sessionId), sessions: this.list() };
  }

  clear(): ChatSessionSummary[] {
    this.sessions.clear();
    this.persist();
    return [];
  }
}
