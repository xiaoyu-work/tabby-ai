import { ConfigProvider } from 'tabby-core'

export class AIConfigProvider extends ConfigProvider {
    defaults = {
        ai: {
            /**
             * Provider preset: openai, gemini, ollama, deepseek, azure, custom
             * Each preset fills in a default baseUrl and model.
             * You can override baseUrl and model regardless of provider.
             */
            provider: 'gemini',

            /**
             * API base URL (OpenAI-compatible).
             * Leave empty to use the provider preset's default URL.
             *
             * Examples:
             *   OpenAI:    https://api.openai.com/v1/
             *   Gemini:    https://generativelanguage.googleapis.com/v1beta/openai/
             *   Ollama:    http://localhost:11434/v1/
             *   DeepSeek:  https://api.deepseek.com/v1/
             *   Azure:     https://{resource}.openai.azure.com/openai/
             *   LiteLLM:   http://localhost:4000/v1/
             */
            baseUrl: '',

            /** API key (not needed for Ollama) */
            apiKey: '',

            /** Model name */
            model: 'gemini-2.0-flash',

            /** Azure deployment name (only used when provider is 'azure') */
            deployment: '',

            /** Azure API version (only used when provider is 'azure') */
            apiVersion: '2024-12-01-preview',

            /** Max lines of terminal output to include as context */
            maxContextLines: 100,

            /**
             * Historical token usage per provider.
             * Persisted across app restarts.
             * Each key must be pre-declared so ConfigProxy creates property descriptors.
             * Value is null (no data) or { promptTokens, completionTokens, totalTokens, requestCount }.
             */
            tokenUsage: {
                openai: null as any,
                gemini: null as any,
                ollama: null as any,
                deepseek: null as any,
                azure: null as any,
                custom: null as any,
            },
        },
    }

    platformDefaults = {}
}
