import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * A small markdown renderer for agent replies: headings, paragraphs, lists (nested by indent),
 * fenced code, quotes, rules, tables, and inline code / bold / italic / strike / links.
 * It builds React elements (never innerHTML), so an agent's text cannot inject markup.
 */
export default function Markdown({ text, className, onDoc }: {
  text: string;
  className?: string;
  /** Given: a markdown file's path (in code, a link or the text) becomes a link that opens it here. */
  onDoc?: (path: string) => void;
}) {
  const body = <div className={className}>{blocks(text.replace(/\r\n?/g, '\n').split('\n'))}</div>;
  return onDoc ? <DocOpener.Provider value={onDoc}>{body}</DocOpener.Provider> : body;
}

const DocOpener = createContext<((path: string) => void) | null>(null);

/** A path to a markdown file, as agents write them: `docs/plan.md`, `~/.claude/plans/x.md`, `/abs/PLAN.md`. */
export const DOC_PATH = /^(?:file:\/\/)?(?:~\/|\/|\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\w\.(?:md|markdown|mdx)$/i;

/** `path` with a trailing `:line` or `:line:col` (as agents cite files) taken off; null when it is not a doc's path. */
export function docPath(text: string): string | null {
  const p = text.trim().replace(/(?:#L?\d+|:\d+(?::\d+)?)$/, '');
  return DOC_PATH.test(p) ? p : null;
}

function safeDecode(s: string): string {
  try { return decodeURI(s); } catch { return s; }
}

/** Opens `path` in the reader when there is one, else shows `children` as they are. */
function DocLink({ path, children }: { path: string; children: ReactNode }) {
  const open = useContext(DocOpener);
  if (!open) return <>{children}</>;
  return (
    <a className="md-link md-doc" href="#" title={`Open ${path} here`}
      onClick={(e) => { e.preventDefault(); open(path); }}>
      {children}
    </a>
  );
}

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence
      out.push(<pre key={key()} className="md-pre"><code>{body.join('\n')}</code></pre>);
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 2, 6)}` as 'h3';
      out.push(<Tag key={key()} className="md-h">{inline(h[2])}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push(<hr key={key()} className="md-hr" />); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      out.push(<blockquote key={key()} className="md-quote">{blocks(body)}</blockquote>);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={key()} className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => <tr key={k}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (ITEM.test(line)) {
      const head = line.match(ITEM)!;
      const base = head[1].length;
      const ordered = /\d/.test(head[2]);
      // an item of the other kind at the base indent starts a new list
      const sameList = (l: string) => {
        const m = l.match(ITEM);
        return m ? m[1].length > base || /\d/.test(m[2]) === ordered : l.trim() !== '' && /^\s+/.test(l);
      };
      const body: string[] = [];
      while (i < lines.length && (sameList(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && sameList(lines[i + 1])))) {
        body.push(lines[i++]);
      }
      out.push(<Fragment key={key()}>{list(body)}</Fragment>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !ITEM.test(lines[i]) && !RULE.test(lines[i])) {
      para.push(lines[i++].trim());
    }
    out.push(<p key={key()} className="md-p">{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return out;
}

/** A run of list lines: items at the run's base indent, deeper lines belong to the item above. */
function list(lines: string[]): ReactNode {
  const first = lines[0].match(ITEM)!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: { text: string; rest: string[] }[] = [];
  for (const l of lines) {
    const m = l.match(ITEM);
    if (m && m[1].length <= base) items.push({ text: m[3], rest: [] });
    else if (items.length) items[items.length - 1].rest.push(l.slice(Math.min(base + 2, l.length - l.trimStart().length)));
  }
  const start = ordered ? parseInt(first[2], 10) : undefined;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="md-list" start={start !== 1 ? start : undefined}>
      {items.map((it, j) => {
        const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
        return (
          <li key={j}>
            {task ? <><span className="md-check">{task[1] === ' ' ? '☐' : '☑'}</span> {inline(task[2])}</> : inline(it.text)}
            {it.rest.some((r) => r.trim()) && blocks(it.rest)}
          </li>
        );
      })}
    </Tag>
  );
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const INLINE = /(`+)([\s\S]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(?<![\w.@+/~:-])((?:~\/|\/|\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\w\.(?:md|markdown|mdx))(?![\w/])/gi;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const at = m.index!;
    if (at > last) out.push(s.slice(last, at));
    const k = out.length;
    if (m[1]) {
      const code = <code key={k} className="md-code">{m[2].trim()}</code>;
      const doc = docPath(m[2]);
      out.push(doc ? <DocLink key={k} path={doc}>{code}</DocLink> : code);
    }
    else if (m[3] || m[4]) out.push(<strong key={k}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5]) out.push(<del key={k}>{inline(m[5])}</del>);
    else if (m[6] || m[7]) out.push(<em key={k}>{inline(m[6] ?? m[7])}</em>);
    else if (m[8]) out.push(link(k, m[9], inline(m[8])));
    else if (m[10]) out.push(link(k, m[10], m[10]));
    else if (m[11]) out.push(<DocLink key={k} path={m[11]}>{m[11]}</DocLink>);
    last = at + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function link(key: number, href: string, children: ReactNode): ReactNode {
  const doc = /^https?:\/\//i.test(href) ? null : docPath(safeDecode(href));
  if (doc) return <DocLink key={key} path={doc}>{children}</DocLink>;
  if (!/^https?:\/\//i.test(href)) return <span key={key} className="md-link-off">{children}</span>;
  return (
    <a key={key} className="md-link" href={href} title={href}
      onClick={(e) => { e.preventDefault(); openUrl(href).catch(() => {}); }}>
      {children}
    </a>
  );
}
