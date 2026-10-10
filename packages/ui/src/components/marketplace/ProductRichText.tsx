import { Fragment, useState, type ReactNode } from 'react';
import { Linking, Text as InlineText, View } from 'react-native';
import { Image } from 'expo-image';
import { Table, TableBody, TableCell, TableColumn, TableRow } from '@oxy.so/bloom/table';
import { useColorScheme } from '../../lib/useColorScheme';
import type { DescriptionNode } from '../../lib/product-description';
import { Text } from '../ui/text';

export interface ProductRichTextProps {
  nodes: DescriptionNode[];
  preview?: boolean;
  trailing?: ReactNode;
}

const inlineTags = new Set('span br strong b em i u s del sub sup a code'.split(' '));
const isInline = (node: DescriptionNode) => typeof node === 'string' || inlineTags.has(node.tag);

function DescriptionImage({ node }: { node: Exclude<DescriptionNode, string> }) {
  const [aspectRatio, setAspectRatio] = useState(1);
  return (
    <Image
      source={{ uri: node.src }}
      accessibilityLabel={node.alt}
      accessible={!!node.alt}
      style={{ width: '100%', aspectRatio }}
      contentFit="contain"
      onLoad={({ source }) => {
        if (source.width && source.height) setAspectRatio(source.width / source.height);
      }}
    />
  );
}

/** Native reading layout for the safe authored tree. Tables use Bloom's table
 * semantics/scrolling; web renders the same tree with semantic HTML elements. */
export function ProductRichText({ nodes, preview = false, trailing }: ProductRichTextProps) {
  const { colors } = useColorScheme();
  function inline(items: DescriptionNode[]): ReactNode[] {
    return items.map((node, index) => {
      if (typeof node === 'string') return node;
      if (node.tag === 'br') return '\n';
      const href = node.href;
      return (
        <InlineText
          key={index}
          selectable
          accessibilityRole={href ? 'link' : undefined}
          onPress={
            href
              ? () => {
                  void Linking.openURL(href);
                }
              : undefined
          }
          style={{
            fontWeight: ['b', 'strong'].includes(node.tag) ? '600' : undefined,
            fontStyle: ['i', 'em'].includes(node.tag) ? 'italic' : undefined,
            textDecorationLine:
              href || node.tag === 'u'
                ? 'underline'
                : ['s', 'del'].includes(node.tag)
                  ? 'line-through'
                  : undefined,
            color: href ? colors.primary : undefined,
          }}
        >
          {inline(node.children)}
        </InlineText>
      );
    });
  }
  function table(node: Exclude<DescriptionNode, string>) {
    const rows: Exclude<DescriptionNode, string>[] = [];
    function collect(items: DescriptionNode[]) {
      for (const item of items)
        if (typeof item !== 'string') {
          if (item.tag === 'tr') rows.push(item);
          else if (item.tag !== 'table') collect(item.children);
        }
    }
    collect(node.children);
    const columns = Math.max(
      1,
      ...rows.map((row) =>
        row.children.reduce(
          (count, cell) => count + (typeof cell === 'string' ? 0 : (cell.colSpan ?? 1)),
          0,
        ),
      ),
    );
    return (
      <Table
        minWidth={columns * 104}
        style={{ marginVertical: 24, borderBottomWidth: 1, borderBottomColor: colors.muted }}
      >
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow
              key={rowIndex}
              style={{
                borderBottomWidth: 0,
                borderRadius: 8,
                backgroundColor: rowIndex % 2 === 0 ? colors.muted : 'transparent',
              }}
            >
              {row.children
                .filter(
                  (cell): cell is Exclude<DescriptionNode, string> =>
                    typeof cell !== 'string' && ['td', 'th'].includes(cell.tag),
                )
                .map((cell, index) => {
                  const Cell = cell.tag === 'th' ? TableColumn : TableCell;
                  return (
                    <Cell
                      key={index}
                      flex={cell.colSpan ?? 1}
                      style={{ padding: 16, justifyContent: 'flex-start' }}
                    >
                      <View>{blocks(cell.children, cell.tag === 'th')}</View>
                    </Cell>
                  );
                })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  function blocks(items: DescriptionNode[], bold = false, suffix?: ReactNode): ReactNode[] {
    const result: ReactNode[] = [];
    let run: DescriptionNode[] = [];
    const flush = (last = false) => {
      if (run.some((node) => typeof node !== 'string' || node.trim()) || (last && suffix)) {
        result.push(
          <Text
            key={`text-${result.length}`}
            selectable
            className={`text-shop-bodySmall text-text ${bold ? 'font-shop-bodyTitleSmall' : ''}`}
          >
            {inline(run)}
            {last ? suffix : null}
          </Text>,
        );
      }
      run = [];
    };
    for (let index = 0; index < items.length; index++) {
      const node = items[index];
      if (isInline(node)) {
        run.push(node);
        continue;
      }
      flush();
      if (typeof node === 'string') continue;
      let previousIndex = index - 1;
      while (
        previousIndex >= 0 &&
        typeof items[previousIndex] === 'string' &&
        !(items[previousIndex] as string).trim()
      )
        previousIndex--;
      const previous = items[previousIndex];
      const paragraph = node.tag === 'p' || /^h[1-6]$/.test(node.tag);
      const previousParagraph =
        previous &&
        typeof previous !== 'string' &&
        (previous.tag === 'p' || /^h[1-6]$/.test(previous.tag));
      let content: ReactNode;
      if (node.tag === 'ul' || node.tag === 'ol') {
        const children = node.children.filter(
          (child): child is Exclude<DescriptionNode, string> =>
            typeof child !== 'string' && child.tag === 'li',
        );
        content = (
          <View style={{ marginVertical: 8, marginStart: 8 }}>
            {children.map((child, itemIndex) => (
              <View key={itemIndex} className="flex-row" style={{ marginStart: 8 }}>
                <Text
                  className="text-shop-bodySmall text-text"
                  style={{ minWidth: node.tag === 'ol' ? 24 : 14 }}
                >
                  {node.tag === 'ol' ? `${(node.start ?? 1) + itemIndex}.` : '•'}
                </Text>
                <View className="min-w-0 flex-1">{blocks(child.children)}</View>
              </View>
            ))}
          </View>
        );
      } else if (node.tag === 'table') content = table(node);
      else if (node.tag === 'img') content = <DescriptionImage node={node} />;
      else if (node.tag === 'hr')
        content = (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.muted, marginVertical: 8 }} />
        );
      else if (/^h[1-6]$/.test(node.tag))
        content = (
          <Text
            selectable
            accessibilityRole="header"
            className="text-shop-bodyTitleLarge text-text"
          >
            {inline(node.children)}
          </Text>
        );
      else content = <View>{blocks(node.children, bold)}</View>;
      result.push(
        <View
          key={`block-${index}`}
          style={{ marginTop: !preview && paragraph && previousParagraph ? 16 : 0 }}
        >
          {content}
        </View>,
      );
    }
    flush(true);
    return result;
  }
  return <Fragment>{blocks(nodes, false, trailing)}</Fragment>;
}
