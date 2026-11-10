/**
 * Gemini-safe JSON Schema.
 *
 * pi forwards a tool's `parameters` to Google almost verbatim: it strips a
 * handful of meta keys and rewrites `const` into a single-value enum. Every
 * other keyword - `additionalProperties: false`, `anyOf` / `oneOf`, `$ref`,
 * `format`, `default`, numeric bounds - reaches Gemini's
 * `parametersJsonSchema` untouched. A declaration Gemini cannot compile makes
 * it answer any tool call with finishReason MALFORMED_FUNCTION_CALL, which pi
 * surfaces as `Provider stopped with: MALFORMED_FUNCTION_CALL`.
 *
 * `geminiSafeSchema` flattens a JSON Schema into the shape Gemini accepts:
 * plain object / array / scalar types, flat `properties`, string enums, and no
 * combinators at all.
 */

type Schema = Record<string, unknown>;

/** Keywords Gemini has no equivalent for; keeping them breaks declarations. */
const DROPPED: ReadonlySet<string> = new Set(
  Object.freeze([
    '$schema',
    '$id',
    '$anchor',
    '$dynamicAnchor',
    '$vocabulary',
    '$comment',
    '$defs',
    'definitions',
    '$ref',
    'const',
    'format',
    'default',
    'examples',
    'example',
    'contentMediaType',
    'contentEncoding',
    'patternProperties',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
    'dependentSchemas',
    'dependentRequired',
    'dependencies',
    'if',
    'then',
    'else',
    'not',
    'minProperties',
    'maxProperties',
    'uniqueItems',
    'multipleOf',
    'exclusiveMinimum',
    'exclusiveMaximum',
  ]),
);

/** Passed-through scalar constraints Gemini does understand. */
const KEPT_NUMBERS = Object.freeze(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const);

const MAX_DEPTH = 8;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) if (typeof item === 'string') out.push(item);
  return out;
}

/**
 * `anyOf` / `oneOf` / `allOf` have no Gemini equivalent. Merge object branches
 * into one flat object: union of properties, intersection of required (so we
 * never force a parameter a branch did not demand). Non-object branches collapse
 * to the first scalar shape.
 */
function mergeUnion(branches: unknown[], depth: number): Schema {
  const safe = branches.filter(isSchema).map((branch) => geminiSafeSchema(branch, depth + 1));
  if (safe.length === 0) return { type: 'object', properties: {} };

  const objects = safe.filter((schema) => schema.type === 'object' || isSchema(schema.properties));
  if (objects.length !== safe.length) return safe[0] ?? { type: 'object', properties: {} };

  const properties: Schema = {};
  for (const schema of objects) {
    if (!isSchema(schema.properties)) continue;
    for (const [name, value] of Object.entries(schema.properties)) {
      if (!(name in properties) && isSchema(value)) properties[name] = value;
    }
  }

  let required = asStringArray(objects[0]?.required);
  for (const schema of objects.slice(1)) {
    const names = new Set(asStringArray(schema.required));
    required = required.filter((name) => names.has(name));
  }

  const merged: Schema = { type: 'object' };
  if (Object.keys(properties).length > 0) merged.properties = properties;
  const valid = required.filter((name) => name in properties);
  if (valid.length > 0) merged.required = valid;
  return merged;
}

/**
 * Convert one JSON Schema node into the Gemini-safe subset. Always returns an
 * object schema with `properties` when the input described an object, and never
 * emits combinators, `$ref`, `const`, `additionalProperties: false`, or
 * non-scalar enums.
 */
export function geminiSafeSchema(input: unknown, depth = 0): Schema {
  if (!isSchema(input)) return { type: 'object', properties: {} };
  if (depth > MAX_DEPTH) return { type: 'object', properties: {} };

  const source: Schema = { ...input };

  const union = source.anyOf ?? source.oneOf ?? source.allOf;
  if (Array.isArray(union) && union.length > 0) {
    const merged = mergeUnion(union, depth);
    for (const [key, value] of Object.entries(merged)) source[key] = value;
  }
  delete source.anyOf;
  delete source.oneOf;
  delete source.allOf;

  if ('const' in source && !Array.isArray(source.enum)) source.enum = [source.const];

  for (const key of DROPPED) delete source[key];

  const properties: Schema = {};
  if (isSchema(source.properties)) {
    for (const [name, value] of Object.entries(source.properties)) {
      properties[name] = geminiSafeSchema(value, depth + 1);
    }
  }

  const declaredList = Array.isArray(source.type)
    ? asStringArray(source.type).filter((entry) => entry !== 'null')
    : [];
  const declared =
    typeof source.type === 'string'
      ? source.type
      : declaredList.length > 0
        ? Object.keys(properties).length > 0 && declaredList.includes('object')
          ? 'object'
          : source.items !== undefined && declaredList.includes('array')
            ? 'array'
            : declaredList[0]
        : undefined;
  const type = declared ?? (Object.keys(properties).length > 0 ? 'object' : undefined);

  const out: Schema = {};
  if (type !== undefined) out.type = type;
  if (Object.keys(properties).length > 0) out.properties = properties;

  const required = asStringArray(source.required).filter((name) => name in properties);
  if (required.length > 0) out.required = required;

  if (source.items !== undefined) out.items = geminiSafeSchema(source.items, depth + 1);

  if (Array.isArray(source.enum)) {
    const values: Array<string | number | boolean> = [];
    for (const value of source.enum) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        values.push(value);
      }
    }
    if (values.length > 0) out.enum = values;
  }

  if (typeof source.description === 'string') out.description = source.description;
  if (typeof source.pattern === 'string') out.pattern = source.pattern;
  for (const key of KEPT_NUMBERS) {
    const value = source[key];
    if (typeof value === 'number') out[key] = value;
  }

  const additional = source.additionalProperties;
  if (isSchema(additional)) out.additionalProperties = geminiSafeSchema(additional, depth + 1);

  if (Object.keys(out).length === 0) {
    out.type = 'object';
    out.properties = {};
  }
  return out;
}