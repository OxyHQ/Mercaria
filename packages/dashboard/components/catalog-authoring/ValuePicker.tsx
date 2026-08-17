import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Check, ChevronDown, Search } from "lucide-react-native";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Text,
  useColorScheme,
} from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * One selectable option: a STABLE id and a display label that came from the
 * server's localized text.
 *
 * The two are separate properties and the id is what leaves this component,
 * which is ADR 0007 D1 held by the callback signature — `onSelect` takes an id
 * and there is no overload that takes a label.
 */
export interface PickerOption<Id extends string = string> {
  /** The STABLE id. Generic so a caller with a narrower id keeps it — a currency
   *  picker hands back a `CurrencyCode`, not a string somebody has to assert. */
  readonly id: Id;
  /** What the author reads. Never sent anywhere. */
  readonly label: string;
  /** A second line — an identifier, a canonical value string, a brand. */
  readonly detail?: string;
}

interface ValuePickerProps<Id extends string> {
  readonly options: readonly PickerOption<Id>[];
  readonly selectedId: Id | null;
  readonly onSelect: (id: Id) => void;
  /** Shown on the trigger when nothing is chosen. */
  readonly placeholder: string;
  /** The dialog's heading — the field's own label. */
  readonly title: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
}

/** Above this many options the dialog offers a filter box. */
const FILTER_THRESHOLD = 8;

/**
 * A searchable single-select over a controlled value set.
 *
 * A dialog rather than an inline listbox because a controlled set can be two
 * options or two hundred and the same control has to work for both, on a phone
 * and on a desktop. The filter appears only past {@link FILTER_THRESHOLD}: a
 * search box over five values is a control somebody has to skip past.
 *
 * Nothing here knows what the options MEAN. It is handed a list and hands back
 * an id.
 */
export function ValuePicker<Id extends string>({
  options,
  selectedId,
  onSelect,
  placeholder,
  title,
  disabled = false,
  invalid = false,
}: ValuePickerProps<Id>) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((option) => option.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.detail ?? "").toLowerCase().includes(needle),
    );
  }, [options, query]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={selected === null ? placeholder : selected.label}
        aria-expanded={open}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={[
          "h-11 flex-row items-center justify-between rounded-xl border bg-background px-3.5",
          invalid ? "border-destructive" : "border-input",
          disabled ? "opacity-50" : "active:opacity-70",
        ].join(" ")}
      >
        <Text
          className={
            selected === null ? "text-base text-muted-foreground" : "text-base text-foreground"
          }
          numberOfLines={1}
        >
          {selected === null ? placeholder : selected.label}
        </Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </Pressable>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {options.length > FILTER_THRESHOLD ? (
            <View className="mb-3 flex-row items-center gap-2 rounded-xl border border-input px-3">
              <Search size={16} color={colors.mutedForeground} />
              <Input
                value={query}
                onChangeText={setQuery}
                placeholder={t("products.wizard.values.filterPlaceholder")}
                accessibilityLabel={t("products.wizard.values.filterPlaceholder")}
                className="flex-1 border-0"
              />
            </View>
          ) : null}
          <ScrollView className="max-h-80">
            <View className="gap-1">
              {filtered.map((option) => {
                const isSelected = option.id === selectedId;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      onSelect(option.id);
                      setOpen(false);
                    }}
                    className="flex-row items-center justify-between rounded-xl px-3 py-3 active:bg-muted"
                  >
                    <View className="flex-1 pe-3">
                      <Text className="text-base text-foreground">{option.label}</Text>
                      {option.detail === undefined ? null : (
                        <Text className="text-xs text-muted-foreground">{option.detail}</Text>
                      )}
                    </View>
                    {isSelected ? <Check size={16} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
              {filtered.length === 0 ? (
                <Text className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t("products.wizard.values.noMatches")}
                </Text>
              ) : null}
            </View>
          </ScrollView>
          <Button variant="outline" className="mt-3" onPress={() => setOpen(false)}>
            <Text className="font-medium text-foreground">{t("common.cancel")}</Text>
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
