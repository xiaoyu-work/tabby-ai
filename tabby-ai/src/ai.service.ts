import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { EventType, StreamEvent, ToolCallRequest, TokensSummary } from './streamEvents'
import { PROVIDER_PRESETS } from './providers'

/**
 * OpenAI-compatible chat completion request/response types.
 * Works with: OpenAI, Gemini, Ollama, DeepSeek, Azure OpenAI, Groq,
 * LiteLLM Proxy, and any OpenAI-compatible endpoint.
 */

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: any[]
    tool_call_id?: string
}

export interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: any
    }
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string
        }
    }[]
    error?: { message: string }
}

@Injectable()
export class AIService {
    constructor (
        private config: ConfigService,
    ) {}

    /** Resolve API config from settings */
    private resolveConfig (): { url: string; headers: Record<string, string>; model: string; error?: string } {
        const aiConfig = this.config.store.ai
        const provider = aiConfig?.provider || 'gemini'
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom

        let baseUrl = (aiConfig?.baseUrl || preset.baseUrl || '').replace(/\/+$/, '')
        if (!baseUrl) {
            return { url: '', headers: {}, model: '', error: `No API base URL configured for provider "${provider}". Go to Settings → AI.` }
        }

        const apiKey = aiConfig?.apiKey || ''
        const model = aiConfig?.model || preset.defaultModel

        if (!apiKey && provider !== 'ollama') {
            return { url: '', headers: {}, model: '', error: 'No API key configured. Go to Settings → AI to set your API key.' }
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' }

        if (provider === 'azure') {
            // Azure OpenAI: api-key header, api-version query param
            // baseUrl = endpoint e.g. https://xxx.cognitiveservices.azure.com
            // deployment = deployment name e.g. gpt-4.1
            headers['api-key'] = apiKey
            const deployment = aiConfig?.deployment || model
            const apiVersion = aiConfig?.apiVersion || '2024-12-01-preview'
            const url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`
            return { url, headers, model }
        }

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`
        }

        const endpoint = baseUrl.includes('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
        return { url: endpoint, headers, model }
    }

    /**
     * Send a simple query to the configured LLM (non-streaming).
     */
    async query (userQuery: string, terminalContext: string): Promise<string> {
        const cfg = this.resolveConfig()
        if (cfg.error) {
            return `Error: ${cfg.error}`
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: terminalContext },
            { role: 'user', content: userQuery },
        ]

        try {
            const response = await fetch(cfg.url, {
                method: 'POST',
                headers: cfg.headers,
                body: JSON.stringify({
                    model: cfg.model,
                    messages,
                    max_tokens: 2048,
                    temperature: 0.7,
                }),
            })

            if (!response.ok) {
                const text = await response.text()
                return `API error (${response.status}): ${text}`
            }

            const data: ChatCompletionResponse = await response.json()
            if (data.error) {
                return `API error: ${data.error.message}`
            }

            return data.choices?.[0]?.message?.content || 'No response from AI.'
        } catch (err: any) {
            return `Request failed: ${err.message}`
        }
    }

    /**
     * Retry configuration — maps to gemini-cli's INVALID_CONTENT_RETRY_OPTIONS
     * (packages/core/src/core/geminiChat.ts:88-91)
     */
    private static readonly RETRY_OPTIONS = {
        maxAttempts: 3,       // gemini-cli uses 2 for content, 3 for network
        initialDelayMs: 500,  // gemini-cli: 500ms
    }

    /**
     * Network error codes that are safe to retry — maps to gemini-cli's
     * RETRYABLE_NETWORK_CODES (packages/core/src/utils/retry.ts:50-63)
     */
    private static readonly RETRYABLE_NETWORK_CODES = new Set([
        'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND',
        'EAI_AGAIN', 'ECONNREFUSED', 'EPROTO',
        'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
        'ERR_SSL_WRONG_VERSION_NUMBER',
        'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
        'ERR_SSL_BAD_RECORD_MAC',
    ])

    /**
     * Determine if an error is retryable — maps to gemini-cli's
     * isRetryableError() (packages/core/src/utils/retry.ts:112-143)
     *
     * Retries on: network error codes, 429 (rate limit), 5xx (server errors).
     * Does NOT retry: 400 (bad request), 401/403 (auth), 404 (not found).
     */
    private isRetryableError (err: any): boolean {
        // Check network error codes (traverse cause chain like gemini-cli)
        let current = err
        for (let depth = 0; depth < 5; depth++) {
            if (current?.code && AIService.RETRYABLE_NETWORK_CODES.has(current.code)) {
                return true
            }
            if (!current?.cause) break
            current = current.cause
        }
        // Check "fetch failed" message
        if (err?.message?.toLowerCase().includes('fetch failed')) {
            return true
        }
        return false
    }

    /**
     * Determine if an HTTP status is retryable — 429 or 5xx
     */
    private isRetryableStatus (status: number): boolean {
        return status === 429 || (status >= 500 && status < 600)
    }

    /**
     * Streaming chat completion with tool calling and retry support.
     * Returns an AsyncGenerator<StreamEvent>.
     *
     * Mirrors gemini-cli's GeminiChat.sendMessageStream() with
     * streamWithRetries() (packages/core/src/core/geminiChat.ts:340-463)
     *
     * Retry logic:
     * - Network errors: retry with linear backoff (delayMs * attempt)
     * - HTTP 429/5xx: retry with linear backoff
     * - HTTP 400/401/403/404: no retry (permanent errors)
     * - AbortError: no retry
     */
    async *streamWithTools (
        messages: ChatMessage[],
        tools: ToolDefinition[],
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
        const cfg = this.resolveConfig()
        if (cfg.error) {
            yield { type: EventType.Error, value: cfg.error }
            return
        }

        const { maxAttempts, initialDelayMs } = AIService.RETRY_OPTIONS
        let lastError: string | null = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (signal?.aborted) break

            // Yield retry event for UI feedback (maps to gemini-cli's StreamEventType.RETRY)
            if (attempt > 0) {
                yield { type: EventType.Retry, value: { attempt, maxAttempts } }
            }

            // === Connection phase (fetch) ===
            let response: Response
            try {
                response = await fetch(cfg.url, {
                    method: 'POST',
                    headers: cfg.headers,
                    signal,
                    body: JSON.stringify({
                        model: cfg.model,
                        messages,
                        tools,
                        stream: true,
                        stream_options: { include_usage: true },
                        max_tokens: 4096,
                        temperature: 0.7,
                    }),
                })
            } catch (err: any) {
                if (err.name === 'AbortError' || signal?.aborted) {
                    yield { type: EventType.Error, value: 'Request aborted' }
                    return
                }
                // Network error — check if retryable
                if (this.isRetryableError(err) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = `Network error: ${err.message}`
                    continue
                }
                yield { type: EventType.Error, value: `Request failed: ${err.message}` }
                return
            }

            // HTTP error — check if retryable status
            if (!response.ok) {
                const text = await response.text()
                if (this.isRetryableStatus(response.status) && attempt < maxAttempts - 1) {
                    const delayMs = initialDelayMs * (attempt + 1)
                    await new Promise(res => setTimeout(res, delayMs))
                    lastError = `API error (${response.status}): ${text}`
                    continue
                }
                yield { type: EventType.Error, value: `API error (${response.status}) [${cfg.url}]: ${text}` }
                return
            }

            // === Stream phase (SSE parsing) ===
            yield* this.parseSSEStream(response, signal)
            return
        }

        // All retries exhausted
        yield { type: EventType.Error, value: lastError || 'Request failed after all retries' }
    }

    /**
     * Parse an SSE stream response into StreamEvents.
     * Extracted from streamWithTools for retry clarity.
     */
    private async *parseSSEStream (
        response: Response,
        signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent> {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let sseBuffer = ''
        const pendingToolCalls: Map<number, ToolCallRequest> = new Map()

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                sseBuffer += decoder.decode(value, { stream: true })

                const lines = sseBuffer.split('\n')
                sseBuffer = lines.pop() || ''

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed.startsWith('data: ')) {
                        continue
                    }
                    const data = trimmed.slice(6).trim()

                    if (data === '[DONE]') {
                        for (const tc of pendingToolCalls.values()) {
                            yield { type: EventType.ToolCall, value: tc }
                        }
                        yield { type: EventType.Finished, value: null }
                        return
                    }

                    let chunk: any
                    try {
                        chunk = JSON.parse(data)
                    } catch {
                        continue
                    }

                    // Usage data (maps to gemini-cli's chunk.usageMetadata)
                    if (chunk.usage) {
                        const usage: TokensSummary = {
                            promptTokens: chunk.usage.prompt_tokens ?? 0,
                            completionTokens: chunk.usage.completion_tokens ?? 0,
                            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                            totalTokens: chunk.usage.total_tokens ?? 0,
                        }
                        yield { type: EventType.Usage, value: usage }
                    }

                    // API-level error in chunk (non-SSE error response)
                    if (chunk.error) {
                        yield { type: EventType.Error, value: `API error: ${chunk.error.message || JSON.stringify(chunk.error)}` }
                        return
                    }

                    const choice = chunk.choices?.[0]
                    const delta = choice?.delta

                    if (!delta) continue

                    // Text content chunk
                    if (delta.content) {
                        yield { type: EventType.Content, value: delta.content }
                    }

                    // Tool call fragments — accumulate and splice
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0
                            if (!pendingToolCalls.has(idx)) {
                                pendingToolCalls.set(idx, {
                                    id: tc.id || '',
                                    function: { name: '', arguments: '' },
                                })
                            }
                            const pending = pendingToolCalls.get(idx)!
                            if (tc.id) {
                                pending.id = tc.id
                            }
                            if (tc.function?.name) {
                                pending.function.name += tc.function.name
                            }
                            if (tc.function?.arguments) {
                                pending.function.arguments += tc.function.arguments
                            }
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }

        // Stream ended without [DONE] — still yield accumulated tool calls
        for (const tc of pendingToolCalls.values()) {
            yield { type: EventType.ToolCall, value: tc }
        }
        yield { type: EventType.Finished, value: null }
    }
}
