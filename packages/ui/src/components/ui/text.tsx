import * as React from "react";
import { Text as RNText, type TextProps as RNTextProps } from "react-native";
import { cn } from "../../lib/cn";

export type TextProps = RNTextProps & {
  className?: string;
};

const Text = React.forwardRef<RNText, TextProps>(
  ({ className, ...props }, ref) => {
    return (
      <RNText
        className={cn(
          "text-base text-foreground web:select-text font-sans",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Text.displayName = "Text";

export { Text };
