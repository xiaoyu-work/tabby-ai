import { Component, HostBinding } from '@angular/core'
import { ConfigService } from 'tabby-core'

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash' },
    ollama: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1/', model: 'deepseek-chat' },
    azure: { baseUrl: '', model: 'gpt-4o-mini' },
    custom: { baseUrl: '', model: '' },
}

@Component({
    templateUrl: './aiSettingsTab.component.pug',
})
export class AISettingsTabComponent {
    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
    ) {}

    onProviderChange (): void {
        const provider = this.config.store.ai.provider
        const defaults = PROVIDER_DEFAULTS[provider]
        if (defaults) {
            // Clear baseUrl so the preset is used, update model to the preset default
            this.config.store.ai.baseUrl = ''
            this.config.store.ai.model = defaults.model
        }
    }

    getBaseUrlPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_DEFAULTS[provider]?.baseUrl || 'https://your-endpoint.com/v1/'
    }

    getModelPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_DEFAULTS[provider]?.model || 'model-name'
    }
}
