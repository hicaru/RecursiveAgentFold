/**
 * Prompts for llm_query — the non-thinking chunk reader.
 *
 * Cache layout per chunk call:
 *   [system] LLM_QUERY_SYSTEM                       ← static
 *   [user]   <document …> chunk text </document>    ← byte-identical for the same chunk
 *   [user]   query + output contract                ← varies
 * Because the chunk precedes the query, every new query over an
 * already-scanned chunk reuses the cached prefix (system + chunk).
 */

export const LLM_QUERY_SYSTEM = `你是另一个代理调用的快速文档阅读器。不要展开思考，只回答当前这一个分块，只输出一个 JSON 对象：
{"relevant": true|false, "answer": "<本块结论>", "evidence": [{"line": <行号>, "quote": "<原文短引>"}]}
规则：
- 只用本块文本，不得猜测。
- 仅当本块含能回答或帮助回答查询的信息时，"relevant" 才为 true。
- 行号是行首 "|" 前的数字。
- "answer" 不超过 120 词，evidence 最多 5 条；查询要求列表或计数时除外。
- 要求计数/分类/抽取时，遍历整块，把结果放进 "answer"。
- 要求按类别/值计数时，另加 "counts": {"<类别>": <整数>, ...}；查询点名的类别即使为 0 也要列出。引擎会自动跨分块求和。`;

export function renderChunkMessage(args: {
  docId: string;
  title: string;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  body: string;
}): string {
  return `<document id="${args.docId}" title="${escapeAttr(args.title)}" chunk="${args.index + 1}/${args.total}" lines="${args.startLine}-${args.endLine}">\n${args.body}\n</document>`;
}

export type LLMQueryMode = 'locate' | 'extract';

export function renderQueryMessage(query: string, mode: LLMQueryMode): string {
  const modeLine =
    mode === 'locate'
      ? '模式：LOCATE — 判断本块是否包含查询目标；若有，指出精确行。'
      : '模式：EXTRACT — 对整块执行所需的抽取/分类/计数，把结果写入 "answer"（即使计数为 0，也设 "relevant": true）。';
  return `${modeLine}\n查询：${query}\n只输出 JSON 对象。`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
