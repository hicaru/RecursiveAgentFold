import type { AgentMessage } from './pi-types.js';
import {
  BRANCH_REPORT_ID_PREFIX,
  FoldState,
  ResearchBoard,
  type ChatMessage,
  type FoldStateSnapshot,
  type LLMQueryCache,
  type ResearchBoardSnapshot,
  type ToolAction,
} from '@raf/engine/source';
import { applyCacheBreakpointsToPayload, type ChatModel } from './llm.js';
/** Custom entry types this extension appends to the session. */
export const ENTRY_STATE = 'raf-state';
export const ENTRY_MODE = 'raf-mode';
export const ENTRY_RUN = 'raf-run';

/** A root tool call (or parallel batch) that waits for native results. */
export interface PendingCall {
  readonly callId: string;
  readonly callIds?: readonly string[];
  readonly step: number;
  readonly motivation: string;
  readonly action: ToolAction;
  readonly actions?: readonly ToolAction[];
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
  readonly initialDocRevs?: Readonly<Record<string, number>>;
  readonly initialBoardSnapshot?: string;
  readonly initialBoardRev?: number;
  readonly sources?: readonly string[];
  readonly docSeq?: number;
  readonly board?: ResearchBoardSnapshot;
  readonly pending?: PendingCall;
  readonly docs?: Readonly<Record<string, { readonly title: string; readonly text: string }>>;
}

/** Persisted documents per entry. Branch reports come first. */
const MAX_PERSISTED_DOC_CHARS = 48_000;
const MAX_PERSISTED_DOCS = 24;
const MAX_SINGLE_REPORT_CHARS = 16_000;
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
  rootState?: FoldStateSnapshot;
  initialQuestion?: string;
  initialManifest?: string;
  initialDocIds?: ReadonlySet<string>;
  initialDocRevs?: Readonly<Record<string, number>>;
  initialBoardSnapshot?: string;
  initialBoardRev?: number;
  pending?: PendingCall;
  hostInstructions?: string;
  lastPreparedMessages?: readonly ChatMessage[];
  lastRootModel?: ChatModel;

  decorateCachedPayload(payload: unknown): unknown {
    if (this.lastPreparedMessages === undefined || this.lastRootModel === undefined) return undefined;
    return applyCacheBreakpointsToPayload(payload, this.lastPreparedMessages, this.lastRootModel);
  }

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
    this.initialDocRevs = undefined;
    this.initialBoardSnapshot = undefined;
    this.initialBoardRev = undefined;
    this.pending = undefined;
    this.hostInstructions = undefined;
    this.lastPreparedMessages = undefined;
    this.lastRootModel = undefined;
    if (state === undefined) return;
    this.rootState = state.rootState;
    this.initialQuestion = state.initialQuestion;
    this.initialManifest = state.initialManifest;
    this.initialDocIds = state.initialDocIds !== undefined ? new Set(state.initialDocIds) : undefined;
    this.initialDocRevs = state.initialDocRevs;
    this.initialBoardSnapshot = state.initialBoardSnapshot;
    this.initialBoardRev = state.initialBoardRev;
    for (const s of state.sources ?? []) this.sources.add(s);
    this.pending = state.pending;
    if (state.board !== undefined) {
      try {
        this.board = ResearchBoard.restore(state.board);
      } catch {
        this.board = new ResearchBoard();
      }
    }
    let maxDocNum = 0;
    for (const [id, doc] of Object.entries(state.docs ?? {})) {
      this.docs.set(id, { title: doc.title, text: doc.text, persist: true });
      const seqMatch = /_(\d+)$/.exec(id);
      if (seqMatch?.[1] !== undefined) {
        const parsedSeq = Number.parseInt(seqMatch[1], 10);
        if (Number.isFinite(parsedSeq) && parsedSeq > maxDocNum) maxDocNum = parsedSeq;
      }
    }
    const savedSeq = typeof state.docSeq === 'number' && Number.isFinite(state.docSeq) ? state.docSeq : 0;
    this.docSeq = Math.max(savedSeq, maxDocNum, this.docs.size);
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
      if (count >= MAX_PERSISTED_DOCS) break;
      let text = doc.text;
      if (id.startsWith(BRANCH_REPORT_ID_PREFIX) && text.length > MAX_SINGLE_REPORT_CHARS) {
        text = `${text.slice(0, MAX_SINGLE_REPORT_CHARS)}\n…[truncated ${text.length - MAX_SINGLE_REPORT_CHARS} chars]`;
      }
      if (chars + text.length > MAX_PERSISTED_DOC_CHARS) continue;
      docs[id] = { title: doc.title, text };
      chars += text.length;
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
      ...(this.initialDocRevs !== undefined ? { initialDocRevs: this.initialDocRevs } : {}),
      ...(this.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: this.initialBoardSnapshot } : {}),
      ...(this.initialBoardRev !== undefined ? { initialBoardRev: this.initialBoardRev } : {}),
      ...(this.sources.size > 0 ? { sources: [...this.sources] } : {}),
      ...(this.docSeq > 0 ? { docSeq: this.docSeq } : {}),
      ...(board !== undefined ? { board } : {}),
      ...(this.pending !== undefined ? { pending: this.pending } : {}),
      ...(count > 0 ? { docs } : {}),
    };
  }
}

/** Build a compact RAF-native compaction summary without extra LLM calls. */
export function buildCompactionSummary(session: SessionState): string {
  const sections: string[] = [];
  const settled = session.board.renderSettled();
  if (settled !== undefined && settled.trim() !== '') {
    sections.push(`## Shared Research Board\n${settled.trim()}`);
  }
  const blocks = session.rootState?.blocks ?? [];
  if (blocks.length > 0) {
    const blockLines = blocks.map((b) => `- [Steps ${b.from}-${b.to}] ${b.summary}`);
    sections.push(`## Folded History\n${blockLines.join('\n')}`);
  }
  const latest = session.rootState?.latest;
  if (latest !== undefined) {
    const obs = latest.observation.replace(/\s+/g, ' ').trim();
    sections.push(
      `## Latest Interaction (Step ${latest.step}: ${latest.action.name})\n${obs.length > 600 ? `${obs.slice(0, 600)}…` : obs}`,
    );
  }
  if (sections.length === 0) return '';
  const combined = sections.join('\n\n');
  return combined.length > 12_000 ? `${combined.slice(0, 11_997)}...` : combined;
}

/** Extract host project_context, skills, and addendum sections from Pi messages or systemPromptOptions. */
export function extractHostInstructions(messages: readonly unknown[], systemPromptOptions?: unknown): string {
  const merged: Record<string, string> = {};
  const keys = ['project_context', 'skills', 'addendum'] as const;
  for (const msg of messages) {
    if (msg === null || typeof msg !== 'object') continue;
    const rec = msg as { readonly role?: unknown; readonly sections?: unknown };
    if (rec.role !== 'system' || rec.sections === null || typeof rec.sections !== 'object') continue;
    const sections = rec.sections as Record<string, unknown>;
    for (const k of keys) {
      const val = sections[k];
      if (val === null) delete merged[k];
      else if (typeof val === 'string' && val.trim() !== '') merged[k] = val.trim();
    }
  }
  if (systemPromptOptions !== null && typeof systemPromptOptions === 'object') {
    if (
      'sections' in systemPromptOptions &&
      systemPromptOptions.sections !== null &&
      typeof systemPromptOptions.sections === 'object'
    ) {
      const sec = systemPromptOptions.sections as Record<string, unknown>;
      for (const k of keys) {
        const val = sec[k];
        if (merged[k] === undefined && typeof val === 'string' && val.trim() !== '') {
          merged[k] = val.trim();
        }
      }
    }
    if (
      merged.project_context === undefined &&
      'contextFiles' in systemPromptOptions &&
      Array.isArray(systemPromptOptions.contextFiles) &&
      systemPromptOptions.contextFiles.length > 0
    ) {
      const filesText = systemPromptOptions.contextFiles
        .filter(
          (f): f is { readonly path: string; readonly content: string } =>
            f !== null &&
            typeof f === 'object' &&
            'path' in f &&
            typeof f.path === 'string' &&
            'content' in f &&
            typeof f.content === 'string',
        )
        .map((f) => `## ${f.path}\n${f.content.trim()}`)
        .join('\n\n');
      if (filesText !== '') merged.project_context = filesText;
    }
    if (
      merged.skills === undefined &&
      'skills' in systemPromptOptions &&
      Array.isArray(systemPromptOptions.skills) &&
      systemPromptOptions.skills.length > 0
    ) {
      const skillLines = systemPromptOptions.skills
        .filter(
          (s): s is { readonly name: string; readonly description?: string; readonly filePath?: string } =>
            s !== null && typeof s === 'object' && 'name' in s && typeof s.name === 'string',
        )
        .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}${s.filePath ? ` (${s.filePath})` : ''}`);
      if (skillLines.length > 0) {
        merged.skills = `<available_skills>\n${skillLines.join('\n')}\n</available_skills>`;
      }
    }
    if (
      merged.addendum === undefined &&
      'appendSystemPrompt' in systemPromptOptions &&
      typeof systemPromptOptions.appendSystemPrompt === 'string' &&
      systemPromptOptions.appendSystemPrompt.trim() !== ''
    ) {
      merged.addendum = systemPromptOptions.appendSystemPrompt.trim();
    }
  }
  const parts: string[] = [];
  for (const k of keys) {
    const val = merged[k];
    if (val !== undefined && val !== '') parts.push(val);
  }
  return parts.join('\n\n');
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
