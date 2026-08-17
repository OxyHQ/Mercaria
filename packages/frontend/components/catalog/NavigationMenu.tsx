import { Fragment } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@mercaria/ui';
import type { CatalogMenuEntry, CatalogNavigationTree } from '@/lib/catalog/navigation';

/**
 * A published navigation tree, rendered (#367 workstream 1 §"Taxonomy versus
 * presentation", workstream 9 §"Categories and navigation").
 *
 * Every label, every ordering and every destination arrived from the server.
 * This component decides three things and no others: that a node with a
 * destination is a link, that a node without one is a heading, and that a
 * campaign leaves the app through `Linking` rather than through the router.
 *
 * ## A node whose label came from a fallback locale says so
 *
 * `fallbackLocale` is set when the tree's own locale had no translation and
 * ADR 0007 D4's chain answered from another one. It is announced to a screen
 * reader rather than badged: a superscript nobody can hear is not a disclosure,
 * and the fact belongs to the label rather than beside it.
 *
 * ## Depth is not a design decision here
 *
 * The server bounds it (`NAVIGATION_MAX_DEPTH`) and this renders whatever
 * arrives, indented by nesting rather than by a per-level style table — a
 * per-level table is a second, silent bound that disagrees with the real one.
 */

export interface NavigationMenuProps {
  tree: CatalogNavigationTree;
  /** Announced as the group's name. The tree carries no title of its own. */
  accessibilityLabel: string;
}

export function NavigationMenu({ tree, accessibilityLabel }: NavigationMenuProps) {
  if (tree.entries.length === 0) return null;
  return (
    <View className="gap-space-16" accessibilityRole="menu" accessibilityLabel={accessibilityLabel}>
      {tree.entries.map((entry) => (
        <NavigationBranch key={entry.key} entry={entry} depth={0} />
      ))}
    </View>
  );
}

/** Indentation per level, in Tailwind's logical inline-start scale. */
const INDENT_BY_DEPTH = ['ps-0', 'ps-space-16', 'ps-space-32', 'ps-space-48'] as const;

function indentFor(depth: number): string {
  return INDENT_BY_DEPTH[Math.min(depth, INDENT_BY_DEPTH.length - 1)];
}

function NavigationBranch({ entry, depth }: { entry: CatalogMenuEntry; depth: number }) {
  return (
    <Fragment>
      <View className={indentFor(depth)}>
        <NavigationEntry entry={entry} isRoot={depth === 0} />
      </View>
      {entry.children.map((child) => (
        <NavigationBranch key={child.key} entry={child} depth={depth + 1} />
      ))}
    </Fragment>
  );
}

function NavigationEntry({ entry, isRoot }: { entry: CatalogMenuEntry; isRoot: boolean }) {
  const router = useRouter();
  const textClass = isRoot ? 'text-captionBold text-text' : 'text-body text-text-secondary';

  // A node whose target kind the storefront has no screen for. It keeps its
  // label and its children and gets no press handler at all — the discriminated
  // shape `NAV_ITEMS` uses, for the same reason.
  if (entry.href === undefined && entry.externalUrl === undefined) {
    return (
      <Text className={textClass} accessibilityRole="header">
        {entry.label}
      </Text>
    );
  }

  const label = accessibleLabel(entry);

  if (entry.externalUrl !== undefined) {
    const externalUrl = entry.externalUrl;
    return (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={label}
        accessibilityHint={entry.description}
        onPress={() => {
          void Linking.openURL(externalUrl);
        }}
      >
        <Text className={textClass}>{entry.label}</Text>
      </Pressable>
    );
  }

  const href = entry.href;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={entry.description}
      onPress={() => {
        if (href !== undefined) router.push(href);
      }}
    >
      <Text className={textClass}>{entry.label}</Text>
    </Pressable>
  );
}

/**
 * What a screen reader announces.
 *
 * The author's own `accessibilityLabel` wins when they wrote one, because they
 * are describing the destination and the visible label may be an abbreviation.
 */
function accessibleLabel(entry: CatalogMenuEntry): string {
  return entry.accessibilityLabel ?? entry.label;
}
