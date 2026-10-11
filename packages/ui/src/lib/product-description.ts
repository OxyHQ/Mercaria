import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export type DescriptionNode =
  | string
  | {
      tag: string;
      children: DescriptionNode[];
      href?: string;
      src?: string;
      alt?: string;
      start?: number;
      colSpan?: number;
      rowSpan?: number;
    };

type HtmlNode = DefaultTreeAdapterMap['childNode'];
const tags = new Set(
  'p div span br strong b em i u s del sub sup h1 h2 h3 h4 h5 h6 ul ol li a table thead tbody tfoot tr th td caption blockquote pre code hr img'.split(
    ' ',
  ),
);
const discarded = new Set(
  'script style iframe object embed template noscript head meta link form input button textarea select option svg math'.split(
    ' ',
  ),
);
const previewTags = new Set('b i em strong ul li br'.split(' '));

/** Author links are content, never executable URLs or an app navigation target. */
export function descriptionUrl(value: string | undefined, image = false): string | undefined {
  if (!value) return undefined;
  const url = value.trim();
  if (
    Array.from(url).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return undefined;
  try {
    const parsed = new URL(url);
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname) return url;
    if (!image && ['mailto:', 'tel:'].includes(parsed.protocol)) return url;
  } catch {
    /* Relative/malformed links have no merchant base URL to resolve against. */
  }
  return undefined;
}

function sanitize(nodes: HtmlNode[], preformatted = false): DescriptionNode[] {
  return nodes.flatMap((node): DescriptionNode[] => {
    if ('value' in node)
      return [preformatted ? node.value : node.value.replace(/[\t\r\n ]+/g, ' ')];
    if (!('tagName' in node) || discarded.has(node.tagName)) return [];
    const children = sanitize(node.childNodes, preformatted || node.tagName === 'pre').filter(
      (child) =>
        !['table', 'thead', 'tbody', 'tfoot', 'tr'].includes(node.tagName) ||
        typeof child !== 'string' ||
        Boolean(child.trim()),
    );
    const attributes = Object.fromEntries(
      node.attrs.map((attribute) => [attribute.name, attribute.value]),
    );
    if (!tags.has(node.tagName)) return children;
    const result: Exclude<DescriptionNode, string> = { tag: node.tagName, children };
    if (node.tagName === 'a') result.href = descriptionUrl(attributes.href);
    if (node.tagName === 'img') {
      result.src = descriptionUrl(attributes.src, true);
      result.alt = attributes.alt ?? '';
      if (!result.src) return result.alt ? [result.alt] : [];
    }
    for (const [attribute, property] of [
      ['start', 'start'],
      ['colspan', 'colSpan'],
      ['rowspan', 'rowSpan'],
    ] as const) {
      const value = Number(attributes[attribute]);
      if (Number.isSafeInteger(value) && value > 0) result[property] = value;
    }
    return [result];
  });
}

function previewContent(nodes: DescriptionNode[]): DescriptionNode[] {
  return nodes.flatMap((node): DescriptionNode[] => {
    if (typeof node === 'string') return [node.replace(/\u00a0/g, ' ')];
    const children = previewContent(node.children);
    if (node.tag === 'p' || /^h[1-6]$/.test(node.tag)) {
      if (
        children.every((child) => (typeof child === 'string' ? !child.trim() : child.tag === 'br'))
      )
        return [];
      return [...children, { tag: 'br', children: [] }];
    }
    return previewTags.has(node.tag) ? [{ tag: node.tag, children }] : children;
  });
}

function trimPreview(nodes: DescriptionNode[]): DescriptionNode[] {
  const result: DescriptionNode[] = [];
  let breaks = 0;
  for (const node of nodes) {
    if (typeof node === 'string' && !node.trim()) {
      if (!breaks && result.length) result.push(node);
    } else if (typeof node !== 'string' && node.tag === 'br') {
      if (result.length && breaks++ < 2) result.push(node);
    } else {
      breaks = 0;
      result.push(node);
    }
  }
  while (
    result.length &&
    (typeof result.at(-1) === 'string'
      ? !(result.at(-1) as string).trim()
      : (result.at(-1) as Exclude<DescriptionNode, string>).tag === 'br')
  )
    result.pop();
  return result;
}

function truncate(nodes: DescriptionNode[], limit: number) {
  let remaining = limit;
  let truncated = false;
  function visit(items: DescriptionNode[]): DescriptionNode[] {
    const result: DescriptionNode[] = [];
    for (const node of items) {
      if (typeof node === 'string') {
        const characters = Array.from(node);
        if (characters.length > remaining) {
          result.push(characters.slice(0, remaining).join('').trimEnd());
          truncated = true;
          remaining = 0;
          break;
        }
        result.push(node);
        remaining -= characters.length;
      } else {
        const children = visit(node.children);
        result.push({ ...node, children });
        if (truncated) break;
      }
    }
    return result;
  }
  const preview = visit(nodes);
  return { preview, truncated };
}

/** Connectors already supply HTML; manual listings can still contain plain text.
 * Parse it once without evaluating HTML. Keep author text and safe structure,
 * and count decoded Unicode characters rather than tags/entities in the preview.
 * Shop's public products._id-C9bdQUwv.js defines the preview tag/paragraph recipe. */
export function prepareProductDescription(description: string, limit = 340) {
  const document = parseFragment(description);
  const pending = [...document.childNodes];
  let html = false;
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) {
      if (tags.has(node.tagName) || discarded.has(node.tagName)) {
        html = true;
        break;
      }
      pending.push(...node.childNodes);
    }
  }
  const full: DescriptionNode[] = html ? sanitize(document.childNodes) : [description];
  const { preview, truncated } = truncate(html ? trimPreview(previewContent(full)) : full, limit);
  return { html, full, preview, truncated };
}
