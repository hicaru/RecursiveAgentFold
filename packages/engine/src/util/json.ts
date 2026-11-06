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

/**
 * Escape raw newlines/tabs, fix invalid single-backslash escapes (e.g. `\.`, `\d`),
 * and close a truncated trailing string before the final `}`.
 */
export function repairJSONStringLiterals(s: string, escapeInnerQuotes = false): string {
  const out: string[] = [];
  const openStack: string[] = [];
  let inStr = false;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s[i] ?? '';
    if (inStr) {
      if (c === '\\') {
        const next = s[i + 1];
        if (next === undefined) {
          out.push('\\\\');
          continue;
        }
        if (
          next === '"' ||
          next === '\\' ||
          next === '/' ||
          next === 'b' ||
          next === 'f' ||
          next === 'n' ||
          next === 'r' ||
          next === 't' ||
          (next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6)))
        ) {
          out.push('\\', next);
          i++;
          continue;
        }
        out.push('\\\\');
        continue;
      }
      if (c === '"') {
        if (escapeInnerQuotes) {
          let j = i + 1;
          while (j < len && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
          const nextChar = s[j];
          const isClosing =
            nextChar === undefined ||
            nextChar === ':' ||
            nextChar === '}' ||
            nextChar === ']' ||
            (nextChar === ',' && /^\s*(?:["{\[\-\d]|true\b|false\b|null\b|[}\]])/.test(s.slice(j + 1)));
          if (!isClosing) {
            out.push('\\"');
            continue;
          }
        }
        inStr = false;
        out.push(c);
        continue;
      }
      if (c === '}' && /^\s*$/.test(s.slice(i + 1))) {
        inStr = false;
        out.push('"', '}');
        if (openStack[openStack.length - 1] === '}') openStack.pop();
        continue;
      }
      if (c === '\n') {
        out.push('\\n');
        continue;
      }
      if (c === '\r') continue;
      if (c === '\t') {
        out.push('\\t');
        continue;
      }
      out.push(c);
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') openStack.push('}');
      else if (c === '[') openStack.push(']');
      else if ((c === '}' || c === ']') && openStack[openStack.length - 1] === c) openStack.pop();
      out.push(c);
    }
  }
  if (inStr) out.push('"');
  while (openStack.length > 0) out.push(openStack.pop() ?? '');
  return out.join('');
}

export function parseLooseJSON<T = unknown>(input: string): T {
  const raw = stripFences(input).trim();
  const normalized = normalizeQuotes(raw);
  const bases: string[] = [raw];
  const balancedRaw = extractBalanced(raw);
  if (balancedRaw && balancedRaw !== raw) bases.push(balancedRaw);
  if (normalized !== raw) {
    bases.push(normalized);
    const balancedNorm = extractBalanced(normalized);
    if (balancedNorm && balancedNorm !== normalized) bases.push(balancedNorm);
  }
  const errors: string[] = [];
  for (const a of bases) {
    const repairedBasic = repairJSONStringLiterals(a, false);
    const repairedQuotes = repairJSONStringLiterals(a, true);
    const candidates = [
      a,
      repairedBasic,
      repairedBasic.replace(/,\s*([}\]])/g, '$1'),
      repairedQuotes,
      repairedQuotes.replace(/,\s*([}\]])/g, '$1'),
    ];
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  throw new Error(`Invalid JSON: ${errors[0] ?? 'unknown'}`);
}

export function tryParseLooseJSON<T = unknown>(input: string): T | undefined {
  try {
    return parseLooseJSON<T>(input);
  } catch {
    return undefined;
  }
}
