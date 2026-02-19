/**
 * Stream event types for AI agent communication.
 * Mirrors gemini-cli's GeminiEventType (packages/core/src/core/turn.ts).
 */

export const enum EventType {
    /** AI text output (streamed chunk) */
    Content = 'content',
    /** AI thinking/reasoning (if model supports it) */
    Thought = 'thought',
    /** AI requests tool execution */
    ToolCall = 'tool_call',
    /** API or network error */
    Error = 'error',
    /** Stream finished */
    Finished = 'finished',
}

export interface StreamEvent {
    type: EventType
    value: any
}

export interface ToolCallRequest {
    id: string
    function: {
        name: string
        arguments: string
    }
}
