import type { BenchTask } from '../runner.js';
import { pick, rng } from '../util/rng.js';

/**
 * MRCR-style multi-round co-reference resolution (OpenAI MRCR, diary template).
 * Context interleaves sentences about several recurring topics; each instance
 * of a topic performs one activity. The request asks for all sentences that
 * are about the SAME activity as the k-th instance of a topic — the model
 * must first locate the k-th instance (order) and then resolve the
 * co-reference cluster (same activity). Score = item-level set F1.
 */

const TOPICS = Object.freeze([
  'the summer vacation',
  'the school reunion',
  'the job interview',
  'the family dinner',
  'the road trip',
  'the music lesson',
  'the doctor visit',
  'the art class',
] as const);

const ACTIVITIES = Object.freeze([
  'went on a hike to the mountains and admired the view',
  'read a fascinating book about ancient history',
  'prepared a large pot of vegetable soup',
  'fixed the broken fence in the backyard',
  'practiced the piano for two full hours',
  'took photographs of the old harbor at sunset',
  'wrote a long letter to a childhood friend',
  'reorganized the bookshelf by color and size',
  'baked a tray of cinnamon rolls from scratch',
  'watched a documentary about deep-sea creatures',
  'repainted the garden gate in bright blue',
  'learned ten new words in a foreign language',
  'planted a row of tomato seedlings in the greenhouse',
  'repaired the bicycle chain and oiled the gears',
  'sketched the oak tree at the end of the lane',
  'recorded a short voice memo about my plans',
  'sorted through a box of old family photographs',
  'measured the kitchen for new curtains',
  'tried a new recipe for lemon pasta',
  'cleaned the attic and found an old radio',
  'jogged five laps around the local park',
  'practiced chord transitions on the guitar',
  'translated a short poem into another language',
  'built a small birdhouse from leftover planks',
] as const);

const ADVERBIALS = Object.freeze([
  'and it went smoothly',
  'and it felt refreshing',
  'though it took longer than planned',
  'with great enthusiasm',
  'in complete silence',
  'while it rained outside',
  'for the first time in months',
  'and everyone smiled',
  'without any interruptions',
  'just as the sun came up',
  'after a light breakfast',
  'and took careful notes',
] as const);

const ORDINALS = Object.freeze([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth',
] as const);

export interface MrcrOptions {
  tokens: number;
  tasks: number;
  seed?: number;
  /** Topics per document (default 8). */
  topics?: number;
}

interface BuiltDoc {
  readonly sentences: string[];
  readonly bases: string[];
  readonly topicOrder: string[];
  readonly instancesPerTopic: Map<string, number[]>;
}

function buildDocument(charsTarget: number, topicCount: number, r: () => number): BuiltDoc {
  const topics = TOPICS.slice(0, topicCount);
  const avgSentence = 96; // chars, measured from template
  const total = Math.max(topics.length * 4, Math.round(charsTarget / avgSentence));
  const sentences: string[] = [];
  const bases: string[] = [];
  const topicOrder: string[] = [];
  const instancesPerTopic = new Map<string, number[]>();
  for (const t of topics) instancesPerTopic.set(t, []);
  for (let i = 0; i < total; i++) {
    const topic = topics[i % topics.length] ?? pick(r, topics);
    const base = ACTIVITIES[i % ACTIVITIES.length] ?? pick(r, ACTIVITIES);
    const adv = ADVERBIALS[Math.floor(r() * ADVERBIALS.length)] ?? 'as usual';
    const s = `During ${topic}, I ${base} ${adv}.`;
    const idx = sentences.push(s) - 1;
    bases.push(base);
    topicOrder.push(topic);
    instancesPerTopic.get(topic)?.push(idx);
  }
  // Fisher-Yates shuffle with seeded r
  for (let i = sentences.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const a = sentences[i];
    const b = sentences[j];
    const ba = bases[i];
    const bb = bases[j];
    const ta = topicOrder[i];
    const tb = topicOrder[j];
    if (a !== undefined && b !== undefined && ba !== undefined && bb !== undefined && ta !== undefined && tb !== undefined) {
      sentences[i] = b;
      sentences[j] = a;
      bases[i] = bb;
      bases[j] = ba;
      topicOrder[i] = tb;
      topicOrder[j] = ta;
    }
  }
  // Rebuild the instance index from post-shuffle order (positions changed).
  for (const t of topics) instancesPerTopic.set(t, []);
  topicOrder.forEach((t, si) => instancesPerTopic.get(t)?.push(si));
  return { sentences, bases, topicOrder, instancesPerTopic };
}

function normalizeItem(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Parse bullet/numbered lines from the model output into normalized items. */
export function parseBullets(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^(?:[-*•·]|\d+[.)])\s*/i, '').trim())
    .filter((l) => l.length > 0 && !/^(answer|the following|here (are|is))/i.test(l))
    .map(normalizeItem)
    .filter(Boolean);
}

export function buildMrcrTasks(o: MrcrOptions): BenchTask[] {
  const topicCount = Math.min(o.topics ?? 8, TOPICS.length);
  const r = rng(o.seed ?? 42);
  const built = buildDocument(o.tokens * 4, topicCount, r);
  const text = built.sentences.join('\n');
  const tokens = Math.round(text.length / 4);
  const doc = { id: 'diary', title: `MRCR diary (~${o.tokens} tokens)`, text, tokens };

  const tasks: BenchTask[] = [];
  for (let i = 0; i < o.tasks; i++) {
    const topicsWithEnough = [...built.instancesPerTopic.entries()].filter(([, idxs]) => idxs.length >= 6);
    if (topicsWithEnough.length === 0) break;
    const entry = topicsWithEnough[i % topicsWithEnough.length] ?? topicsWithEnough[0];
    if (!entry) break;
    const [topic, idxs] = entry;
    const k = 2 + Math.floor(r() * Math.min(8, idxs.length - 2));
    const anchorIdx = idxs[k - 1];
    const anchorBase = anchorIdx !== undefined ? built.bases[anchorIdx] : undefined;
    if (anchorIdx === undefined || anchorBase === undefined) continue;
    const goldIdx = new Set<number>();
    built.topicOrder.forEach((t, si) => {
      if (t === topic && built.bases[si] === anchorBase) goldIdx.add(si);
    });
    const gold = [...goldIdx].map((si) => normalizeItem(built.sentences[si] ?? ''));

    const ordinal = ORDINALS[k - 1] ?? `${k}-th`;
    tasks.push({
      id: `mrcr-${o.tokens}-coref-${i}`,
      group: `mrcr-${o.tokens}-${o.seed ?? 42}`,
      question:
        `Please provide all sentences from the following document that are about the same activity as the ${ordinal} instance of ${topic}. ` +
        `Provide each sentence as a separate bullet point. Do not include any other text.`,
      documents: [doc],
      meta: {
        task: 'mrcr_coref',
        answer_type: 'ANSWER_TYPE.STRING',
        context_len: tokens,
        topic,
        instance: k,
        cluster_size: gold.length,
        gold: gold.join(' || '),
      },
      score: (out: string) => {
        const got = [...new Set(parseBullets(out))];
        const goldSet = new Set(gold);
        let hits = 0;
        for (const g of got) if (goldSet.has(g)) hits++;
        const precision = got.length > 0 ? hits / got.length : 0;
        const recall = goldSet.size > 0 ? hits / goldSet.size : 0;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        return {
          score: f1,
          extra: { precision: Number(precision.toFixed(3)), recall: Number(recall.toFixed(3)), hits },
        };
      },
    });
  }
  return tasks;
}
