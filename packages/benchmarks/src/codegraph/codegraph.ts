import type { BenchDocument, BenchTask } from '../runner.js';

/** Mulberry32 seeded PRNG for deterministic multi-module codebases. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CodeGraphOptions {
  tokens: number;
  tasks: number;
  hops?: number;
  seed?: number;
}

const MODULE_SPECS = Object.freeze([
  { id: 'app_gateway', title: 'src/gateway/app_gateway.ts — Gateway & Ingress Routing Module' },
  { id: 'service_order', title: 'src/services/service_order.ts — Order Orchestration Service' },
  { id: 'service_billing', title: 'src/services/service_billing.ts — Billing & Settlement Service' },
  { id: 'lib_auth', title: 'src/libs/lib_auth.ts — Authentication & Key Derivation Library' },
  { id: 'lib_crypto', title: 'src/libs/lib_crypto.ts — Cryptographic Checksum & Nonce Library' },
  { id: 'lib_pricing', title: 'src/libs/lib_pricing.ts — Pricing Tier & Discount Engine' },
  { id: 'lib_tax_rules', title: 'src/libs/lib_tax_rules.ts — Regional Tax & Surcharge Rules Engine' },
  { id: 'spec_protocol', title: 'docs/spec_protocol.md — Wire Frame Protocol & Retry Specification' },
]);

const FILLER_PREFIXES = Object.freeze([
  'validateHeaderField',
  'normalizeRouteSegment',
  'serializeAuditRecord',
  'parseTelemetrySpan',
  'computeBackpressureWindow',
  'formatLedgerTimestamp',
  'sanitizePayloadEnvelope',
  'checkCircuitBreakerState',
]);

function buildTwoStageModule(
  moduleId: string,
  targetChars: number,
  r: () => number,
  stage1Lines: readonly string[],
  stage2Lines: readonly string[],
): string {
  const s1 = stage1Lines.join('\n');
  const s2 = stage2Lines.join('\n');
  const budget = Math.max(2048, targetChars - s1.length - s2.length);
  const lines: string[] = [
    `// Module: ${moduleId}`,
    `// Enterprise multi-module codebase component.`,
    '',
  ];
  let chars = lines.join('\n').length;
  let fnIdx = 1;
  const stage1Target = Math.floor(budget * 0.35);
  const stage2Target = Math.floor(budget * 0.78);

  const pushFiller = () => {
    const prefix = FILLER_PREFIXES[fnIdx % FILLER_PREFIXES.length] ?? 'helperOp';
    const c1 = 10 + Math.floor(r() * 90);
    const c2 = 100 + Math.floor(r() * 800);
    const block = [
      `export function ${prefix}_${moduleId}_${fnIdx}(input: number): number {`,
      `  const adjusted = (input + ${c1}) ^ ${c2};`,
      `  return adjusted >= 0 ? adjusted : -adjusted;`,
      `}`,
    ].join('\n');
    lines.push(block);
    chars += block.length + 1;
    fnIdx++;
  };

  while (chars < stage1Target) pushFiller();
  lines.push('', '// === SECTION A: PUBLIC ENTRYPOINTS & ROUTING ===', s1, '');
  while (chars < stage2Target) pushFiller();
  lines.push('', '// === SECTION B: INTERNAL CONSTANTS & DOWNSTREAM BINDINGS ===', s2, '');
  while (chars < budget) pushFiller();

  return lines.join('\n');
}

function parseFinalInt(out: string): number | undefined {
  const m =
    /answer\s*:\s*\**\s*(-?\d+)/i.exec(out) ??
    /(-?\d+)(?!.*\d)/s.exec(out.replace(/,/g, ''));
  if (!m || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Multi-document codebase & specification benchmark (`codegraph`):
 *  - `spec_specialist`: combines frame dispatch in `app_gateway` and `service_order`
 *    with protocol constants defined in `spec_protocol`.
 *  - `diamond_deps`: computes combined settlement signature across `service_order`
 *    and `service_billing`, both of which depend on `lib_auth` and `lib_crypto`.
 *  - `chain_hop`: traces a 1..3 hop request pipeline (`app_gateway` ->
 *    `service_order` -> `lib_pricing` -> `lib_tax_rules`) where each hop target
 *    is discovered inside the upstream module.
 */
export function buildCodeGraphTasks(opts: CodeGraphOptions): BenchTask[] {
  const seed = opts.seed ?? 42;
  const hops = Math.max(1, Math.min(3, opts.hops ?? 3));
  const r = rng(seed);
  const randInt = (min: number, max: number) => min + Math.floor(r() * (max - min + 1));

  // Shared library & specification constants
  const protocolRetryMultiplier = randInt(3, 9);
  const protocolFrameMask = randInt(110, 490);
  const protocolAckOffset = randInt(30, 95);

  const authKdfRounds = randInt(4, 12);
  const authSaltOffset = randInt(200, 750);
  const authIssuerBonus = randInt(40, 130);
  const cryptoNonceStep = randInt(50, 190);
  const cryptoPrimeMod = randInt(300, 890);

  const orderHopDelta = randInt(120, 380);
  const pricingTierFactor = randInt(2, 6);
  const pricingFlatFee = randInt(40, 160);
  const taxRateMultiplier = randInt(2, 5);
  const taxSurchargeConst = randInt(25, 125);

  const numTasks = Math.max(1, opts.tasks);
  const variants = Array.from({ length: numTasks }, (_, i) => ({
    idx: i,
    gatewayFrameHex: randInt(20, 85),
    orderDispatchWeight: randInt(100, 450),
    orderServiceCoeff: randInt(11, 39),
    billingServiceCoeff: randInt(15, 47),
    gatewayBasePayload: randInt(50, 220),
  }));

  const charsPerDoc = Math.max(2500, Math.round((opts.tokens * 4) / MODULE_SPECS.length));

  const stage1ByModule: Record<string, string[]> = {
    app_gateway: [
      ...variants.map(
        (v) =>
          `export function evaluateFrameProfile_${v.idx}(): string {\n` +
          `  // Uses GATEWAY_FRAME_HEX_${v.idx} (defined in SECTION B of app_gateway)\n` +
          `  // and combines with service_order.getOrderFrameWeight_${v.idx}() and spec_protocol.\n` +
          `  return "see SECTION B for GATEWAY_FRAME_HEX_${v.idx} and spec_protocol for frame scoring";\n` +
          `}`,
      ),
      ...variants.map(
        (v) =>
          `export function runPipelineFlow_${v.idx}(): string {\n` +
          `  // Starts with GATEWAY_BASE_PAYLOAD_${v.idx} (in SECTION B of app_gateway),\n` +
          `  // then forwards to Hop 1 downstream module specified in SECTION B.\n` +
          `  return "see SECTION B for GATEWAY_BASE_PAYLOAD_${v.idx} and Hop 1 target";\n` +
          `}`,
      ),
    ],
    service_order: [
      ...variants.map(
        (v) =>
          `export function getOrderFrameWeight_${v.idx}(): string {\n` +
          `  // Returns ORDER_DISPATCH_WEIGHT_${v.idx} + PROTOCOL_ACK_OFFSET from spec_protocol\n` +
          `  return "see SECTION B for ORDER_DISPATCH_WEIGHT_${v.idx}";\n` +
          `}`,
      ),
      ...variants.map(
        (v) =>
          `export function computeOrderSettlement_${v.idx}(): string {\n` +
          `  // Uses ORDER_SERVICE_COEFF_${v.idx} (in SECTION B) and shared libraries lib_auth & lib_crypto.\n` +
          `  return "see SECTION B for formula and ORDER_SERVICE_COEFF_${v.idx}";\n` +
          `}`,
      ),
      `export function applyOrderHopTransform(input: number): number {`,
      `  // Hop 1 transform: see SECTION B for ORDER_HOP_DELTA and Hop 2 downstream target module`,
      `  return input;`,
      `}`,
    ],
    service_billing: [
      ...variants.map(
        (v) =>
          `export function computeBillingSettlement_${v.idx}(): string {\n` +
          `  // Uses BILLING_SERVICE_COEFF_${v.idx} (in SECTION B) and shared libraries lib_auth & lib_crypto.\n` +
          `  return "see SECTION B for formula and BILLING_SERVICE_COEFF_${v.idx}";\n` +
          `}`,
      ),
    ],
    lib_auth: [
      `// Authentication library entrypoints (constants in SECTION B)`,
      `export function getAuthKdfConfig(): string { return "see SECTION B: AUTH_KDF_ROUNDS, AUTH_SALT_OFFSET, AUTH_ISSUER_BONUS"; }`,
    ],
    lib_crypto: [
      `// Cryptographic library entrypoints (constants in SECTION B)`,
      `export function getCryptoDigestConfig(): string { return "see SECTION B: CRYPTO_NONCE_STEP, CRYPTO_PRIME_MOD"; }`,
    ],
    lib_pricing: [
      `// Pricing engine entrypoints (constants and Hop 3 target in SECTION B)`,
      `export function applyPricingHopTransform(hop1Value: number): number { return hop1Value; }`,
    ],
    lib_tax_rules: [
      `// Regional tax engine entrypoints (constants in SECTION B)`,
      `export function applyTaxHopTransform(hop2Value: number): number { return hop2Value; }`,
    ],
    spec_protocol: [
      `# Wire Frame Protocol & Retry Specification (Overview)`,
      `See SECTION B of spec_protocol for exact numeric constants: PROTOCOL_RETRY_MULTIPLIER, PROTOCOL_FRAME_MASK, PROTOCOL_ACK_OFFSET, and the frame score formula.`,
    ],
  };

  const stage2ByModule: Record<string, string[]> = {
    app_gateway: [
      `// Downstream Hop 1 target module: service_order (function applyOrderHopTransform)`,
      `// Protocol specification document: spec_protocol`,
      ...variants.map((v) => `export const GATEWAY_FRAME_HEX_${v.idx} = ${v.gatewayFrameHex};`),
      ...variants.map((v) => `export const GATEWAY_BASE_PAYLOAD_${v.idx} = ${v.gatewayBasePayload};`),
    ],
    service_order: [
      `// Shared dependencies: lib_auth (AUTH_KDF_ROUNDS, AUTH_SALT_OFFSET) and lib_crypto (CRYPTO_NONCE_STEP)`,
      `// Downstream Hop 2 target module: lib_pricing (function applyPricingHopTransform)`,
      `export const ORDER_HOP_DELTA = ${orderHopDelta};`,
      ...variants.map((v) => `export const ORDER_DISPATCH_WEIGHT_${v.idx} = ${v.orderDispatchWeight};`),
      ...variants.map((v) => `export const ORDER_SERVICE_COEFF_${v.idx} = ${v.orderServiceCoeff};`),
      `// Order Settlement Formula: orderSig = (ORDER_SERVICE_COEFF_i * AUTH_KDF_ROUNDS) + AUTH_SALT_OFFSET + CRYPTO_NONCE_STEP`,
      `// Hop 1 Transform Formula: hop1 = basePayload + ORDER_HOP_DELTA (where ORDER_HOP_DELTA = ${orderHopDelta})`,
    ],
    service_billing: [
      `// Shared dependencies: lib_auth (AUTH_KDF_ROUNDS, AUTH_SALT_OFFSET, AUTH_ISSUER_BONUS) and lib_crypto (CRYPTO_PRIME_MOD)`,
      ...variants.map((v) => `export const BILLING_SERVICE_COEFF_${v.idx} = ${v.billingServiceCoeff};`),
      `// Billing Settlement Formula: billingSig = (BILLING_SERVICE_COEFF_i * AUTH_KDF_ROUNDS) + AUTH_SALT_OFFSET + AUTH_ISSUER_BONUS + CRYPTO_PRIME_MOD`,
    ],
    lib_auth: [
      `export const AUTH_KDF_ROUNDS = ${authKdfRounds};`,
      `export const AUTH_SALT_OFFSET = ${authSaltOffset};`,
      `export const AUTH_ISSUER_BONUS = ${authIssuerBonus};`,
    ],
    lib_crypto: [
      `export const CRYPTO_NONCE_STEP = ${cryptoNonceStep};`,
      `export const CRYPTO_PRIME_MOD = ${cryptoPrimeMod};`,
    ],
    lib_pricing: [
      `// Downstream Hop 3 target module: lib_tax_rules (function applyTaxHopTransform)`,
      `export const PRICING_TIER_FACTOR = ${pricingTierFactor};`,
      `export const PRICING_FLAT_FEE = ${pricingFlatFee};`,
      `// Hop 2 Transform Formula: hop2 = (hop1 * PRICING_TIER_FACTOR) + PRICING_FLAT_FEE`,
    ],
    lib_tax_rules: [
      `// Terminal Hop 3 module`,
      `export const TAX_RATE_MULTIPLIER = ${taxRateMultiplier};`,
      `export const TAX_SURCHARGE_CONST = ${taxSurchargeConst};`,
      `// Hop 3 Transform Formula: hop3 = (hop2 * TAX_RATE_MULTIPLIER) + TAX_SURCHARGE_CONST`,
    ],
    spec_protocol: [
      `## SECTION B: Normative Protocol Constants & Frame Score Formula`,
      `- PROTOCOL_RETRY_MULTIPLIER = ${protocolRetryMultiplier}`,
      `- PROTOCOL_FRAME_MASK = ${protocolFrameMask}`,
      `- PROTOCOL_ACK_OFFSET = ${protocolAckOffset}`,
      `- Normative Formula for evaluateFrameProfile_i:`,
      `  effectiveFrameScore = (GATEWAY_FRAME_HEX_i * PROTOCOL_RETRY_MULTIPLIER) + ORDER_DISPATCH_WEIGHT_i + PROTOCOL_ACK_OFFSET + PROTOCOL_FRAME_MASK`,
    ],
  };

  const documents: BenchDocument[] = MODULE_SPECS.map((m) => {
    const text = buildTwoStageModule(
      m.id,
      charsPerDoc,
      r,
      stage1ByModule[m.id] ?? [],
      stage2ByModule[m.id] ?? [],
    );
    return {
      id: m.id,
      title: m.title,
      text,
      tokens: Math.round(text.length / 4),
    };
  });
  const totalTokens = documents.reduce((acc, d) => acc + (d.tokens ?? 0), 0);

  const tasks: BenchTask[] = [];
  for (let i = 0; i < numTasks; i++) {
    const v = variants[i];
    if (!v) continue;
    const kindIdx = i % 3;
    if (kindIdx === 0) {
      const gold =
        v.gatewayFrameHex * protocolRetryMultiplier +
        v.orderDispatchWeight +
        protocolAckOffset +
        protocolFrameMask;
      tasks.push({
        id: `codegraph-${opts.tokens}-spec-${i}`,
        group: `codegraph-${opts.tokens}-${seed}`,
        question:
          `Determine the exact numeric \`effectiveFrameScore\` for profile index ${i} (\`evaluateFrameProfile_${i}\`).\n` +
          `If the \`branch\` tool is available, you MUST delegate module research to scoped specialists (\`scope="app_gateway"\`, \`scope="service_order"\`, \`scope="spec_protocol"\`) and query existing specialists on the board rather than grepping all documents in root.\n` +
          `Give your final answer in the form 'Answer: <number>'.`,
        documents,
        meta: {
          task: 'spec_specialist',
          answer_type: 'ANSWER_TYPE.NUMERIC',
          context_len: totalTokens,
          hops: 2,
          gold,
        },
        score: (out) => {
          const parsed = parseFinalInt(out);
          return {
            score: parsed === gold ? 1 : 0,
            ...(parsed !== undefined ? { parsed: String(parsed) } : {}),
          };
        },
      });
    } else if (kindIdx === 1) {
      const orderSig = v.orderServiceCoeff * authKdfRounds + authSaltOffset + cryptoNonceStep;
      const billingSig =
        v.billingServiceCoeff * authKdfRounds +
        authSaltOffset +
        authIssuerBonus +
        cryptoPrimeMod;
      const gold = orderSig + billingSig;
      tasks.push({
        id: `codegraph-${opts.tokens}-diamond-${i}`,
        group: `codegraph-${opts.tokens}-${seed}`,
        question:
          `Compute the combined settlement total \`computeOrderSettlement_${i}() + computeBillingSettlement_${i}()\` for profile index ${i}.\n` +
          `If the \`branch\` tool is available, you MUST dispatch parallel service specialists (\`tasks: [{"scope":"service_order",...}, {"scope":"service_billing",...}]\`), and each service specialist should query/delegate shared library specialists (\`scope="lib_auth"\`, \`scope="lib_crypto"\`) on the board without duplicating library study.\n` +
          `Give your final answer in the form 'Answer: <number>'.`,
        documents,
        meta: {
          task: 'diamond_deps',
          answer_type: 'ANSWER_TYPE.NUMERIC',
          context_len: totalTokens,
          hops: 2,
          gold,
        },
        score: (out) => {
          const parsed = parseFinalInt(out);
          return {
            score: parsed === gold ? 1 : 0,
            ...(parsed !== undefined ? { parsed: String(parsed) } : {}),
          };
        },
      });
    } else {
      const hop1 = v.gatewayBasePayload + orderHopDelta;
      const hop2 = hop1 * pricingTierFactor + pricingFlatFee;
      const hop3 = hop2 * taxRateMultiplier + taxSurchargeConst;
      const gold = hops === 1 ? hop1 : hops === 2 ? hop2 : hop3;
      tasks.push({
        id: `codegraph-${opts.tokens}-chain-h${hops}-${i}`,
        group: `codegraph-${opts.tokens}-${seed}`,
        question:
          `Trace the ${hops}-hop request transformation pipeline for flow index ${i} (\`runPipelineFlow_${i}\`) starting in \`app_gateway\`.\n` +
          `If the \`branch\` tool is available, delegate \`scope="app_gateway"\` and have each hop module specialist delegate or query the next downstream hop module specialist (\`scope="<module_id>"\`) up to Hop ${hops}.\n` +
          `What is the exact numeric output after Hop ${hops}? Give your final answer in the form 'Answer: <number>'.`,
        documents,
        meta: {
          task: 'chain_hop',
          answer_type: 'ANSWER_TYPE.NUMERIC',
          context_len: totalTokens,
          hops,
          gold,
        },
        score: (out) => {
          const parsed = parseFinalInt(out);
          return {
            score: parsed === gold ? 1 : 0,
            ...(parsed !== undefined ? { parsed: String(parsed) } : {}),
          };
        },
      });
    }
  }

  return tasks;
}
