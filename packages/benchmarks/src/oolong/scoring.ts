/**
 * OOLONG scoring, ported from the official evaluator
 * (github.com/abertsch72/oolong src/eval/eval_helpers.py), plus the more
 * lenient variant used by the RLM OOLONG environment (alexzhang13/rlm).
 */

export type Confidence = 'low' | 'med' | 'high' | 'vhigh';

const COMPARISON = ['more common', 'less common', 'same frequency'] as const;

/** Official `parse_answer`. */
export function parseOolongAnswer(answer: string): { candidate: string; confidence: Confidence } {
  let confidence: Confidence = 'low';
  if (!answer.includes(':')) {
    return { candidate: answer.length < 20 ? answer : (answer.split(/\s+/).filter(Boolean).pop() ?? ''), confidence };
  }
  let candidate = (answer.split(':').pop() ?? '').trim();
  candidate = candidate.replace(/\*/g, '').replace(/\[/g, '').replace(/\]/g, '');
  confidence = 'med';
  if (['User:', 'Answer:', 'Date:', 'Label'].some((k) => answer.includes(k))) confidence = 'high';
  if (candidate.length < 20) confidence = 'vhigh';
  else if (candidate.includes('more common')) candidate = 'more common';
  else if (candidate.includes('less common')) candidate = 'less common';
  else if (candidate.includes('same frequency')) candidate = 'same frequency';
  return { candidate, confidence };
}

export interface GoldAnswer {
  value: string;
  date?: Date;
}

/** Parse the gold `answer` column: a Python-literal list, e.g. "['location']", "[12]", "[datetime.date(2023, 5, 1)]". */
export function parseGold(answer: string): GoldAnswer {
  const dm = /datetime\.date\((\d+),\s*(\d+),\s*(\d+)\)/.exec(answer);
  if (dm) {
    const [, year = '', month = '', day = ''] = dm;
    const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    // str(datetime) in Python → "YYYY-MM-DD 00:00:00"
    return { value: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} 00:00:00`, date: d };
  }
  const inner = answer.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  // first element of the list
  const m = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(inner);
  if (m) return { value: (m[2] ?? '').replace(/\\(['"\\])/g, '$1') };
  const first = inner.split(',')[0]?.trim() ?? inner;
  return { value: first };
}

function parseDateLoose(s: string): Date | undefined {
  const t = s.trim().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const d = new Date(`${t} UTC`);
  if (!isNaN(d.getTime())) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const d2 = new Date(t);
  if (!isNaN(d2.getTime())) return new Date(Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate()));
  return undefined;
}

function pyInt(s: string): number | undefined {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : undefined;
}

/** Official `synth_process_response` score. */
export function scoreOolong(row: { answer: string; answer_type: string }, output: string): { score: number; parsed: string; confidence: Confidence } {
  const gold = parseGold(row.answer);
  const { candidate, confidence } = parseOolongAnswer(output);
  let score = 0;
  if (candidate === gold.value) score = 1;
  else if ((COMPARISON as readonly string[]).includes(candidate)) score = gold.value.includes(candidate) ? 1 : 0;
  else if (row.answer_type === 'ANSWER_TYPE.NUMERIC') {
    const g = pyInt(gold.value);
    const t = pyInt(candidate);
    score = g !== undefined && t !== undefined ? 0.75 ** Math.abs(g - t) : 0;
  } else if (row.answer_type === 'ANSWER_TYPE.DATE') {
    const t = parseDateLoose(candidate);
    score = t && gold.date && t.getTime() === gold.date.getTime() ? 1 : 0;
  }
  return { score, parsed: candidate, confidence };
}

/** Lenient variant (RLM env): comparison phrases anywhere, case-insensitive, substring fallback. */
export function scoreOolongLenient(row: { answer: string; answer_type: string }, output: string): number {
  const official = scoreOolong(row, output).score;
  if (official === 1) return 1;
  const gold = parseGold(row.answer);
  const lower = output.toLowerCase();
  for (const phrase of ['more common than', 'less common than', 'same frequency as']) {
    if (lower.lastIndexOf(phrase) >= 0 && gold.value.toLowerCase().includes(phrase)) return 1;
  }
  const { candidate } = parseOolongAnswer(output);
  if (candidate.toLowerCase().trim() === gold.value.toLowerCase().trim()) return 1;
  if (row.answer_type === 'ANSWER_TYPE.NUMERIC') {
    const nums = output.match(/-?\d+/g);
    const g = pyInt(gold.value);
    const last = nums?.length ? Number(nums[nums.length - 1]) : undefined;
    if (g !== undefined && last !== undefined) return Math.max(official, 0.75 ** Math.abs(g - last));
  }
  const isComparison = /more common|less common|same frequency/.test(gold.value);
  if (!isComparison && gold.value.length > 0 && lower.includes(gold.value.toLowerCase())) return Math.max(official, 1);
  return official;
}
