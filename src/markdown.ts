export type MarkdownPart =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string; filename?: string };

const lineParts = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const withoutLineEnding = (line: string) => line.replace(/\r?\n$/, '');

function readFenceInfo(raw: string) {
  const info = raw.trim();
  const first = info.match(/^(?:\{)?\.?([^\s}]+)/)?.[1] || '';
  const language = first.replace(/^language-/i, '').replace(/[^a-zA-Z0-9_+#.-]/g, '').toLowerCase();
  const filenameMatch = info.match(/(?:^|\s)(?:filename|file|title)=["']?([^"'\s}]+)["']?/i);
  const filename = filenameMatch?.[1]?.replace(/^.*[\\/]/, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);
  return { language, ...(filename ? { filename } : {}) };
}

export function parseMarkdownParts(markdown: string): MarkdownPart[] {
  const lines = lineParts(markdown);
  const parts: MarkdownPart[] = [];
  let plain = '';
  let index = 0;
  const flushPlain = () => {
    if (plain) parts.push({ type: 'text', text: plain });
    plain = '';
  };

  while (index < lines.length) {
    const line = withoutLineEnding(lines[index]);
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) {
      plain += lines[index];
      index += 1;
      continue;
    }

    flushPlain();
    const fence = opening[1];
    const metadata = readFenceInfo(opening[2]);
    const codeLines: string[] = [];
    index += 1;
    while (index < lines.length) {
      const candidate = withoutLineEnding(lines[index]);
      const closing = candidate.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        index += 1;
        break;
      }
      codeLines.push(lines[index]);
      index += 1;
    }
    parts.push({ type: 'code', code: codeLines.join('').replace(/\r?\n$/, ''), ...metadata });
  }

  flushPlain();
  return parts;
}

export function codeFileName(language: string, requestedName?: string) {
  const normalized = language.toLowerCase();
  if (normalized === 'dockerfile') return requestedName || 'Dockerfile';
  if (normalized === 'makefile') return requestedName || 'Makefile';
  const extensions: Record<string, string> = {
    html: '.html', xml: '.xml', svg: '.svg', css: '.css', scss: '.scss', less: '.less',
    js: '.js', javascript: '.js', jsx: '.jsx', ts: '.ts', typescript: '.ts', tsx: '.tsx',
    json: '.json', jsonc: '.jsonc', py: '.py', python: '.py', rb: '.rb', ruby: '.rb',
    sh: '.sh', bash: '.sh', zsh: '.sh', powershell: '.ps1', ps1: '.ps1', sql: '.sql',
    c: '.c', h: '.h', cpp: '.cpp', 'c++': '.cpp', csharp: '.cs', cs: '.cs', java: '.java',
    go: '.go', rust: '.rs', rs: '.rs', php: '.php', swift: '.swift', kotlin: '.kt',
    yaml: '.yml', yml: '.yml', toml: '.toml', md: '.md', markdown: '.md', diff: '.diff',
    dockerfile: '.dockerfile', makefile: '.makefile', plaintext: '.txt', text: '.txt',
  };
  if (requestedName && /\.[a-z0-9]{1,10}$/i.test(requestedName)) return requestedName;
  const extension = extensions[language.toLowerCase()] || '.txt';
  return `${requestedName || 'snippet'}${extension}`;
}
