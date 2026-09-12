/**
 * Per-prompt context note injected on the host `context` event.
 *
 * Mirrors the omp-peers pattern: append a concise note to the last user
 * message, preserving provider role alternation. The note reminds the agent
 * to use the ff tools instead of shell find/ls/grep/rg/ctags.
 */

export interface ContextMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

/** Concise per-prompt note listing the omp-find tool surface. */
export function buildFindToolsNote(): string {
  return [
    "<find-tools>",
    "Use the ff tools instead of shell find/ls/grep/rg/ctags: fffind for files, ffgrep for content, ffoutline for file shape, ffcallers for callers, ffstructural for AST-ish patterns, ffmap for repo overview, ffcapsule for one symbol. Results are approximate — verify with read.",
    "</find-tools>",
  ].join("\n");
}

/**
 * Fold `note` into the last user message (string content is suffixed, array
 * content is pushed) or append a fresh user message when none exists.
 * Mutates `messages` in place and returns it.
 */
export function appendNoteToMessages(messages: ContextMessage[], note: string): ContextMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = `${message.content}\n\n${note}`;
      return messages;
    }
    if (Array.isArray(message.content)) {
      message.content.push({ type: "text", text: note });
      return messages;
    }
  }
  messages.push({ role: "user", content: note });
  return messages;
}
