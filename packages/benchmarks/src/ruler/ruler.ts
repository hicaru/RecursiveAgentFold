import type { BenchTask } from '../runner.js';
import { pick, rng } from '../util/rng.js';

/**
 * RULER-style synthetic long-context suite (NVIDIA RULER, synthetic subset).
 * 11 subtasks: niah_single_1..3, niah_multikey_1..3, niah_multiquery,
 * niah_multivalue, vt, cwe, fwe. SQuAD-based qa_1/qa_2 are not included.
 * Scoring follows RULER: normalized exact match for retrieval subtasks,
 * all-10 exact set match for cwe/fwe.
 */

export const RULER_SUBTASKS = Object.freeze([
  'niah_single_1',
  'niah_single_2',
  'niah_single_3',
  'niah_multikey_1',
  'niah_multikey_2',
  'niah_multikey_3',
  'niah_multiquery',
  'niah_multivalue',
  'vt',
  'cwe',
  'fwe',
] as const);
export type RulerSubtask = (typeof RULER_SUBTASKS)[number];

export interface RulerOptions {
  tokens: number;
  /** Tasks per subtask (default 1 → 11 tasks total). */
  tasks?: number;
  seed?: number;
  subtasks?: readonly string[];
}

const WORDS = Object.freeze(
  (
    'able acid aged also area army away baby back ball band bank base bath bear beat been bell belt best blue boat body bomb bond bone book born boss both bowl bulk burn bush busy cage cake call calm camp card care cart case cash cast cell chat chip city club coal coat code cold come cook cool cope copy core cork corn cost crew crop cure cute damp dare dark data date dawn dead deal dear debt deep deny desk dial diet dirt disc dish does dome done door dose down drag draw drew drop drug drum dual duck dude dust duty each earn ease east easy echo edge exam exit face fact fade fail fair fall fame farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish five flag flat flew flip flow foam fold folk fond food foot fork form fort four free from fuel full fund gain game gate gave gear gene gift girl give glad goal goat goes gold golf gone good grab gray grew grow gulf hair half hall hand hang hard harm hate have head heat herb herd hero high hill hire hold hole holy home hope horn host hour huge hung hunt hurt idea inch into iron item jail join joke jump jury just keen keep kept kick kind king knee knew lady lake land lane last late laugh lead leaf lean left less lift like limb lime line link list live load loan lock loft long look lord lose loss lost love luck lung made mail main make male mall many mark mass math meal mean meat meet melt memo mend menu mere mesh mild mile milk mill mind mine miss mode mold mole monk mood moon more most move much must myth nail name navy near neat neck need news next nice nine node none noon norm nose note noun oath obey odds okay once only open oral over pace pack page paid pain pair pale palm park part pass past path peak pear peer pile pill pine pink pipe plan play plea plot plug plus poem poet pole poll pond pool poor pope pork port pose post pour pray prep prey pull pump pure push quiz race rack raft rage raid rail rain rank rare rate read real reef rely rent rest rice rich ride ring riot rise risk road rock role roll roof room root rope rose rosy rude rule rush safe sage said sail sake sale salt same sand save scan seal seat seed seek seem seen self sell send sent ship shoe shop shot show shut side sigh sign silk sing sink site size skin skip slab slam slap sled slid slim slip slot slow snap snow soak soap sock soft soil sold sole solo some song soon sort soul soup spin spot star stay stem step stir stop such suit sung sunk sure swap swim swan tail take tale talk tall tank tape task taxi team tear tech tell tend term test text than that them then they thin this thus tide tidy tile till time tiny tire toad toll tomb tone took tool torn tour town toys tram trap tray tree trim trip true tube tuna tune turn twin type ugly undo unit upon urge used user vain vane vast veil verb very vice view vine void vote wage wait wake walk wall want ward warm warn wash wave weak wear week well went were west what when whom wide wife wild will wind wine wing wipe wire wise wish with wood wool word wore work worm worn wrap yard yarn year your zeal zinc zone zoom'
  ).split(' '),
);

function uuidFrom(r: () => number): string {
  const hex = () => Math.floor(r() * 16).toString(16);
  const p = (n: number) => Array.from({ length: n }, hex).join('');
  return `${p(8)}-${p(4)}-4${p(3)}-a${p(3)}-${p(12)}`;
}

/** Normalized comparison: lowercase, keep alphanumerics only. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parse the payload after the last 'Answer:' marker, split on separators. */
export function parseAnswerList(out: string): string[] {
  const m = /answer\s*[:：]((?:(?!answer\s*[:：]).)*)$/is.exec(out);
  const raw = (m?.[1] ?? out).trim();
  return raw
    .split(/[,;\n]+/)
    .map((s) => norm(s))
    .filter(Boolean);
}

function scoreExact(gold: string): (out: string) => { score: number; parsed?: string } {
  return (out) => {
    const list = parseAnswerList(out);
    const first = list[0];
    return {
      score: list.some((x) => x === norm(gold)) ? 1 : 0,
      ...(first !== undefined ? { parsed: list.join(', ') } : {}),
    };
  };
}

function scoreSet(gold: readonly string[], ordered = false): (out: string) => {
  score: number;
  parsed?: string;
  extra?: Record<string, number>;
} {
  const goldSet = new Set(gold.map(norm));
  return (out) => {
    const list = parseAnswerList(out);
    const uniq = [...new Set(list)];
    const correct = new Set(uniq.filter((x) => goldSet.has(x))).size;
    const noJunk = uniq.length === goldSet.size;
    const ok = correct === goldSet.size && noJunk && (!ordered || list.length === gold.length);
    return {
      score: ok ? 1 : 0,
      ...(uniq.length ? { parsed: uniq.join(', ') } : {}),
      extra: { correct, gold: goldSet.size },
    };
  };
}

/**
 * Unique-token noise lines reaching roughly `charsTarget` characters.
 * Random digit token pairs are all distinct and contain no letters, so
 * injected real words are the only countable words (cwe/fwe semantics).
 */
function buildNoise(charsTarget: number, r: () => number): string[] {
  const tok = () => Array.from({ length: 4 }, () => '0123456789'[Math.floor(r() * 10)]).join('');
  const lines: string[] = [];
  let chars = 0;
  while (chars < charsTarget) {
    const toks = Array.from({ length: 8 }, () => `${tok()}-${tok()}`);
    const l = toks.join(' ');
    lines.push(l);
    chars += l.length + 1;
  }
  return lines;
}

function scatter(lines: string[], needles: readonly string[], r: () => number): void {
  const at = needles.map(() => Math.floor(r() * lines.length)).sort((a, b) => a - b);
  needles.forEach((n, i) => lines.splice(at[i] ?? lines.length, 0, n));
}

interface BuiltSubtask {
  readonly text: string;
  readonly question: string;
  readonly gold: unknown;
  readonly score: BenchTask['score'];
}

function buildSubtask(subtask: RulerSubtask, tokens: number, seed: number): BuiltSubtask {
  const r = rng(seed);
  const lines = buildNoise(tokens * 4, r);
  const q = (s: string) => `${s} Give your final answer in the form 'Answer: <value>'.`;
  const key = () => `${pick(r, WORDS)}-${pick(r, WORDS)}`;
  const num = () => String(100_000 + Math.floor(r() * 899_999));

  if (subtask === 'cwe' || subtask === 'fwe') {
    const commons = Array.from({ length: 10 }, () => pick(r, WORDS));
    const pool = WORDS.filter((w) => !commons.includes(w));
    // 20 distractor real words, each exactly 2 times
    const distractors = Array.from({ length: 20 }, () => pick(r, pool));
    scatter(lines, distractors.flatMap((w) => [w, w]), r);
    if (subtask === 'cwe') {
      // sprinkle the 10 common words round-robin, ~1 per noise line: each
      // ends up far more frequent than any distractor (2x) or noise token
      let next = 0;
      for (let i = 0; i < lines.length; i++) {
        const w = commons[next % 10];
        next++;
        if (!w) continue;
        const parts = (lines[i] ?? '').split(' ');
        parts.splice(Math.floor(r() * parts.length), 0, w);
        lines[i] = parts.join(' ');
      }
    } else {
      // 10 coded words, each exactly 3 times — the top-10 by frequency
      const needles = commons.flatMap((w) => Array.from({ length: 3 }, () => w));
      scatter(lines, needles, r);
    }
    const kind = subtask === 'cwe' ? 'common' : 'frequent';
    return {
      text: lines.join('\n'),
      question: q(
        `Below is a large document of random hyphenated digit tokens with some real single words mixed in. What are the 10 most ${kind} real words in it? List them as a comma-separated list.`,
      ),
      gold: commons.join(','),
      score: scoreSet(commons),
    };
  }

  if (subtask === 'vt') {
    const nVars = 40;
    const chainLen = 3 + Math.floor(r() * 3);
    const value = 1_000_000 + Math.floor(r() * 8_999_999);
    // valueId[i] = equivalence class of Xi; X1's chain shares class 1,
    // distractors never join it.
    const valueId = new Array<number>(nVars + 1).fill(0);
    valueId[1] = 1;
    const needles: string[] = [`VAR X1 = ${value};`];
    let nextClass = 2;
    for (let i = 2; i <= nVars; i++) {
      if (i <= chainLen) {
        valueId[i] = 1;
        needles.push(`VAR X${i} = X${i - 1};`);
        continue;
      }
      const ref = 1 + Math.floor(r() * (i - 1));
      if (valueId[ref] === 1) {
        valueId[i] = nextClass++;
        needles.push(`VAR X${i} = ${900_000 + Math.floor(r() * 99_999)};`);
      } else {
        valueId[i] = valueId[ref] || nextClass++;
        needles.push(`VAR X${i} = X${ref};`);
      }
    }
    scatter(lines, needles, r);
    const goldVars = Array.from({ length: chainLen }, (_, i) => `X${i + 1}`);
    return {
      text: lines.join('\n'),
      question: q(
        'Below is a large document containing many variable assignments. Find all variables that are equal in value to variable X1 (follow chained references transitively). List them as a comma-separated list (e.g. X1, X3, X7).',
      ),
      gold: goldVars.join(','),
      score: scoreSet(goldVars),
    };
  }

  switch (subtask) {
    case 'niah_single_1': {
      const k = key();
      const v = num();
      scatter(lines, [`One of the special magic numbers for ${k} is: ${v}.`], r);
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic number for ${k} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_single_2': {
      const k = key();
      const v = uuidFrom(r);
      scatter(lines, [`One of the special magic uuids for ${k} is: ${v}.`], r);
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic uuid for ${k} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_single_3': {
      const k = key();
      const v = `${pick(r, WORDS)} ${pick(r, WORDS)} ${pick(r, WORDS)}`;
      scatter(lines, [`One of the special magic values for ${k} is: ${v}.`], r);
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic value for ${k} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_multikey_1': {
      const k = key();
      const v = num();
      scatter(
        lines,
        [
          `One of the special magic numbers for ${key()} is: ${num()}.`,
          `One of the special magic numbers for ${key()} is: ${num()}.`,
          `One of the special magic numbers for ${key()} is: ${num()}.`,
          `One of the special magic numbers for ${k} is: ${v}.`,
        ],
        r,
      );
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic number for ${k} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_multikey_2': {
      const k = key();
      const v = uuidFrom(r);
      scatter(
        lines,
        [
          `One of the special magic uuids for ${key()} is: ${uuidFrom(r)}.`,
          `One of the special magic uuids for ${key()} is: ${uuidFrom(r)}.`,
          `One of the special magic uuids for ${key()} is: ${uuidFrom(r)}.`,
          `One of the special magic uuids for ${k} is: ${v}.`,
        ],
        r,
      );
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic uuid for ${k} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_multikey_3': {
      const keys = [key(), key(), key(), key()];
      const v = `${pick(r, WORDS)}_${pick(r, WORDS)}`;
      scatter(
        lines,
        [
          `One of the special magic numbers for ${key()} ${key()} ${key()} ${key()} is: ${pick(r, WORDS)}_${pick(r, WORDS)}.`,
          `One of the special magic numbers for ${keys[0]} ${keys[1]} ${keys[2]} ${keys[3]} is: ${v}.`,
        ],
        r,
      );
      return {
        text: lines.join('\n'),
        question: q(`What is the special magic number for keys ${keys.join(', ')} mentioned in the provided text?`),
        gold: v,
        score: scoreExact(v),
      };
    }
    case 'niah_multiquery': {
      const keys = Array.from({ length: 4 }, key);
      const vals = Array.from({ length: 4 }, num);
      scatter(lines, keys.map((k, i) => `One of the special magic numbers for ${k} is: ${vals[i]}.`), r);
      return {
        text: lines.join('\n'),
        question: q(
          `What are the special magic numbers for ${keys.join(', ')} mentioned in the provided text? List them in the same order as the keys, as a comma-separated list.`,
        ),
        gold: vals.join(','),
        score: scoreSet(vals, true),
      };
    }
    default: {
      const k = key();
      const vals = Array.from({ length: 4 }, num);
      scatter(lines, vals.map((v) => `One of the special magic numbers for ${k} is: ${v}.`), r);
      return {
        text: lines.join('\n'),
        question: q(
          `What are all the special magic numbers for ${k} mentioned in the provided text? List them as a comma-separated list.`,
        ),
        gold: vals.join(','),
        score: scoreSet(vals),
      };
    }
  }
}

export function buildRulerTasks(o: RulerOptions): BenchTask[] {
  const subtasks = (o.subtasks ?? RULER_SUBTASKS).filter((s): s is RulerSubtask =>
    (RULER_SUBTASKS as readonly string[]).includes(s),
  );
  const per = o.tasks ?? 1;
  const tasks: BenchTask[] = [];
  for (const subtask of subtasks) {
    for (let i = 0; i < per; i++) {
      // Distinct seed per (subtask, i): fold the full subtask name in so
      // same-length subtask names (single_1/2/3, multikey_1/2/3) diverge.
      let nameHash = 7;
      for (const ch of subtask) nameHash = (nameHash * 31 + ch.charCodeAt(0)) >>> 0;
      const seed = (o.seed ?? 42) * 7919 + nameHash * 131 + i * 17;
      const built = buildSubtask(subtask, o.tokens, seed);
      const tokens = Math.round(built.text.length / 4);
      tasks.push({
        id: `ruler-${o.tokens}-${subtask}-${i}`,
        // Each task owns its haystack: one group per task (the runner shares
        // one document store across a group).
        group: `ruler-${o.tokens}-${o.seed ?? 42}-${subtask}-${i}`,
        question: built.question,
        documents: [{ id: 'haystack', title: `RULER haystack (~${o.tokens} tokens)`, text: built.text, tokens }],
        meta: { task: subtask, answer_type: 'ANSWER_TYPE.STRING', context_len: tokens, gold: built.gold },
        score: built.score,
      });
    }
  }
  return tasks;
}
