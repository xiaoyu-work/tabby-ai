import { ConfigProvider } from 'tabby-core'

export class AIConfigProvider extends ConfigProvider {
    defaults = {
        ai: {
            provider: 'gemini',
            apiKey: '',
            model: 'gemini-2.0-flash',
            maxContextLines: 100,
        },
    }

    platformDefaults = {}
}
