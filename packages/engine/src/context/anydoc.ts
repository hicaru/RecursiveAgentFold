/**
 * Lazy NAPI handle for @firecrawl/anydoc.
 * Missing addon or failed load resolves to null and degrades rich documents to skipped: "no-converter".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

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

const JXA_PDFKIT_SCRIPT = [
  'ObjC.import("Quartz");',
  'function run(argv) {',
  '  const url = $.NSURL.fileURLWithPath(argv[0]);',
  '  const doc = $.PDFDocument.alloc.initWithURL(url);',
  '  if (!doc || doc.isNil()) return "";',
  '  const count = doc.pageCount;',
  '  const pages = [];',
  '  for (let i = 0; i < count; i++) {',
  '    const page = doc.pageAtIndex(i);',
  '    if (page && !page.isNil()) {',
  '      const s = page.string;',
  '      if (s && !s.isNil()) pages.push(ObjC.unwrap(s));',
  '    }',
  '  }',
  '  return pages.join("\\n\\n");',
  '}',
].join('\n');

const PY_PDF_SCRIPT = [
  'import sys',
  'p = sys.argv[1]',
  'try:',
  '    import pypdf',
  '    r = pypdf.PdfReader(p)',
  '    print("\\n\\n".join((page.extract_text() or "") for page in r.pages))',
  '    sys.exit(0)',
  'except Exception:',
  '    pass',
  'try:',
  '    import fitz',
  '    doc = fitz.open(p)',
  '    print("\\n\\n".join(page.get_text() for page in doc))',
  '    sys.exit(0)',
  'except Exception:',
  '    sys.exit(1)',
].join('\n');

/** Extract plain text from a PDF when @firecrawl/anydoc is unavailable. */
export async function convertPdfFallback(absPath: string): Promise<string | null> {
  const execOpts = { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 };
  try {
    const { stdout } = await execFileP('pdftotext', ['-layout', '-nopgbrk', absPath, '-'], execOpts);
    if (typeof stdout === 'string' && stdout.trim() !== '') return stdout;
  } catch {
    // pdftotext unavailable or failed; try platform/python fallbacks.
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('osascript', ['-l', 'JavaScript', '-e', JXA_PDFKIT_SCRIPT, absPath], execOpts);
      if (typeof stdout === 'string' && stdout.trim() !== '') return stdout;
    } catch {
      // PDFKit unavailable or failed; try python fallback.
    }
  }
  try {
    const { stdout } = await execFileP('python3', ['-c', PY_PDF_SCRIPT, absPath], execOpts);
    if (typeof stdout === 'string' && stdout.trim() !== '') return stdout;
  } catch {
    // No python PDF library available.
  }
  return null;
}
