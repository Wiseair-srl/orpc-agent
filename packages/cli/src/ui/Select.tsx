import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type Choice<T> = {
  value: T;
  label: string;
  /** Right-hand annotation: why this option, or what it resolves to. */
  hint?: string;
  recommended?: boolean;
};

/**
 * Arrow-key list. Written here rather than pulling `ink-select-input`: the
 * optional install surface stays ink + react, and this needs a `hint` column
 * and a recommendation marker that the stock component does not have.
 */
export function Select<T>({
  choices,
  onSubmit,
}: {
  choices: Choice<T>[];
  onSubmit: (value: T) => void;
}) {
  const [index, setIndex] = useState(
    Math.max(0, choices.findIndex((choice) => choice.recommended)),
  );

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + choices.length) % choices.length);
    if (key.downArrow || input === "j") setIndex((i) => (i + 1) % choices.length);
    if (key.return) onSubmit(choices[index]!.value);
  });

  const width = Math.max(...choices.map((choice) => choice.label.length));

  return (
    <Box flexDirection="column">
      {choices.map((choice, position) => {
        const active = position === index;
        return (
          <Box key={choice.label}>
            <Text color={active ? "cyan" : undefined}>{active ? "❯ " : "  "}</Text>
            <Text color={active ? "cyan" : undefined} bold={active}>
              {choice.label.padEnd(width)}
            </Text>
            {choice.recommended && <Text color="green"> ✓ recommended</Text>}
            {choice.hint && <Text dimColor>{"  "}{choice.hint}</Text>}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>↑↓ to move · enter to select</Text>
      </Box>
    </Box>
  );
}

export function Confirm({
  label,
  defaultYes = true,
  onSubmit,
}: {
  label: string;
  defaultYes?: boolean;
  onSubmit: (value: boolean) => void;
}) {
  useInput((input, key) => {
    if (key.return) onSubmit(defaultYes);
    if (input.toLowerCase() === "y") onSubmit(true);
    if (input.toLowerCase() === "n") onSubmit(false);
  });

  return (
    <Box>
      <Text>{label} </Text>
      <Text dimColor>{defaultYes ? "(Y/n)" : "(y/N)"}</Text>
    </Box>
  );
}
