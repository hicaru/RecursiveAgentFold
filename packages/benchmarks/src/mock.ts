import { ScriptedLLM, type LLMQueryOptions } from '@raf/engine';
import type { BenchModels } from './config.js';

/**
 * Offline stand-ins for the live models (`--mock`). They exercise the full
 * harness — store, chunking, llm_query fan-out, folding, scoring, reports and
 * the prefix-cache simulator — without network access. Scores are meaningless.
 */
export function createMockModels(llmQuery: LLMQueryOptions = {}): BenchModels {
  const query = new ScriptedLLM(
    (req) => {
      const chunk = req.messages[1]?.content ?? '';
      const lines = chunk.split('\n').length - 2;
      const q = req.messages[2]?.content ?? '';
      if (/EXTRACT/.test(q)) return JSON.stringify({ relevant: true, answer: `counted ${Math.max(0, lines)} lines; label counts unknown (mock)`, evidence: [] });
      const words = (/Query: (.*)/.exec(q)?.[1] ?? '').toLowerCase().match(/[a-z]{5,}/g) ?? [];
      const hitLine = chunk.split('\n').find((l) => words.some((w) => l.toLowerCase().includes(w)) && /^\d+\|/.test(l));
      return hitLine
        ? JSON.stringify({ relevant: true, answer: 'possible match (mock)', evidence: [{ line: Number(hitLine.split('|')[0]), quote: hitLine.slice(0, 80) }] })
        : '{"relevant": false, "answer": "", "evidence": []}';
    },
    { name: 'mock-reader', contextWindow: 128_000, maxOutputTokens: 1024 },
  );
  const root = new ScriptedLLM(
    (req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      if (req.purpose === 'direct') return 'Answer: 0';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Map a count over all chunks first.</motivation>\n<tool_call>{"name":"llm_query","arguments":{"query":"Classify every line into its label and return the count per label as JSON.","mode":"extract"}}</tool_call>';
      }
      if (step === 1) {
        return '<folding>{"range":[0,0],"summary":"llm_query extract over all chunks returned per-chunk counts (mock)."}</folding>\n<motivation>Check one region precisely.</motivation>\n<tool_call>{"name":"grep","arguments":{"pattern":"User: 1","max_matches":5}}</tool_call>';
      }
      return `<folding>{"range":[0,${step - 1}],"summary":"Counts aggregated (mock)."}</folding>\n<answer>Answer: 0</answer>`;
    },
    { name: 'mock-root', contextWindow: 200_000, maxOutputTokens: 4096 },
  );
  return {
    root,
    branch: root,
    query,
    llmQuery,
    describe: () => ({ mock: true, llmQuery }),
  };
}
