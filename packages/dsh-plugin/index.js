import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ENGINE_STANDARD = 'standard';
const ENGINE_RAF = 'raf';
const ENGINE_ROUTE = '/plugins/@raf/dsh-plugin/engine';
const DEFAULT_SETTINGS = Object.freeze({ depth: 2, reserve: 0.3, concurrency: 4 });
const DEPTH_MIN = 1;
const DEPTH_MAX = 3;
const RESERVE_MIN = 0.1;
const RESERVE_MAX = 0.5;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const MAX_BODY_BYTES = 8192;
const MAX_ENGINE_ENTRIES = 2000;
const RAF_ROOT_MAX_STEPS = 32;

export const inject = ['llm'];

const rafInternal = new AsyncLocalStorage();

let rafPromise;

function loadRaf() {
  rafPromise ??= import(new URL('../engine/dist/index.js', import.meta.url));
  return rafPromise;
}

function toInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function toReserve(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SETTINGS.reserve;
  const clamped = Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, number));
  return Number((Math.round(clamped / 0.05) * 0.05).toFixed(2));
}

function sanitizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return Object.freeze({
    depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
    reserve: toReserve(source.reserve),
    concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
  });
}

function sanitizeEngine(value) {
  return value === ENGINE_RAF ? ENGINE_RAF : ENGINE_STANDARD;
}

function statePath() {
  const base = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh');
  return join(base, 'raf-engine', 'state.json');
}

function loadState() {
  const fallback = { engines: Object.create(null), settings: DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const engines = Object.create(null);
    if (parsed.engines !== null && typeof parsed.engines === 'object') {
      for (const [sessionId, value] of Object.entries(parsed.engines)) {
        if (sanitizeEngine(value) === ENGINE_RAF) engines[sessionId] = ENGINE_RAF;
      }
    }
    return { engines, settings: sanitizeSettings(parsed.settings) };
  } catch {
    return fallback;
  }
}

function stateJson(state) {
  return JSON.stringify({ version: 1, engines: state.engines, settings: state.settings }, null, 2);
}

function engineOf(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return ENGINE_STANDARD;
  return state.engines[sessionId] === ENGINE_RAF ? ENGINE_RAF : ENGINE_STANDARD;
}

function setEngine(state, sessionId, engine) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (sanitizeEngine(engine) === ENGINE_RAF) state.engines[sessionId] = ENGINE_RAF;
  else delete state.engines[sessionId];
  const keys = Object.keys(state.engines);
  while (keys.length > MAX_ENGINE_ENTRIES) {
    const oldest = keys.shift();
    if (oldest !== undefined) delete state.engines[oldest];
  }
}

function renderContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      parts.push(`[tool call ${block.name ?? 'tool'}] ${args}`);
      continue;
    }
    if (block.type === 'image') {
      parts.push('[image]');
      continue;
    }
    if (block.type === 'file') {
      const name = block.attachment !== null && typeof block.attachment === 'object' ? block.attachment.name : '';
      parts.push(`[file ${typeof name === 'string' ? name : ''}]`);
    }
  }
  return parts.join('\n').trim();
}

function latestUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== null && typeof message === 'object' && message.role === 'user') return index;
  }
  return -1;
}

function renderTranscript(messages) {
  const parts = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
    const text = renderContent(message.content);
    if (text === '') continue;
    const label = message.role === 'tool' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`## ${label}\n${text}`);
  }
  return parts.join('\n\n');
}

function questionOf(messages, index) {
  if (index < 0) return '';
  return renderContent(messages[index].content);
}

function contextWindowOf(ctx, sessionId) {
  try {
    const agents = ctx.get('agents');
    const meter = ctx.get('tokenMeter');
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent !== undefined && meter !== undefined && typeof meter.contextPressure === 'function') {
      const pressure = meter.contextPressure(agent.session);
      if (pressure !== null && typeof pressure === 'object' && Number.isFinite(pressure.contextWindow)) {
        return pressure.contextWindow;
      }
    }
  } catch {
    // Fall through to the conservative default.
  }
  return 128000;
}

function dshMessage(message, outer) {
  const role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
  const content = [{ type: 'text', text: message.content }];
  if (role === 'system') {
    return { id: randomUUID(), role, content, source: { kind: 'system-prompt' } };
  }
  if (role === 'assistant') {
    return {
      id: randomUUID(),
      role,
      content,
      source: { kind: 'model', provider: outer.provider, model: outer.model },
    };
  }
  return { id: randomUUID(), role, content, source: { kind: 'user' } };
}

function mapUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  const inputTokens = typeof source.inputTokens === 'number' ? source.inputTokens : 0;
  const outputTokens = typeof source.outputTokens === 'number' ? source.outputTokens : 0;
  const cachedTokens = typeof source.cacheReadTokens === 'number' ? source.cacheReadTokens : 0;
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    cachedTokens,
  };
}

class DshLlmClient {
  constructor(ctx, outer, profile, reasoningEffort) {
    this.ctx = ctx;
    this.outer = outer;
    this.profile = profile;
    this.reasoningEffort = reasoningEffort;
  }

  async complete(request) {
    const signal = request.signal ?? this.outer.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const started = Date.now();
    const options = {
      provider: this.outer.provider,
      model: this.outer.model,
      messages: request.messages.map((message) => dshMessage(message, this.outer)),
      sessionId: this.outer.sessionId,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    let text = '';
    let reasoning = '';
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let finishKind;
    let failure;
    await rafInternal.run(true, async () => {
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind;
          failure = chunk.reason?.failure;
        }
      }
    });
    if (finishKind === 'error' || finishKind === 'aborted') {
      const error = new Error(typeof failure?.message === 'string' ? failure.message : 'LLM request failed');
      if (typeof failure?.code === 'string') error.code = failure.code;
      throw error;
    }
    return {
      text,
      reasoning,
      usage: mapUsage(usage),
      model: this.outer.model,
      latencyMs: Date.now() - started,
      ...(finishKind === 'max-tokens' ? { finishReason: 'length' } : {}),
    };
  }
}

async function* rafStream(ctx, outer, settings) {
  const signal = outer.signal;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const raf = await loadRaf();
    const messages = Array.isArray(outer.messages) ? outer.messages : [];
    const userIndex = latestUserIndex(messages);
    const question = questionOf(messages, userIndex);
    const transcript = renderTranscript(userIndex < 0 ? messages : messages.slice(0, userIndex));
    const contextWindow = contextWindowOf(ctx, outer.sessionId);
    const profile = {
      name: outer.model,
      contextWindow,
      maxOutputTokens: 4096,
    };
    const store = new raf.ContextStore();
    if (transcript !== '') store.add(transcript, { id: 'session', title: 'DSH session transcript' });
    const rootLLM = new DshLlmClient(ctx, outer, profile, outer.reasoningEffort);
    const queryLLM = new DshLlmClient(ctx, outer, profile, undefined);
    const engine = new raf.RecursiveAgentFold({
      rootLLM,
      queryLLM,
      store,
      maxDepth: settings.depth,
      llmQuery: { reserveRatio: settings.reserve, concurrency: settings.concurrency },
      rootMaxSteps: RAF_ROOT_MAX_STEPS,
      signal,
    });
    const result = await engine.run(question === '' ? 'Answer the latest request.' : question);
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    const text =
      answer !== ''
        ? answer
        : result.error !== undefined
          ? `RAF engine error: ${result.error}`
          : 'RAF engine returned no answer.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let offset = 0; offset < text.length; offset += 2000) {
      yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + 2000) };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    const total = result.usage.total();
    yield {
      type: 'usage',
      usage: {
        inputTokens: total.promptTokens,
        outputTokens: total.completionTokens,
        cacheReadTokens: total.cachedTokens,
        totalTokens: total.promptTokens + total.completionTokens,
      },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const text = `RAF engine error: ${message}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}


function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function admissionRejection(ctx, req) {
  try {
    const connection = ctx.get('connection');
    if (connection === undefined || typeof connection.admit !== 'function') return undefined;
    const admission = connection.admit(req);
    return 'rejection' in admission ? admission.rejection : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  const state = loadState();
  let writeQueue = Promise.resolve();
  let disposed = false;

  const persist = () => {
    if (disposed) return;
    const json = stateJson(state);
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(dirname(statePath()), { recursive: true });
        const temporary = `${statePath()}.tmp`;
        await writeFile(temporary, json, 'utf8');
        await rename(temporary, statePath());
      })
      .catch((error) => {
        console.error('RAF: cannot persist engine state', error);
      });
  };

  ctx.on('llm/stream', (options, next) => {
    if (rafInternal.getStore() === true) return next();
    if (options === null || typeof options !== 'object') return next();
    if (engineOf(state, options.sessionId) !== ENGINE_RAF) return next();
    return rafStream(ctx, options, state.settings);
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ENGINE_ROUTE,
          handler: async (req, res) => {
            try {
              const rejection = admissionRejection(webCtx, req);
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              const url = new URL(req.url ?? '/', 'http://localhost');
              const sessionId = url.searchParams.get('sessionId') ?? undefined;
              if (req.method === 'GET') {
                sendJson(res, 200, {
                  ...(sessionId === undefined ? {} : { engine: engineOf(state, sessionId) }),
                  settings: state.settings,
                });
                return;
              }
              if (req.method !== 'POST') {
                res.writeHead(405, { allow: 'GET, POST' });
                res.end('method not allowed');
                return;
              }
              const payload = JSON.parse(await readBody(req));
              if (payload === null || typeof payload !== 'object') throw new Error('invalid payload');
              if (payload.engine !== undefined) {
                if (typeof payload.sessionId !== 'string' || payload.sessionId === '') {
                  throw new Error('sessionId is required to switch the engine');
                }
                setEngine(state, payload.sessionId, payload.engine);
              }
              if (payload.settings !== undefined) {
                state.settings = sanitizeSettings(payload.settings);
              }
              persist();
              sendJson(res, 200, {
                ok: true,
                ...(sessionId === undefined ? {} : { engine: engineOf(state, sessionId) }),
                settings: state.settings,
              });
            } catch (error) {
              const status = typeof error?.status === 'number' ? error.status : 400;
              sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      'raf: engine state route',
    );
  });


  ctx.effect(
    () => () => {
      disposed = true;
    },
    'raf: engine state',
  );
}
