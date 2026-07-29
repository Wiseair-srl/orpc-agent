import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { RiskLevel, SideEffect } from "@orpc-agent/core";

/**
 * Shared presentation for the interactive surface. Nothing here is imported
 * by `check`: the CI path stays on plain writes with no rendering framework
 * (ADR-015 §7), and every view below has a plain-text equivalent in render.ts
 * that stays the tested fallback.
 */

export const RISK_COLOR: Record<RiskLevel, string> = {
  low: "green",
  medium: "yellow",
  high: "red",
  critical: "magenta",
};

export const SIDE_EFFECT_COLOR: Record<SideEffect, string> = {
  none: "gray",
  read: "cyan",
  write: "yellow",
  destructive: "red",
  external: "magenta",
};

export function Badge({ label, color }: { label: string; color: string }) {
  return <Text color={color}>{label}</Text>;
}

/** Section heading with a rule, so blocks stay findable in a long scroll. */
export function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Box marginTop={1}>
      <Text bold>{children}</Text>
    </Box>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Inline rather than `ink-spinner`: this package keeps its optional install
 * surface to ink + react, and a spinner is ten lines.
 */
export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
      <Text color="cyan">{FRAMES[frame]}</Text> {label}
    </Text>
  );
}

/** A bordered callout. `tone` drives the border colour, not an icon soup. */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: "warn" | "info" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const color = tone === "danger" ? "red" : tone === "warn" ? "yellow" : "cyan";
  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" paddingX={1} marginTop={1}>
      <Text bold color={color}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
