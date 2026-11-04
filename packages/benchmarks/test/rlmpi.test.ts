import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRlmPiRecords, scoreRlmLab } from '../src/oolong/rlmpi.js';

const root = join(import.meta.dirname, '..', '..', '..');
const runsDir = join(root, '..', 'rlm.pi', 'bench', 'runs', 'glm-5.3');

describe('rlm.pi lab scorer parity', () => {
  it('scores labels / numbers like rlm.pi', () => {
    expect(scoreRlmLab('Label: incorrect', ['incorrect'], 'ANSWER_TYPE.LABEL')).toBe(1);
    expect(scoreRlmLab('Answer: 7', [7], 'ANSWER_TYPE.NUMERIC')).toBe(1);
    expect(scoreRlmLab('Answer: 8', [7], 'ANSWER_TYPE.NUMERIC')).toBe(0);
    expect(scoreRlmLab('Answer: incorrect is more common than correct', ['more common than'], 'ANSWER_TYPE.COMPARISON')).toBe(1);
  });

  it.skipIf(!existsSync(runsDir))('reproduces rlm.pi glm-5.3 journal grades', () => {
    const records = new Map(loadRlmPiRecords(join(root, '.cache'), 65536, 24, join(root, '..', 'rlm.pi')).map((r) => [r.id, r]));
    for (const f of readdirSync(runsDir).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(runsDir, f), 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { taskId: string; answer: string; recall: number };
        const rec = records.get(row.taskId);
        if (!rec) continue;
        expect(scoreRlmLab(row.answer, rec.answer, rec.answerType)).toBe(row.recall);
      }
    }
  });
});
