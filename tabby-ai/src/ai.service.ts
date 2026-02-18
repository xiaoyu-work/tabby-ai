import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

/**
 * OpenAI-compatible chat completion request/response types.
 * Works with: OpenAI, Gemini, Ollama, DeepSeek, Azure OpenAI, Groq,
 * LiteLLM Proxy, and any OpenAI-compatible endpoint.
 */

interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

interface ChatCompletionResponse {
    choices?: {
        message?: {
            content?: string
        }
    }[]
    error?: { message: string }
}

/**
 * Preset provider configurations.
 * Users can also set a fully custom baseUrl.
 */
const PROVIDER_PRESETS: Record<string, { baseUrl: string; defaultModel: string }> = {
    openai: {
        baseUrl: 'https://api.openai.com/v1/',
        defaultModel: 'gpt-4o-mini',
    },
    gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-2.0-flash',
    },
    ollama: {
        baseUrl: 'http://localhost:11434/v1/',
        defaultModel: 'llama3.2',
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com/v1/',
        defaultModel: 'deepseek-chat',
    },
    azure: {
        baseUrl: '', // user must set their own
        defaultModel: 'gpt-4o-mini',
    },
    custom: {
        baseUrl: '', // user must set their own
        defaultModel: '',
    },
}

@Injectable()
export class AIService {
    constructor (
        private config: ConfigService,
    ) {}

    /**
     * Send a query to the configured LLM via OpenAI-compatible API.
     */
    async query (userQuery: string, terminalContext: string): Promise<string> {
        const aiConfig = this.config.store.ai
        const provider = aiConfig?.provider || 'gemini'
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom

        // Resolve baseUrl: explicit config > preset
        let baseUrl = (aiConfig?.baseUrl || preset.baseUrl || '').replace(/\/+$/, '')
        if (!baseUrl) {
            return `Error: No API base URL configured for provider "${provider}". Go to Settings → AI.`
        }

        const apiKey = aiConfig?.apiKey || ''
        const model = aiConfig?.model || preset.defaultModel

        // Ollama doesn't require an API key
        if (!apiKey && provider !== 'ollama') {
            return `Error: No API key configured. Go to Settings → AI to set your API key.`
        }

        const url = `${baseUrl}/chat/completions`

        const systemPrompt = [
            'You are a terminal AI assistant embedded in the Tabby terminal.',
            'The user is working in a terminal and needs help.',
            'Use the terminal context below to understand their current situation.',
            'Give concise, actionable answers. Prefer showing commands the user can run.',
            'When suggesting commands, format them in code blocks.',
            '',
            terminalContext,
        ].join('\n')

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userQuery },
        ]

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
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

            const text = data.choices?.[0]?.message?.content
            return text || 'No response from AI.'
        } catch (err: any) {
            return `Request failed: ${err.message}`
        }
    }
}
