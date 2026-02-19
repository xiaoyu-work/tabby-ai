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
    /** Token usage data from the API */
    Usage = 'usage',
    /** Retrying after a transient error — maps to gemini-cli's StreamEventType.RETRY */
    Retry = 'retry',
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

/**
 * Token usage summary — maps to gemini-cli's TokensSummary
 * (packages/core/src/services/chatRecordingService.ts)
 */
export interface TokensSummary {
    promptTokens: number       // prompt_tokens / promptTokenCount
    completionTokens: number   // completion_tokens / candidatesTokenCount
    cachedTokens: number       // prompt_tokens_details.cached_tokens / cachedContentTokenCount
    totalTokens: number        // total_tokens / totalTokenCount
}
