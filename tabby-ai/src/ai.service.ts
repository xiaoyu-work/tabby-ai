import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

interface GeminiContent {
    parts: { text: string }[]
    role: string
}

interface GeminiResponse {
    candidates?: {
        content?: {
            parts?: { text: string }[]
        }
    }[]
    error?: { message: string }
}

@Injectable()
export class AIService {
    constructor (
        private config: ConfigService,
    ) {}

    /**
     * Send a query to the configured LLM and return the response.
     */
    async query (userQuery: string, terminalContext: string): Promise<string> {
        const apiKey = this.config.store.ai?.apiKey
        if (!apiKey) {
            return 'Error: No API key configured. Go to Settings → AI to set your Gemini API key.'
        }

        const model = this.config.store.ai?.model || 'gemini-2.0-flash'
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

        const systemPrompt = [
            'You are a terminal AI assistant embedded in the Tabby terminal.',
            'The user is working in a terminal and needs help.',
            'Use the terminal context below to understand their current situation.',
            'Give concise, actionable answers. Prefer showing commands the user can run.',
            'When suggesting commands, format them in code blocks.',
            '',
            terminalContext,
        ].join('\n')

        const contents: GeminiContent[] = [
            {
                role: 'user',
                parts: [{ text: `${systemPrompt}\n\n---\n\nUser question: ${userQuery}` }],
            },
        ]

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    generationConfig: {
                        maxOutputTokens: 2048,
                        temperature: 0.7,
                    },
                }),
            })

            if (!response.ok) {
                const text = await response.text()
                return `API error (${response.status}): ${text}`
            }

            const data: GeminiResponse = await response.json()

            if (data.error) {
                return `API error: ${data.error.message}`
            }

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text
            return text || 'No response from AI.'
        } catch (err: any) {
            return `Request failed: ${err.message}`
        }
    }
}
