import type { Snapshot } from '../core/types.js';
import { toDot } from './dot.js';
import { toJson } from './json.js';
import { toMarkdown } from './markdown.js';
import { toMermaid } from './mermaid.js';

export type ExportFormat = 'json' | 'md' | 'mermaid' | 'dot';

export const exporters: Record<
  ExportFormat,
  { contentType: string; extension: string; render: (s: Snapshot) => string }
> = {
  json: { contentType: 'application/json; charset=utf-8', extension: 'json', render: toJson },
  md: { contentType: 'text/markdown; charset=utf-8', extension: 'md', render: toMarkdown },
  mermaid: { contentType: 'text/plain; charset=utf-8', extension: 'mmd', render: toMermaid },
  dot: { contentType: 'text/vnd.graphviz; charset=utf-8', extension: 'dot', render: toDot },
};

export function isExportFormat(s: string): s is ExportFormat {
  return Object.hasOwn(exporters, s);
}

export { toDot, toJson, toMarkdown, toMermaid };
