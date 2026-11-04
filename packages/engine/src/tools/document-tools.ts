import { truncateToTokens } from '../tokens.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

export interface DocumentToolOptions {
  /** Max lines returned by one read. Default 200. */
  maxReadLines?: number;
  /** Max tokens returned by one read. Default 4000. */
  maxReadTokens?: number;
  /** Max matching lines listed by grep. Default 40. */
  maxGrepMatches?: number;
}

export function createListDocumentsTool(): Tool {
  return {
    name: 'list_documents',
    description: '列出已存文档（id、标题、token 数、行数）。',
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      return ctx.store.manifest();
    },
  };
}

export function createGrepTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'grep',
    description:
      '对已存文档做正则搜索（JavaScript 正则，默认忽略大小写）。返回每个文档的匹配行总数，以及前若干匹配行和行号。用于精确字符串/模式或统计出现次数。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则表达式。' },
        documents: { type: 'array', items: { type: 'string' }, description: '文档 id（默认：全部）。' },
        case_sensitive: { type: 'boolean', default: false },
        max_matches: { type: 'integer', description: `列出多少行（默认 ${opts.maxGrepMatches ?? 40}，最大 200）。` },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern')!;
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`无效正则：${(e as Error).message}`);
      }
      const max = Math.min(200, argNumber(args, 'max_matches') ?? opts.maxGrepMatches ?? 40);
      const r = ctx.store.grep(pattern, {
        docIds: argStringList(args, 'documents'),
        ignoreCase: args.case_sensitive !== true,
        maxMatches: max,
      });
      const head = `grep /${pattern}/：${r.total} 行匹配 — ${Object.entries(r.perDoc)
        .map(([d, n]) => `${d}: ${n}`)
        .join('，')}`;
      const body = r.matches.map((m) => `${m.docId}:${m.line}| ${m.text}`).join('\n');
      const more = r.total > r.matches.length ? `\n… 另有 ${r.total - r.matches.length} 行匹配未显示` : '';
      return truncateToTokens(`${head}${body ? `\n${body}` : ''}${more}`, opts.maxReadTokens ?? 4000).text;
    },
  };
}

export function createTallyTool(): Tool {
  return {
    name: 'tally',
    description:
      '对已存文档中的正则匹配做精确频次统计。正则有捕获组时，按组 1 的不同值计数（例如 "User: (\\\\d+)" 统计每个用户 id 的出现次数）；否则按整个匹配计数。按频次从高到低返回。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript 正则，可含一个捕获组。' },
        documents: { type: 'array', items: { type: 'string' } },
        case_sensitive: { type: 'boolean', default: false },
        top: { type: 'integer', description: '列出多少个值（默认 25，最大 200）。' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern')!;
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`无效正则：${(e as Error).message}`);
      }
      const top = Math.min(200, argNumber(args, 'top') ?? 25);
      const r = ctx.store.tally(pattern, { docIds: argStringList(args, 'documents'), ignoreCase: args.case_sensitive !== true });
      const rows = r.counts.slice(0, top).map(([k, n]) => `${n}\t${k}`);
      return `tally /${pattern}/：${r.totalMatches} 个匹配，${r.distinct} 个不同值${r.distinct > top ? `（仅显示前 ${top} 个）` : ''}\n次数\t值\n${rows.join('\n')}`;
    },
  };
}

export function createReadTool(opts: DocumentToolOptions = {}): Tool {
  const maxLines = opts.maxReadLines ?? 200;
  return {
    name: 'read',
    description: `读取已存文档的精确行区间（每次最多 ${maxLines} 行）。仅用于对 llm_query 或 grep 定位到的位置做精确确认。`,
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string' },
        start_line: { type: 'integer', description: '从 1 开始，含端点。' },
        end_line: { type: 'integer', description: '从 1 开始，含端点。' },
      },
      required: ['document', 'start_line', 'end_line'],
    },
    async execute(args, ctx) {
      const doc = argString(args, 'document')!;
      const s = argNumber(args, 'start_line') ?? 1;
      let e = argNumber(args, 'end_line') ?? s + maxLines - 1;
      let note = '';
      if (e - s + 1 > maxLines) {
        e = s + maxLines - 1;
        note = `（已限制为 ${maxLines} 行）`;
      }
      const r = ctx.store.read(doc, s, e);
      const header = `${doc} 第 ${r.startLine}-${r.endLine} 行，共 ${r.totalLines} 行${note}`;
      return truncateToTokens(`${header}\n${r.text}`, opts.maxReadTokens ?? 4000).text;
    },
  };
}
