import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { StyleSheet } from 'react-native';

/** The compact select a `SettingsRow` carries as its control. */
export function SettingsSelect<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: readonly { value: T; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const item = items.find((candidate) => candidate.value === next);
        if (item) onChange(item.value);
      }}
    >
      <SelectTrigger label={label} fieldStyle={styles.trigger}>
        <SelectValue>
          {(selected) => {
            const key =
              typeof selected === 'object' && selected !== null && 'value' in selected
                ? selected.value
                : selected;
            return items.find((item) => item.value === key)?.label ?? String(key);
          }}
        </SelectValue>
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        label={label}
        items={items}
        valueExtractor={(item) => item.value}
        renderItem={(item) => (
          <SelectItem value={item.value} label={item.label}>
            <SelectItemIndicator />
            <SelectItemText>{item.label}</SelectItemText>
          </SelectItem>
        )}
      />
    </Select>
  );
}

// Padding, never a height: a fixed height cuts a 20dp line in half on Android.
// The text sets the height.
const styles = StyleSheet.create({
  trigger: { gap: 4, paddingLeft: 8, paddingRight: 8, paddingTop: 5, paddingBottom: 5 },
});
