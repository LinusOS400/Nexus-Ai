import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const grammars: Record<string, typeof javascript> = {
  bash, sh: bash, shell: bash, zsh: bash,
  c, cpp, 'c++': cpp, h: c, hpp: cpp,
  cs: csharp, csharp,
  css, scss: css, less: css,
  diff, patch: diff,
  go,
  ini, toml: ini,
  java,
  js: javascript, javascript, jsx: javascript, mjs: javascript, cjs: javascript,
  json, jsonc: json,
  kt: kotlin, kotlin,
  md: markdown, markdown,
  php,
  ps1: powershell, powershell,
  py: python, python,
  rs: rust, rust,
  sql,
  ts: typescript, typescript, tsx: typescript,
  html: xml, xml, svg: xml, vue: xml,
  yml: yaml, yaml,
};

for (const [name, grammar] of Object.entries(grammars)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar);
}

const aliases: Record<string, string> = {
  htm: 'html', xhtml: 'xml', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash',
  shell: 'bash', zsh: 'bash', ps1: 'powershell', yml: 'yaml', rs: 'rust', kt: 'kotlin',
  h: 'c', hpp: 'cpp', 'c++': 'cpp', cs: 'csharp', patch: 'diff', vue: 'xml',
};

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

export function highlightSource(code: string, rawLanguage = '') {
  if (code.length > 200_000) return escapeHtml(code);
  try {
    const language = aliases[rawLanguage.toLowerCase()] || rawLanguage.toLowerCase();
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}
