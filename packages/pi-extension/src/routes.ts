import { clampThinkingLevel, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RafConfig } from './config.js';
import { findModel, modelSpec, type ChatModel } from './llm.js';

/** One resolved model tier. */
export interface Route {
  readonly model: ChatModel;
  readonly spec: string;
  readonly thinking: ModelThinkingLevel;
  /** True when the tier falls back to the root model. */
  readonly inherited: boolean;
  /** Set when the configured model is not in the catalog. */
  readonly missing?: string;
}

export interface Routes {
  readonly root: Route;
  readonly branch: Route;
  readonly reader: Route;
}

function tier(
  ctx: ExtensionContext,
  root: ChatModel,
  spec: string,
  thinking: ModelThinkingLevel,
): Route {
  const configured = spec === '' ? undefined : findModel(ctx.modelRegistry, spec);
  const model = configured ?? root;
  return Object.freeze({
    model,
    spec: modelSpec(model),
    thinking: clampThinkingLevel(model, thinking),
    inherited: configured === undefined,
    ...(spec !== '' && configured === undefined ? { missing: spec } : {}),
  });
}

/**
 * Resolve the root, branch (subagent), and reader (llm_query) models.
 * The root is the native `/model` selection. The reader never thinks.
 */
export function resolveRoutes(ctx: ExtensionContext, config: RafConfig): Routes | undefined {
  const root = ctx.model;
  if (root === undefined) return undefined;
  const rootThinking: ModelThinkingLevel = clampThinkingLevel(root, ctx.thinkingLevel ?? 'off');
  return Object.freeze({
    root: Object.freeze({ model: root, spec: modelSpec(root), thinking: rootThinking, inherited: false }),
    branch: tier(ctx, root, config.branchModel, config.branchThinking === 'inherit' ? rootThinking : config.branchThinking),
    reader: tier(ctx, root, config.readerModel, 'off'),
  });
}
