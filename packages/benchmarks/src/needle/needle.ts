import type { BenchTask } from '../runner.js';
import { pick, rng } from '../util/rng.js';

const SUBJECTS = ['The committee', 'A local farmer', 'The museum guide', 'Our neighbour', 'The river pilot', 'A visiting scholar', 'The night baker', 'The archivist', 'A street musician', 'The ferry captain'];
const VERBS = ['described', 'remembered', 'complained about', 'wrote a note on', 'argued over', 'sketched', 'photographed', 'measured', 'catalogued', 'praised'];
const OBJECTS = ['the old lighthouse', 'a broken clock', 'the autumn harvest', 'the tram schedule', 'an unusual cloud', 'the market prices', 'a faded map', 'the winter festival', 'the new bridge', 'a stray cat'];
const TAILS = ['before noon.', 'with great care.', 'for the third time this week.', 'without much enthusiasm.', 'in a quiet voice.', 'despite the rain.', 'to anyone who would listen.', 'in the town ledger.'];
const NAMES = ['Alva Lindqvist', 'Bruno Okafor', 'Chen Wei', 'Dara Mbeki', 'Elif Sahin', 'Farid Haddad', 'Greta Novak', 'Hiro Tanaka', 'Ines Duarte', 'Jonas Weber', 'Kira Ivanova', 'Luca Romano', 'Maya Kapoor', 'Nils Berg', 'Omar Farouk', 'Priya Nair'];
const CITIES = ['Lisbon', 'Osaka', 'Tallinn', 'Quito', 'Nairobi'];

export interface NeedleOptions {
  tokens: number;
  tasks: number;
  seed?: number;
  /** Number of employee facts hidden in the haystack. */
  facts?: number;
}

/**
 * Synthetic mega-context task family:
 *  - lookup: find a single hidden fact (badge number) → exact match
 *  - count: count facts matching a city across the whole document → 0.75^|Δ|
 * Cheap to generate at any size (1K … 4M tokens) to stress llm_query chunking.
 */
export function buildNeedleTasks(o: NeedleOptions): BenchTask[] {
  const r = rng(o.seed ?? 42);
  const p = (xs: readonly string[]) => pick(r, xs);
  const charsTarget = o.tokens * 4;
  const factsN = o.facts ?? Math.max(12, Math.min(NAMES.length * 4, Math.round(o.tokens / 4000)));
  const facts = Array.from({ length: factsN }, (_, i) => ({
    name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${String.fromCharCode(65 + Math.floor(i / NAMES.length))}.` : ''}`,
    city: p(CITIES),
    badge: 1000 + Math.floor(r() * 9000),
  }));
  const lines: string[] = [];
  let chars = 0;
  while (chars < charsTarget) {
    const l = `${p(SUBJECTS)} ${p(VERBS)} ${p(OBJECTS)} ${p(TAILS)}`;
    lines.push(l);
    chars += l.length + 1;
  }
  // scatter facts uniformly
  const positions = facts.map(() => Math.floor(r() * lines.length)).sort((a, b) => a - b);
  facts.forEach((f, i) => {
    lines.splice(positions[i]! + i, 0, `Personnel note: ${f.name} transferred to the ${f.city} office; badge number ${f.badge}.`);
  });
  const text = lines.join('\n');
  const doc = { id: 'haystack', title: `synthetic haystack (~${o.tokens} tokens)`, text, tokens: Math.round(text.length / 4) };
  const tasks: BenchTask[] = [];
  for (let i = 0; i < o.tasks; i++) {
    if (i % 2 === 0) {
      const f = facts[Math.floor(r() * facts.length)]!;
      tasks.push({
        id: `needle-${o.tokens}-lookup-${i}`,
        group: `needle-${o.tokens}-${o.seed ?? 42}`,
        question: `What is the badge number of ${f.name}? Give your final answer in the form 'Answer: <number>'.`,
        documents: [doc],
        meta: { task: 'lookup', answer_type: 'ANSWER_TYPE.NUMERIC', context_len: doc.tokens, gold: f.badge },
        score: (out) => {
          const m = /(\d{4})(?!.*\d{4})/s.exec(out);
          return { score: m && Number(m[1]) === f.badge ? 1 : 0, parsed: m?.[1] };
        },
      });
    } else {
      const city = p(CITIES);
      const gold = facts.filter((f) => f.city === city).length;
      tasks.push({
        id: `needle-${o.tokens}-count-${i}`,
        group: `needle-${o.tokens}-${o.seed ?? 42}`,
        question: `How many personnel notes say that someone transferred to the ${city} office? Count across the entire document. Give your final answer in the form 'Answer: <number>'.`,
        documents: [doc],
        meta: { task: 'count', answer_type: 'ANSWER_TYPE.NUMERIC', context_len: doc.tokens, gold },
        score: (out) => {
          const m = /answer\s*:\s*\**\s*(-?\d+)/i.exec(out) ?? /(-?\d+)(?!.*\d)/s.exec(out);
          const v = m ? Number(m[1]) : NaN;
          return { score: Number.isFinite(v) ? 0.75 ** Math.abs(v - gold) : 0, parsed: m?.[1] };
        },
      });
    }
  }
  return tasks;
}
