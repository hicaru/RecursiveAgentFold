import { describe, expect, it } from 'vitest';
import { parseGold, parseOolongAnswer, scoreOolong, scoreOolongLenient } from '../src/oolong/scoring.js';
import { buildNeedleTasks } from '../src/needle/needle.js';
import { buildCodeGraphTasks } from '../src/codegraph/codegraph.js';
import { parseChoiceLetter, splitContextIntoDocuments } from '../src/longbench/tasks.js';
import { buildLongBenchProTasks, parseAnswerItems } from '../src/longbench-pro/tasks.js';
import { buildRulerTasks, parseAnswerList } from '../src/ruler/ruler.js';
import { buildMrcrTasks, parseBullets } from '../src/mrcr/mrcr.js';
import { priceFor } from '../src/pricing.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockModels } from '../src/mock.js';
import { runTasks } from '../src/runner.js';
import type { DshChecks } from '../src/dsh-host.js';
import { ScriptedLLM } from '@raf/engine';
describe('OOLONG scoring (official port)', () => {
  it('parses gold literals', () => {
    expect(parseGold("['location']").value).toBe('location');
    expect(parseGold('[12]').value).toBe('12');
    expect(parseGold('["more common than human being"]').value).toBe('more common than human being');
    expect(parseGold('[datetime.date(2023, 5, 1)]').date?.toISOString().slice(0, 10)).toBe('2023-05-01');
  });

  it('parse_answer semantics', () => {
    expect(parseOolongAnswer('Label: location')).toEqual({ candidate: 'location', confidence: 'vhigh' });
    expect(parseOolongAnswer('short')).toEqual({ candidate: 'short', confidence: 'low' });
    expect(parseOolongAnswer('the final number of items is 42').candidate).toBe('42');
    expect(parseOolongAnswer('Answer: entity is more common than human being in the data').candidate).toBe('more common');
  });

  it('scores labels, numerics, comparisons and dates', () => {
    expect(scoreOolong({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: location').score).toBe(1);
    expect(scoreOolong({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: Location').score).toBe(0);
    expect(scoreOolong({ answer: '[10]', answer_type: 'ANSWER_TYPE.NUMERIC' }, 'Answer: 12').score).toBeCloseTo(0.5625);
    expect(scoreOolong({ answer: "['more common than entity']", answer_type: 'ANSWER_TYPE.COMPARISON' }, 'Answer: location is more common than entity overall').score).toBe(1);
    expect(scoreOolong({ answer: '[datetime.date(2023, 5, 1)]', answer_type: 'ANSWER_TYPE.DATE' }, 'Date: May 1, 2023').score).toBe(1);
  });

  it('lenient variant is case-insensitive', () => {
    expect(scoreOolongLenient({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: Location')).toBe(1);
  });
});

describe('needle generator', () => {
  it('is deterministic and roughly sized', () => {
    const a = buildNeedleTasks({ tokens: 20_000, tasks: 2, seed: 3 });
    const b = buildNeedleTasks({ tokens: 20_000, tasks: 2, seed: 3 });
    expect(a[0]!.documents[0]!.text).toBe(b[0]!.documents[0]!.text);
    expect(a[0]!.documents[0]!.tokens).toBeGreaterThan(19_000);
    const gold = a[0]!.meta.gold as number;
    expect(a[0]!.score(`Answer: ${gold}`).score).toBe(1);
  });
});

describe('codegraph & longbench generators', () => {
  it('codegraph builds 8 deterministic module documents and scores spec_specialist, diamond_deps, and chain_hop', () => {
    const a = buildCodeGraphTasks({ tokens: 24_000, tasks: 3, hops: 3, seed: 7 });
    const b = buildCodeGraphTasks({ tokens: 24_000, tasks: 3, hops: 3, seed: 7 });
    expect(a).toHaveLength(3);
    expect(a[0]?.documents).toHaveLength(8);
    expect(a[0]?.documents.map((d) => d.id)).toEqual([
      'app_gateway',
      'service_order',
      'service_billing',
      'lib_auth',
      'lib_crypto',
      'lib_pricing',
      'lib_tax_rules',
      'spec_protocol',
    ]);
    expect(a[0]?.documents[0]?.text).toBe(b[0]?.documents[0]?.text);
    expect(a.map((t) => t.meta.task)).toEqual(['spec_specialist', 'diamond_deps', 'chain_hop']);
    for (const t of a) {
      const gold = t.meta.gold as number;
      expect(t.score(`Answer: ${gold}`).score).toBe(1);
      expect(t.score(`Answer: ${gold + 1}`).score).toBe(0);
    }
  });

  it('longbench splits multi-file contexts into documents and parses choice letters', () => {
    const ctx = [
      `=== File: src/a.ts ===\n${'const x = 1;\n'.repeat(30)}`,
      `=== File: src/b.ts ===\n${'const y = 2;\n'.repeat(30)}`,
    ].join('\n');
    const docs = splitContextIntoDocuments(ctx);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.id).toBe('doc_1');
    expect(docs[1]?.id).toBe('doc_2');
    expect(parseChoiceLetter('Answer: B')).toBe('B');
    expect(parseChoiceLetter('After checking all modules, the correct option is (C).')).toBe('C');
  });
});

describe('ruler / mrcr / longbench-pro generators', () => {
  it('ruler is deterministic, sized, and gold is findable in the haystack', () => {
    const a = buildRulerTasks({ tokens: 20_000, tasks: 1, seed: 7 });
    const b = buildRulerTasks({ tokens: 20_000, tasks: 1, seed: 7 });
    expect(a).toHaveLength(11);
    const first = a[0];
    const firstB = b[0];
    if (!first || !firstB) throw new Error('missing ruler task');
    expect(first.documents[0]?.text).toBe(firstB.documents[0]?.text);
    expect(first.documents[0]?.tokens).toBeGreaterThan(18_000);
    // gold answer must literally appear in the haystack for retrieval subtasks
    for (const t of a.slice(0, 8)) {
      const gold = String(t.meta.gold ?? '');
      expect(t.documents[0]?.text).toContain(gold.split(',')[0] ?? gold);
    }
    // scoring: exact gold → 1, junk → 0
    const single = a.find((t) => t.meta.task === 'niah_single_1');
    if (!single) throw new Error('missing niah_single_1');
    expect(single.score(`Answer: ${String(single.meta.gold)}`).score).toBe(1);
    expect(single.score('Answer: 000000').score).toBe(0);
    // cwe: all 10 → 1, partial → 0 with correct extra
    const cwe = a.find((t) => t.meta.task === 'cwe');
    if (!cwe) throw new Error('missing cwe');
    const goldList = String(cwe.meta.gold).split(',');
    expect(cwe.score(`Answer: ${goldList.join(', ')}`).score).toBe(1);
    const partial = cwe.score(`Answer: ${goldList.slice(0, 6).join(', ')}`);
    expect(partial.score).toBe(0);
    expect(partial.extra?.correct).toBe(6);
    // vt chain contains X1..XchainLen
    const vt = a.find((t) => t.meta.task === 'vt');
    if (!vt) throw new Error('missing vt');
    // one group per task: the runner shares a document store across a group,
    // and each ruler task owns a different haystack
    expect(new Set(a.map((t) => t.group)).size).toBe(a.length);
    expect(new Set(a.map((t) => t.documents[0]?.text)).size).toBe(a.length);
  });

  it('mrcr is deterministic and scores item-level F1', () => {
    const a = buildMrcrTasks({ tokens: 20_000, tasks: 3, seed: 5 });
    const b = buildMrcrTasks({ tokens: 20_000, tasks: 3, seed: 5 });
    expect(a).toHaveLength(3);
    expect(a[0]?.documents[0]?.text).toBe(b[0]?.documents[0]?.text);
    const t = a[0];
    if (!t) throw new Error('missing mrcr task');
    const gold = String(t.meta.gold).split(' || ');
    expect(gold.length).toBeGreaterThanOrEqual(1);
    const perfect = t.score(gold.map((g, i) => `- ${g}${i === 0 ? '.' : ''}`).join('\n'));
    expect(perfect.score).toBe(1);
    const half = t.score(`- ${gold[0]}`);
    expect(half.score).toBeGreaterThan(0);
    expect(half.score).toBeLessThan(1);
    expect(t.score('- completely unrelated sentence.').score).toBe(0);
    expect(parseBullets('1. alpha\n- beta\nAnswer: below').length).toBe(2);
  });

  it('longbench-pro scores unicode item lists: ordered=1, unordered=0.5, wrong=0', () => {
    const rows = [
      {
        _id: 'ret1',
        domain: 'T1. Retrieval & Ranking',
        difficulty: 'Easy',
        length: 'medium',
        question: 'Retrieve the articles. First output the "[Answer]" marker, then output each article number on its own line.',
        answer: 'Article 46,Article 47,Article 48',
        context: 'Chapter 1 General Provisions\n'.padEnd(300, 'x') + 'Chapter 5 Operational Services',
        token_length: 50_000,
      },
      {
        _id: 'en1',
        domain: 'T2. Sequencing',
        difficulty: 'Hard',
        length: 'long',
        question: 'Restore the order of fragments A-E.',
        answer: 'B,D,C,F,A,E',
        context: 'fragment text\n'.padEnd(300, 'x'),
        token_length: 200_000,
      },
    ];
    const tasks = buildLongBenchProTasks(rows);
    const zh = tasks[0];
    const en = tasks[1];
    if (!zh || !en) throw new Error('missing tasks');
    // exact ordered answer behind [Answer] marker (no colon) → 1
    expect(zh.score('[Answer]\nArticle 46\nArticle 47\nArticle 48').score).toBe(1);
    // partial answer → 0 with hit stats
    const miss = zh.score('Answer: Article 46');
    expect(miss.score).toBe(0);
    expect(miss.extra?.hits).toBe(1);
    // reordered latin items → 0.5
    const shuffled = en.score('Answer: A, B, C, D, E, F');
    expect(shuffled.score).toBe(0.5);
    expect(shuffled.extra?.unordered).toBe(1);
    expect(en.score('Answer: B,D,C,F,A,E').score).toBe(1);
    expect(parseAnswerItems('[Answer]\nB\nD\nC\nF\nA\nE')).toEqual(['b', 'd', 'c', 'f', 'a', 'e']);

    // B9a: dual [Answer] + Answer: with pipe delimiter (from longbench-pro-00e65818...)
    expect(zh.question).not.toContain("Give your final answer in the form 'Answer: <items>'");
    expect(en.question).toContain("Give your final answer in the form 'Answer: <items>'");
    expect(
      en.score('[Answer]\nB.\nD.\nC.\nF.\nA.\nE.\n\nAnswer: [Answer] B. | D. | C. | F. | A. | E.').score,
    ).toBe(1);

    // B9b: multi-document splitting on Passage 1..3 and English A.\nTitle..C.\nTitle
    const zhMulti = [
      'Passage 1: Quantum Computing Survey\n' + 'Qubit and superconducting circuit progress. '.repeat(25),
      'Passage 2: Topological Insulators\n' + 'Surface states and spin-orbit coupling experiments. '.repeat(25),
      'Passage 3: Photonic Chips\n' + 'Silicon waveguide integration and entanglement sources. '.repeat(25),
    ].join('\n\n');
    const zhDocs = splitContextIntoDocuments(zhMulti);
    expect(zhDocs.length).toBe(3);

    const enMulti = [
      'A.\nThe Impact of Climate Change on Coral Reefs\n' + 'Coral bleaching events have increased. '.repeat(10),
      'B.\nDeep Sea Hydrothermal Vent Ecosystems\n' + 'Chemosynthetic bacteria support diverse fauna. '.repeat(10),
    ].join('\n\n');
    const enDocs = splitContextIntoDocuments(enMulti);
    expect(enDocs.length).toBe(2);
    expect(enDocs[0]?.title).toContain('A. The Impact of Climate Change');

    // Free model pricing check
    expect(priceFor('qwen/qwen3.8-27b:free')).toEqual({ input: 0, cached: 0, output: 0 });
  });
});

describe('DSH plugin benchmark execution (--method dsh)', () => {
  it('executes needle and codegraph benchmark tasks end-to-end through @raf/dsh-plugin', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'raf-bench-dsh-test-'));
    try {
      const models = createMockModels();
      const needleTasks = buildNeedleTasks({ tokens: 4000, tasks: 2, seed: 42 });
      const codeTasks = buildCodeGraphTasks({ tokens: 8000, tasks: 2, hops: 2, seed: 42 });
      const results = await runTasks([...needleTasks, ...codeTasks], {
        method: 'dsh',
        root: models.root,
        branch: models.branch,
        query: models.query,
        llmQuery: models.llmQuery,
        outDir,
        log: () => {},
      });

      expect(results.length).toBe(4);
      for (const r of results) {
        expect(r.method).toBe('dsh');
        expect(r.terminated).toBe('answer');
        expect(r.steps).toBeGreaterThan(1);
        expect(r.folds.granular + r.folds.deep).toBeGreaterThan(0);
        expect(r.llmQueryCalls).toBeGreaterThan(0);
        const dshChecks = r.meta.dshChecks as DshChecks | undefined;
        expect(dshChecks).toBeDefined();
        expect(dshChecks?.runStatus).toBe('done');
        expect(dshChecks?.runEventCount).toBeGreaterThan(0);
        expect(dshChecks?.clientAgentCount).toBeGreaterThanOrEqual(1);
        expect(dshChecks?.nativeToolCalls).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('ingests >1MB workspace haystacks and routes branch specialists to branchLLM with multi-agent client tree', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'raf-bench-dsh-branch-'));
    try {
      const needleTasks = buildNeedleTasks({ tokens: 300_000, tasks: 1, seed: 7 });
      const root = new ScriptedLLM(
        (req) => {
          const user = req.messages[req.messages.length - 1]?.content ?? '';
          const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
          if (step === 0) {
            return '<motivation>Delegate haystack lookup to a specialist branch.</motivation>\n<tool_call>{"name":"branch","arguments":{"task":"Find the personnel note in haystack","scope":"haystack"}}</tool_call>';
          }
          return '<folding>{"range":[0,0],"summary":"Branch specialist verified haystack."}</folding>\n<answer>Answer: 1234</answer>';
        },
        { name: 'mock-root-tier', contextWindow: 200_000, maxOutputTokens: 4096 },
      );
      const branch = new ScriptedLLM(
        (req) => {
          const user = req.messages[req.messages.length - 1]?.content ?? '';
          const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
          if (step === 0) {
            return '<motivation>Grep the >1MB haystack document.</motivation>\n<tool_call>{"name":"grep","arguments":{"pattern":"Personnel note","documents":["haystack"],"max_matches":3}}</tool_call>';
          }
          return '<folding>{"range":[0,0],"summary":"Found personnel note lines in haystack."}</folding>\n<answer>Found badge 1234 in haystack</answer>';
        },
        { name: 'mock-branch-tier', contextWindow: 200_000, maxOutputTokens: 4096 },
      );
      const query = new ScriptedLLM(
        () => '{"relevant":false,"answer":"","evidence":[]}',
        { name: 'mock-query-tier', contextWindow: 128_000, maxOutputTokens: 1024 },
      );

      const results = await runTasks(needleTasks, {
        method: 'dsh',
        root,
        branch,
        query,
        maxDepth: 2,
        outDir,
        log: () => {},
      });

      expect(results.length).toBe(1);
      const r = results[0];
      expect(r?.terminated).toBe('answer');
      expect(r?.output).toBe('Answer: 1234');
      expect(r?.usage.root?.calls).toBe(2);
      expect(r?.usage.branch?.calls).toBe(2);
      const dshChecks = r?.meta.dshChecks as DshChecks | undefined;
      expect(dshChecks?.runStatus).toBe('done');
      expect(dshChecks?.clientAgentCount).toBe(2);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
