// What the host owes this layer beside bmo-ui's own (`docs/layout.md`, 「The console plugin bundle」): the
// components the gate trial page stands on that the console registers itself. They are declared here by the props
// the page hands them, so the typecheck holds the page to what it may ask of the host; the host's own components
// answer them at build, under its own types.
import type { DefineComponent } from "vue";

// The pieces of the console's own title bar.
type TitleBarPiece = DefineComponent<Record<string, never>>;

// The console's markdown text, an answer drawn as the console draws every model's words.
type MarkdownText = DefineComponent<{ text: string }>;

// The gate's row of the agents screen's gate table, in a dialog.
type GateSettingsDialog = DefineComponent<{
  open: boolean;
  gate: string;
  "onUpdate:open"?: (open: boolean) => void;
}>;

declare module "vue" {
  interface GlobalComponents {
    DeployMark: TitleBarPiece;
    TodoOpenButton: TitleBarPiece;
    UsageMeters: TitleBarPiece;
    MarkdownText: MarkdownText;
    GateSettingsDialog: GateSettingsDialog;
  }
}

export {};
