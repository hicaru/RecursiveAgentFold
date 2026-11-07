/**
 * Lazy NAPI handle for @firecrawl/anydoc.
 * Missing addon or failed load resolves to null and degrades rich documents to skipped: "no-converter".
 */

export interface AnydocHandle {
  readonly formatFromPath: (path: string) => string | null;
  readonly toMarkdown: (path: string) => Promise<string>;
}

const DOCUMENT_EXTENSIONS: Readonly<Record<string, true>> = Object.freeze({
  doc: true,
  docx: true,
  docm: true,
  odt: true,
  rtf: true,
  epub: true,
  pdf: true,
  ppt: true,
  pptx: true,
  pptm: true,
  ppsx: true,
  odp: true,
  xls: true,
  xlsx: true,
  xlsm: true,
  xlsb: true,
  ods: true,
  csv: true,
});

export function documentExtFromPath(path: string): string | null {
  const normalized = path.includes('\\') ? path.split('\\').join('/') : path;
  const base = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return DOCUMENT_EXTENSIONS[ext] ? ext : null;
}

let cached: Promise<AnydocHandle | null> | undefined;

export function getAnydoc(): Promise<AnydocHandle | null> {
  const moduleSpecifier: string = '@firecrawl/anydoc';
  cached ??= import(moduleSpecifier)
    .then((mod: unknown): AnydocHandle | null => {
      if (mod === null || typeof mod !== 'object') return null;
      if (!('formatFromPath' in mod) || !('toMarkdown' in mod)) return null;
      const formatFn = mod.formatFromPath;
      const toMdFn = mod.toMarkdown;
      if (typeof formatFn !== 'function' || typeof toMdFn !== 'function') return null;
      return Object.freeze({
        formatFromPath: (p: string): string | null => {
          const res: unknown = formatFn(p);
          return typeof res === 'string' ? res : null;
        },
        toMarkdown: async (p: string): Promise<string> => {
          const res: unknown = await toMdFn(p);
          return typeof res === 'string' ? res : String(res ?? '');
        },
      });
    })
    .catch(() => null);
  return cached;
}

export function setAnydocForTest(handle: AnydocHandle | null | undefined): void {
  if (handle === undefined) {
    cached = undefined;
    return;
  }
  cached = Promise.resolve(handle);
}
