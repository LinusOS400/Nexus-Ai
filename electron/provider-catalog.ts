import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo, ProviderCatalogEntry, ProviderCatalogResult, ProviderKind } from '../shared/types';

export const DEFAULT_PROVIDER_CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_MAX_BYTES = 18 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 12_000;
const MAX_MODELS_PER_PROVIDER = 120;
const CACHE_FRESH_MS = 6 * 60 * 60 * 1000;

const fallbackEntries: ProviderCatalogEntry[] = [
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', docsUrl: 'https://platform.openai.com/docs', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', docsUrl: 'https://docs.anthropic.com', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'google', name: 'Google AI Studio', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', docsUrl: 'https://ai.google.dev/gemini-api/docs', modelCount: 0, freeModelCount: 0, freeTierHint: 'Free tier on selected models; limits vary by project.', models: [] },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', docsUrl: 'https://openrouter.ai/docs', modelCount: 0, freeModelCount: 0, freeTierHint: 'Some models have free routes; current limits vary.', models: [] },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', docsUrl: 'https://console.groq.com/docs', modelCount: 0, freeModelCount: 0, freeTierHint: 'Free developer tier available; model and rate limits vary.', models: [] },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai-compatible', baseUrl: 'https://api.cerebras.ai/v1', docsUrl: 'https://inference-docs.cerebras.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'mistral', name: 'Mistral AI', kind: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', docsUrl: 'https://docs.mistral.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'togetherai', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', docsUrl: 'https://docs.together.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'fireworks-ai', name: 'Fireworks AI', kind: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', docsUrl: 'https://docs.fireworks.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'deepinfra', name: 'Deep Infra', kind: 'openai-compatible', baseUrl: 'https://api.deepinfra.com/v1/openai', docsUrl: 'https://deepinfra.com/docs', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'huggingface', name: 'Hugging Face Inference', kind: 'openai-compatible', baseUrl: 'https://router.huggingface.co/v1', docsUrl: 'https://huggingface.co/docs/inference-providers', modelCount: 0, freeModelCount: 0, freeTierHint: 'Small free credits may be available; check current terms.', models: [] },
  { id: 'sambanova', name: 'SambaNova Cloud', kind: 'openai-compatible', baseUrl: 'https://api.sambanova.ai/v1', docsUrl: 'https://docs.sambanova.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai-compatible', baseUrl: 'https://api.perplexity.ai', docsUrl: 'https://docs.perplexity.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'xai', name: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', docsUrl: 'https://docs.x.ai', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1', docsUrl: 'https://docs.api.nvidia.com/nim', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'cohere', name: 'Cohere', kind: 'openai-compatible', baseUrl: 'https://api.cohere.com/compatibility/v1', docsUrl: 'https://docs.cohere.com', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'siliconflow', name: 'SiliconFlow', kind: 'openai-compatible', baseUrl: 'https://api.siliconflow.com/v1', docsUrl: 'https://docs.siliconflow.com', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'novita-ai', name: 'Novita AI', kind: 'openai-compatible', baseUrl: 'https://api.novita.ai/v3/openai', docsUrl: 'https://novita.ai/docs', modelCount: 0, freeModelCount: 0, models: [] },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', docsUrl: 'https://docs.ollama.com/openai', modelCount: 0, freeModelCount: 0, freeTierHint: 'Local inference; model runtime and hardware are yours.', models: [] },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', docsUrl: 'https://lmstudio.ai/docs/app/api', modelCount: 0, freeModelCount: 0, freeTierHint: 'Local inference; model runtime and hardware are yours.', models: [] },
];

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
function safeUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 500) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.protocol === 'https:') return url.toString().replace(/\/+$/, '');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(host)) return url.toString().replace(/\/+$/, '');
  } catch { /* invalid catalog URL */ }
  return '';
}
function canonicalKind(id: string, provider: Record<string, any>): ProviderKind | undefined {
  const key = id.toLowerCase();
  const npm = typeof provider.npm === 'string' ? provider.npm.toLowerCase() : '';
  if (key === 'anthropic' || npm === '@ai-sdk/anthropic') return 'anthropic';
  if (['google', 'google-ai-studio', 'gemini'].includes(key) || npm === '@ai-sdk/google') return 'gemini';
  if (safeUrl(provider.api)) return 'openai-compatible';
  return fallbackEntries.find((entry) => entry.id === key)?.kind;
}
function providerBaseUrl(id: string, raw: Record<string, any>) {
  return safeUrl(raw.api) || fallbackEntries.find((entry) => entry.id === id.toLowerCase())?.baseUrl || '';
}

export function parseModelsDevCatalog(raw: unknown): ProviderCatalogEntry[] {
  if (!isRecord(raw)) throw new Error('Provider catalog was not a JSON object.');
  const parsed: ProviderCatalogEntry[] = [];
  for (const [providerKey, rawProvider] of Object.entries(raw)) {
    if (!isRecord(rawProvider)) continue;
    const id = String(rawProvider.id || providerKey).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(id)) continue;
    const kind = canonicalKind(id, rawProvider);
    const baseUrl = providerBaseUrl(id, rawProvider);
    if (!kind || !baseUrl) continue;
    const rawModels = isRecord(rawProvider.models) ? Object.entries(rawProvider.models) : [];
    const normalized = rawModels.flatMap(([modelKey, modelValue]) => {
      if (!isRecord(modelValue) || modelValue.status === 'deprecated') return [];
      const modelId = String(modelValue.id || modelKey).trim();
      if (!modelId || modelId.length > 200) return [];
      const cost = isRecord(modelValue.cost) ? modelValue.cost : {};
      const inputCost = Number.isFinite(Number(cost.input)) ? Number(cost.input) : undefined;
      const outputCost = Number.isFinite(Number(cost.output)) ? Number(cost.output) : undefined;
      const model: ModelInfo = {
        id: modelId,
        name: String(modelValue.name || modelId).slice(0, 160),
        providerId: id,
        contextLength: positiveNumber(modelValue.limit?.context),
        outputLength: positiveNumber(modelValue.limit?.output),
        description: typeof modelValue.description === 'string' ? modelValue.description.slice(0, 500) : undefined,
        family: typeof modelValue.family === 'string' ? modelValue.family.slice(0, 80) : undefined,
        inputCostPerMillion: inputCost,
        outputCostPerMillion: outputCost,
        isFree: inputCost === 0 && outputCost === 0,
        supportsTools: Boolean(modelValue.tool_call),
      };
      return [model];
    });
    const modelCount = normalized.length;
    const freeModelCount = normalized.filter((model) => model.isFree).length;
    const fallback = fallbackEntries.find((entry) => entry.id === id);
    const entry: ProviderCatalogEntry = {
      id,
      name: String(rawProvider.name || fallback?.name || id).slice(0, 80),
      kind,
      baseUrl,
      docsUrl: safeUrl(rawProvider.doc) || fallback?.docsUrl,
      modelCount,
      freeModelCount,
      freeTierHint: fallback?.freeTierHint,
      models: normalized
        .sort((a, b) => Number(Boolean(b.isFree)) - Number(Boolean(a.isFree)) || Number(Boolean(b.supportsTools)) - Number(Boolean(a.supportsTools)) || a.name.localeCompare(b.name))
        .slice(0, MAX_MODELS_PER_PROVIDER),
    };
    parsed.push(entry);
  }

  const merged = new Map<string, ProviderCatalogEntry>();
  for (const entry of fallbackEntries) merged.set(entry.id, entry);
  for (const entry of parsed) {
    const fallback = merged.get(entry.id);
    merged.set(entry.id, { ...fallback, ...entry, freeTierHint: entry.freeTierHint || fallback?.freeTierHint });
  }
  return [...merged.values()].sort((a, b) => Number(b.freeModelCount > 0) - Number(a.freeModelCount > 0) || a.name.localeCompare(b.name));
}

function readCached(cachePath: string, catalogUrl: string): ProviderCatalogResult | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { catalogUrl?: string; result?: ProviderCatalogResult };
    if (raw.catalogUrl !== catalogUrl || !raw.result || !Array.isArray(raw.result.entries)) return undefined;
    const entries = raw.result.entries.filter((entry) => isRecord(entry) && typeof entry.id === 'string' && typeof entry.baseUrl === 'string') as ProviderCatalogEntry[];
    if (!entries.length) return undefined;
    return { entries, fetchedAt: raw.result.fetchedAt, source: 'cache' };
  } catch { return undefined; }
}

function catalogUrlIsSafe(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.toString().length < 1000;
  } catch { return false; }
}

export async function getProviderCatalog(cachePath: string, sourceUrl = DEFAULT_PROVIDER_CATALOG_URL, forceRefresh = false): Promise<ProviderCatalogResult> {
  const url = sourceUrl.trim() || DEFAULT_PROVIDER_CATALOG_URL;
  const cached = readCached(cachePath, url);
  if (!forceRefresh && cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < CACHE_FRESH_MS) return cached;
  try {
    if (!catalogUrlIsSafe(url)) throw new Error('Provider catalog URL must use HTTPS and cannot include credentials or fragments.');
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Nexus-Studio-provider-catalog' }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Provider catalog returned HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > CATALOG_MAX_BYTES) throw new Error('Provider catalog is larger than the 18 MB safety limit.');
    const entries = parseModelsDevCatalog(JSON.parse(text));
    const result: ProviderCatalogResult = { entries, fetchedAt: new Date().toISOString(), source: 'live' };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ catalogUrl: url, result }), { mode: 0o600 });
    fs.renameSync(tempPath, cachePath);
    return result;
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    if (cached) return { ...cached, warning };
    return { entries: parseModelsDevCatalog({}), source: 'builtin', warning };
  }
}

export function fallbackProviderCatalog(): ProviderCatalogResult {
  return { entries: fallbackEntries, source: 'builtin' };
}
