import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { EventType, StreamEvent, ToolCallRequest } from './streamEvents'
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
     * Streaming chat completion with tool calling support.
     * Returns an AsyncGenerator<StreamEvent>.
     *
     * Mirrors gemini-cli's GeminiChat.sendMessageStream() → Turn.run()
     * (packages/core/src/core/geminiChat.ts)
     *
     * Uses OpenAI-compatible SSE streaming with tools parameter.
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
                    max_tokens: 4096,
                    temperature: 0.7,
                }),
            })
        } catch (err: any) {
            yield { type: EventType.Error, value: `Request failed: ${err.message}` }
            return
        }

        if (!response.ok) {
            const text = await response.text()
            yield { type: EventType.Error, value: `API error (${response.status}) [${cfg.url}]: ${text}` }
            return
        }

        // Parse SSE stream
        // Mirrors gemini-cli's processStreamResponse() in geminiChat.ts
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
                        // Yield accumulated tool calls (same as gemini-cli collecting
                        // ToolCallRequestInfo then scheduling after stream ends)
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

                    const choice = chunk.choices?.[0]
                    const delta = choice?.delta

                    if (!delta) continue

                    // Text content chunk
                    if (delta.content) {
                        yield { type: EventType.Content, value: delta.content }
                    }

                    // Tool call fragments — accumulate and splice
                    // OpenAI streams tool_calls in fragments across multiple chunks
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

        // If stream ended without [DONE], still yield accumulated tool calls
        for (const tc of pendingToolCalls.values()) {
            yield { type: EventType.ToolCall, value: tc }
        }
        yield { type: EventType.Finished, value: null }
    }
}
