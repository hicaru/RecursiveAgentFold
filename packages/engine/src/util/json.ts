/**
 * Tolerant JSON parsing for model output. Models (especially non-finetuned
 * ones) emit curly quotes, code fences, trailing commas, or prose around the
 * JSON object. The AgentFold paper itself shows a typeset `”summary"` key.
 */

const QUOTE_MAP: Record<string, string> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2033': '"',
};

export function normalizeQuotes(s: string): string {
  return s.replace(/[\u201c\u201d\u201e\u201f\u2033]/g, (c) => QUOTE_MAP[c] ?? c);
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return m?.[1] !== undefined ? m[1] : s;
}

/** Find the first balanced {...} or [...] block, respecting strings. */
export function extractBalanced(s: string, open = '{', close = '}'): string | undefined {
  const start = s.indexOf(open);
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Escape raw newlines/tabs that appear inside JSON string literals. */
function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) {
        esc = false;
        out += c;
        continue;
      }
      if (c === '\\') {
        esc = true;
        out += c;
        continue;
      }
      if (c === '"') inStr = false;
      if (c === '\n') {
        out += '\\n';
        continue;
      }
      if (c === '\r') continue;
      if (c === '\t') {
        out += '\\t';
        continue;
      }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

export function parseLooseJSON<T = unknown>(input: string): T {
  const attempts: string[] = [];
  const base = normalizeQuotes(stripFences(input)).trim();
  attempts.push(base);
  const obj = extractBalanced(base);
  if (obj) attempts.push(obj);
  const errors: string[] = [];
  for (const a of attempts) {
    for (const candidate of [a, escapeControlCharsInStrings(a), escapeControlCharsInStrings(a).replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return JSON.parse(candidate) as T;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  throw new Error(`Invalid JSON: ${errors[errors.length - 1] ?? 'unknown'}`);
}

export function tryParseLooseJSON<T = unknown>(input: string): T | undefined {
  try {
    return parseLooseJSON<T>(input);
  } catch {
    return undefined;
  }
}
