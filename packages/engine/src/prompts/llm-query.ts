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

export const LLM_QUERY_SYSTEM = `你是另一个代理调用的快速文档阅读器。若进行内部推理，必须极简：逐行分类/计数时严禁摘抄原文词句，只写「行号+单字母代号」（如 5D 6L 7H 8N）再统计各代号总数。只回答当前分块，只输出一个 JSON 对象：
{"relevant": true|false, "counts": {"<类别>": <整数>, ...}, "answer": "<本块结论>", "evidence": [{"line": <行号>, "quote": "<原文短引>"}]}
规则：
- 只用本块文本，不得猜测；行号是行首 "|" 前的数字。
- 仅当本块含能回答或帮助回答查询的信息时，"relevant" 才为 true。
- 要求按类别/值计数时，遍历整块填入 "counts"（查询点名的类别即使为 0 也要列出，引擎会自动跨分块求和），此时 "answer" 只需简短汇总并省略 "evidence"。
- 其他情况省略 "counts"，"answer" 不超过 120 词，"evidence" 最多 5 条。`;

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
      : '模式：EXTRACT — 对整块执行所需的抽取/分类/计数，按类别填入 "counts"，结论写入 "answer"（即使计数为 0，也设 "relevant": true）。';
  return `${modeLine}\n查询：${query}\n只输出 JSON 对象。`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
