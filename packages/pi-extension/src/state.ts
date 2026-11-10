import type { AgentMessage } from './pi-types.js';
import {
  BRANCH_REPORT_ID_PREFIX,
  FoldState,
  ResearchBoard,
  type FoldStateSnapshot,
  type LLMQueryCache,
  type ResearchBoardSnapshot,
  type ToolAction,
} from '@raf/engine';

/** Custom entry types this extension appends to the session. */
export const ENTRY_STATE = 'raf-state';
export const ENTRY_MODE = 'raf-mode';
export const ENTRY_RUN = 'raf-run';

/** A root tool call that waits for its native result. */
export interface PendingCall {
  readonly callId: string;
  readonly step: number;
  readonly motivation: string;
  readonly action: ToolAction;
}

export interface StoredDoc {
  readonly title: string;
  readonly text: string;
  /** False for documents that are re-read from disk (workspace files). */
  readonly persist: boolean;
}

export type TurnStatus = 'done' | 'aborted' | 'error';

/** Persisted RAF state of one session branch point (custom entry data). */
export interface PersistedState {
  readonly version: 1;
  readonly status: TurnStatus;
  readonly rootState?: FoldStateSnapshot;
  readonly initialQuestion?: string;
  readonly initialManifest?: string;
  readonly initialDocIds?: readonly string[];
  readonly board?: ResearchBoardSnapshot;
  readonly pending?: PendingCall;
  readonly docs?: Readonly<Record<string, { readonly title: string; readonly text: string }>>;
}

/** Persisted documents per entry. Branch reports come first. */
const MAX_PERSISTED_DOC_CHARS = 1_000_000;
const MAX_PERSISTED_DOCS = 200;

/**
 * In-memory RAF state of one pi session. It outlives single turns: the board,
 * the llm_query memo, stored documents, and the root fold state carry over.
 */
export class SessionState {
  readonly cache: LLMQueryCache = { memo: new Map(), chunkCounts: new Map() };
  board = new ResearchBoard();
  readonly docs = new Map<string, StoredDoc>();
  readonly sources = new Set<string>();
  workspaceIngested = false;
  docSeq = 0;
  rootState: FoldStateSnapshot | undefined;
  initialQuestion: string | undefined;
  initialManifest: string | undefined;
  initialDocIds: ReadonlySet<string> | undefined;
  pending: PendingCall | undefined;

  /** Replace the carried-over state with a persisted entry. Workspace files are re-indexed later. */
  restore(state: PersistedState | undefined): void {
    this.board = new ResearchBoard();
    this.docs.clear();
    this.sources.clear();
    this.workspaceIngested = false;
    this.docSeq = 0;
    this.cache.memo.clear();
    this.cache.chunkCounts.clear();
    this.rootState = undefined;
    this.initialQuestion = undefined;
    this.initialManifest = undefined;
    this.initialDocIds = undefined;
    this.pending = undefined;
    if (state === undefined) return;
    this.rootState = state.rootState;
    this.initialQuestion = state.initialQuestion;
    this.pending = state.pending;
    if (state.board !== undefined) {
      try {
        this.board = ResearchBoard.restore(state.board);
      } catch {
        this.board = new ResearchBoard();
      }
    }
    for (const [id, doc] of Object.entries(state.docs ?? {})) {
      this.docs.set(id, { title: doc.title, text: doc.text, persist: true });
    }
    this.docSeq = this.docs.size;
  }

  /** Build the entry data for the current state. */
  snapshot(status: TurnStatus): PersistedState {
    const ordered = [...this.docs.entries()]
      .filter(([, doc]) => doc.persist)
      .sort(([a], [b]) => Number(!a.startsWith(BRANCH_REPORT_ID_PREFIX)) - Number(!b.startsWith(BRANCH_REPORT_ID_PREFIX)));
    const docs: Record<string, { title: string; text: string }> = {};
    let chars = 0;
    let count = 0;
    for (const [id, doc] of ordered) {
      if (count >= MAX_PERSISTED_DOCS || chars + doc.text.length > MAX_PERSISTED_DOC_CHARS) continue;
      docs[id] = { title: doc.title, text: doc.text };
      chars += doc.text.length;
      count += 1;
    }
    let board: ResearchBoardSnapshot | undefined;
    try {
      board = this.board.snapshot();
    } catch {
      board = undefined;
    }
    return {
      version: 1,
      status,
      ...(this.rootState !== undefined ? { rootState: this.rootState } : {}),
      ...(this.initialQuestion !== undefined ? { initialQuestion: this.initialQuestion } : {}),
      ...(this.initialManifest !== undefined ? { initialManifest: this.initialManifest } : {}),
      ...(this.initialDocIds !== undefined ? { initialDocIds: [...this.initialDocIds] } : {}),
      ...(board !== undefined ? { board } : {}),
      ...(this.pending !== undefined ? { pending: this.pending } : {}),
      ...(count > 0 ? { docs } : {}),
    };
  }
}

/** Narrow untrusted entry data to a persisted state. */
export function asPersistedState(data: unknown): PersistedState | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const rec = data as Record<string, unknown>;
  if (rec.version !== 1) return undefined;
  if (rec.status !== 'done' && rec.status !== 'aborted' && rec.status !== 'error') return undefined;
  return data as PersistedState;
}

/** Text of any message-like object's content blocks. */
export function messageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return '';
  return contentText((message as { content?: unknown }).content);
}

/** Text of message content blocks. Images and files become placeholders. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
    else if (rec.type === 'image') parts.push('[image]');
    else if (rec.type === 'toolCall' && typeof rec.name === 'string') {
      parts.push(`[tool call ${rec.name}] ${JSON.stringify(rec.arguments ?? {})}`);
    }
  }
  return parts.join('\n').trim();
}

/** Render prior conversation messages as one document for the context store. */
export function renderTranscript(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') continue;
    const text = contentText(message.content);
    if (text === '') continue;
    const label = message.role === 'toolResult' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`## ${label}\n${text}`);
  }
  return parts.join('\n\n');
}

/** Seed a root fold state from prior question/answer turns of a conversation. */
export function seedPriorTurns(
  messages: readonly AgentMessage[],
): { readonly initialQuestion: string; readonly rootState: FoldStateSnapshot } | undefined {
  const pairs: { question: string; answer: string }[] = [];
  let question: string | undefined;
  let answer = '';
  for (const message of messages) {
    if (message.role === 'user') {
      const text = messageText(message);
      if (text === '') continue;
      if (question !== undefined && answer !== '') pairs.push({ question, answer });
      question = text;
      answer = '';
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text.trim() : ''))
        .filter((t) => t !== '')
        .join('\n');
      if (text !== '') answer = text;
    }
  }
  if (question !== undefined && answer !== '') pairs.push({ question, answer });
  const first = pairs[0];
  if (first === undefined) return undefined;
  const seeded = new FoldState();
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (pair === undefined) continue;
    const step = seeded.currentStep;
    const q = pair.question.replace(/\s+/g, ' ').trim().slice(0, 120);
    const a = pair.answer.replace(/\s+/g, ' ').trim().slice(0, 600);
    seeded.setLatest({ step, motivation: `Turn ${i + 1}: ${q}`, action: { name: 'answer', arguments: {} }, observation: a });
    seeded.applyFold({ range: [step, step], summary: `Turn ${i + 1} (${q}): ${a}` });
  }
  return { initialQuestion: first.question, rootState: seeded.snapshot() };
}
