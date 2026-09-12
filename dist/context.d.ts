/**
 * Per-prompt context note injected on the host `context` event.
 *
 * Mirrors the omp-peers pattern: append a concise note to the last user
 * message, preserving provider role alternation. The note reminds the agent
 * to use the ff tools instead of shell find/ls/grep/rg/ctags.
 */
export interface ContextMessage {
    role: string;
    content: string | Array<{
        type: string;
        text?: string;
    }>;
}
/** Concise per-prompt note listing the omp-find tool surface. */
export declare function buildFindToolsNote(): string;
/**
 * Fold `note` into the last user message (string content is suffixed, array
 * content is pushed) or append a fresh user message when none exists.
 * Mutates `messages` in place and returns it.
 */
export declare function appendNoteToMessages(messages: ContextMessage[], note: string): ContextMessage[];
