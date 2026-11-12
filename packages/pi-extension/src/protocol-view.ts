/**
 * Display-only rewrite of the AgentFold XML protocol while a root step streams.
 * Markdown code spans and fenced code blocks are preserved verbatim.
 */

const PROTOCOL_TAG = /<\s*\/?\s*(?:think|folding|folded_output|fold|motivation|explanation|tool_call|answer)\b/i;
const CODE_SPAN_RE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

function foldLabel(attrs: string, body: string): string {
  const attrRange = /range\s*=\s*["']?\s*(\d+)\s*[-,:]\s*(\d+)/i.exec(attrs);
  let range = attrRange ? `${attrRange[1]}–${attrRange[2]}` : '';
  let summary = body.trim();
  if (summary.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(summary);
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.summary === 'string') summary = rec.summary;
        if (range === '' && Array.isArray(rec.range) && rec.range.length === 2) {
          range = `${String(rec.range[0])}–${String(rec.range[1])}`;
        }
      }
    } catch {
      const loose = /"summary"\s*:\s*"([\s\S]*)/.exec(summary);
      if (loose?.[1] !== undefined) summary = loose[1].replace(/"\s*}?\s*$/, '');
    }
  }
  const head = range === '' ? '⟲ fold' : `⟲ fold ${range}`;
  return `> **${head}** · ${summary.replace(/\s+/g, ' ').trim()}\n\n`;
}

/** Rewrite protocol tags into readable Markdown while preserving code blocks. */
export function renderProtocolMarkdown(text: string): string {
  if (!PROTOCOL_TAG.test(text)) return text;
  const codeVault: string[] = [];
  const masked = text.replace(CODE_SPAN_RE, (span) => {
    const idx = codeVault.length;
    codeVault.push(span);
    return `\uE000RAF_CODE_${idx}\uE001`;
  });
  let out = masked;
  out = out.replace(/<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
  out = out.replace(/<\s*think\b[^>]*>[\s\S]*$/i, '');
  out = out.replace(
    /<\s*(?:folding|folded_output|fold)\b([^>]*)>([\s\S]*?)<\s*\/\s*(?:folding|folded_output|fold)\s*>/gi,
    (_m, attrs: string, body: string) => foldLabel(attrs, body),
  );
  out = out.replace(
    /<\s*(?:folding|folded_output|fold)\b([^>]*)>([\s\S]*)$/i,
    (_m, attrs: string, body: string) => `${foldLabel(attrs, body).trimEnd()} …\n\n`,
  );
  out = out.replace(
    /<\s*(?:motivation|explanation)\b[^>]*>([\s\S]*?)(?:<\s*\/\s*(?:motivation|explanation)\s*>|$)/gi,
    (_m, body: string) => `${body.trim()}\n\n`,
  );
  out = out.replace(/<\s*tool_call\b[^>]*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi, '');
  out = out.replace(/<\s*tool_call\b[\s\S]*$/i, '');
  out = out.replace(/<\s*\/?\s*answer\b[^>]*>/gi, '');
  if (codeVault.length > 0) {
    out = out.replace(/\uE000RAF_CODE_(\d+)\uE001/g, (_m, idxStr: string) => codeVault[Number(idxStr)] ?? '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
