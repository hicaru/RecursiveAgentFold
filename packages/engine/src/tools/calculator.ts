import { argString, ToolArgumentError, type Tool } from './types.js';

/**
 * Safe arithmetic evaluator (no eval): numbers, + - * / % ^, parentheses,
 * unary minus, and functions sum/min/max/avg/round/floor/ceil/abs/sqrt.
 */
export function evaluateExpression(src: string): number {
  let i = 0;
  const s = src.replace(/_/g, ''); // allow 1_234 digit grouping (commas are argument separators)
  const peek = () => {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n') i++;
    return s[i];
  };
  const fns: Record<string, (xs: number[]) => number> = {
    sum: (xs) => xs.reduce((a, b) => a + b, 0),
    min: (xs) => Math.min(...xs),
    max: (xs) => Math.max(...xs),
    avg: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
    round: (xs) => (xs.length > 1 ? Number(xs[0]!.toFixed(xs[1])) : Math.round(xs[0]!)),
    floor: (xs) => Math.floor(xs[0]!),
    ceil: (xs) => Math.ceil(xs[0]!),
    abs: (xs) => Math.abs(xs[0]!),
    sqrt: (xs) => Math.sqrt(xs[0]!),
  };
  function primary(): number {
    const c = peek();
    if (c === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('expected )');
      i++;
      return v;
    }
    if (c === '-') {
      i++;
      return -power();
    }
    if (c === '+') {
      i++;
      return power();
    }
    const num = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?|^\.\d+/i.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[a-z_]+/i.exec(s.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += id[0].length;
      if (name === 'pi') return Math.PI;
      const fn = fns[name];
      if (!fn) throw new Error(`unknown function ${name}`);
      if (peek() !== '(') throw new Error(`expected ( after ${name}`);
      i++;
      const xs: number[] = [];
      if (peek() !== ')') {
        xs.push(expr());
        while (peek() === ',' || peek() === ';') {
          i++;
          xs.push(expr());
        }
      }
      if (peek() !== ')') throw new Error('expected )');
      i++;
      return fn(xs);
    }
    throw new Error(`unexpected "${c ?? 'end of input'}" at ${i}`);
  }
  function power(): number {
    const b = primary();
    if (peek() === '^') {
      i++;
      return b ** power();
    }
    return b;
  }
  function term(): number {
    let v = power();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/' || c === '%') {
        i++;
        const r = power();
        v = c === '*' ? v * r : c === '/' ? v / r : v % r;
      } else return v;
    }
  }
  function expr(): number {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === '+' || c === '-') {
        i++;
        const r = term();
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  const v = expr();
  if (peek() !== undefined) throw new Error(`unexpected "${s[i]}" at ${i}`);
  return v;
}

export function createCalculatorTool(): Tool {
  return {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression exactly, e.g. "sum(12, 40, 7) / 3" or "(a+b)*2" with numbers. Supports + - * / % ^ and sum/min/max/avg/round/floor/ceil/abs/sqrt.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    async execute(args) {
      const expression = argString(args, 'expression')!;
      try {
        const v = evaluateExpression(expression);
        return `${expression} = ${Number.isInteger(v) ? v : Number(v.toPrecision(12))}`;
      } catch (e) {
        throw new ToolArgumentError(`cannot evaluate: ${(e as Error).message}`);
      }
    },
  };
}
