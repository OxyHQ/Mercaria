import { createElement, type ReactNode } from 'react';
import type { DescriptionNode } from '../../lib/product-description';
import type { ProductRichTextProps } from './ProductRichText';

/** No innerHTML or author props reach the DOM: only the parser's safe tree. */
export function ProductRichText({ nodes, preview = false, trailing }: ProductRichTextProps) {
  function render(items: DescriptionNode[]): ReactNode[] {
    return items.map((node, index) => {
      if (typeof node === 'string') return node;
      const element = createElement(
        node.tag === 'a' && !node.href ? 'span' : node.tag,
        {
          key: index,
          href: node.href,
          src: node.src,
          alt: node.alt,
          start: node.start,
          colSpan: node.colSpan,
          rowSpan: node.rowSpan,
          ...(node.href ? { rel: 'noopener noreferrer' } : {}),
        },
        ...render(node.children),
      );
      return node.tag === 'table' ? (
        <div key={index} className="shop-rich-table-scroll">
          {element}
        </div>
      ) : (
        element
      );
    });
  }
  return (
    <div
      className={`shop-rich-text text-shop-bodySmall text-text ${preview ? 'shop-rich-text-preview' : 'shop-rich-text-full'}`}
    >
      {render(nodes)}
      {trailing}
    </div>
  );
}
