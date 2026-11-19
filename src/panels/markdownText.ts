/**
 * Markdown as one line of plain text, for the places that show a preview (card titles, headers,
 * tooltips): the syntax drops away, the words stay. Full rendering is `Markdown`.
 */
export function plainText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(```|~~~).*$/gm, '') // fences (their contents stay)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // quotes
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, '') // rules
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '') // table separators
    .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/gm, '$1') // bullets and checkboxes
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1') // links and images: their text
    .replace(/(`+)([\s\S]+?)\1/g, '$2') // inline code
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/~~(.+?)~~/g, '$1') // strike
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2') // italic *x*
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2') // italic _x_
    .replace(/[ \t]*\|[ \t]*/g, ' · ') // table cells
    .replace(/^ · | · $/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
