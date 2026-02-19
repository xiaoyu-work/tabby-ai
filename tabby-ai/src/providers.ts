/**
 * Shared provider preset configurations.
 * Used by both AIService (runtime) and AISettingsTabComponent (UI).
 */
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; defaultModel: string }> = {
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
        baseUrl: '',
        defaultModel: 'gpt-4o-mini',
    },
    custom: {
        baseUrl: '',
        defaultModel: '',
    },
}
