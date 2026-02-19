import { Component, ChangeDetectorRef, HostBinding, OnInit, OnDestroy } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { PROVIDER_PRESETS } from '../providers'

/** Provider key → display label */
const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    ollama: 'Ollama',
    deepseek: 'DeepSeek',
    azure: 'Azure OpenAI',
    custom: 'Custom',
}

@Component({
    templateUrl: './aiSettingsTab.component.pug',
})
export class AISettingsTabComponent implements OnInit, OnDestroy {
    @HostBinding('class.content-box') true

    private configSub?: Subscription

    constructor (
        public config: ConfigService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        // Re-render when config changes (e.g. token usage updated from middleware)
        this.configSub = this.config.changed$.subscribe(() => {
            this.cdr.markForCheck()
            this.cdr.detectChanges()
        })
    }

    ngOnDestroy (): void {
        this.configSub?.unsubscribe()
    }

    onProviderChange (): void {
        const provider = this.config.store.ai.provider
        const preset = PROVIDER_PRESETS[provider]
        if (preset) {
            // Clear baseUrl so the preset is used, update model to the preset default
            this.config.store.ai.baseUrl = ''
            this.config.store.ai.model = preset.defaultModel
        }
    }

    getBaseUrlPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.baseUrl || 'https://your-endpoint.com/v1/'
    }

    getModelPlaceholder (): string {
        const provider = this.config.store.ai.provider
        return PROVIDER_PRESETS[provider]?.defaultModel || 'model-name'
    }

    // --- Token Usage History ---

    getUsageProviders (): string[] {
        const usage = this.config.store.ai?.tokenUsage
        if (!usage) return []
        return Object.keys(usage).filter(k => usage[k]?.totalTokens > 0).sort()
    }

    getProviderLabel (provider: string): string {
        return PROVIDER_LABELS[provider] || provider
    }

    formatNumber (n: number): string {
        return (n || 0).toLocaleString()
    }

    getTotalRequests (): number {
        return this.sumField('requestCount')
    }

    getTotalPromptTokens (): number {
        return this.sumField('promptTokens')
    }

    getTotalCompletionTokens (): number {
        return this.sumField('completionTokens')
    }

    getTotalTokens (): number {
        return this.sumField('totalTokens')
    }

    clearUsage (provider: string): void {
        // Set to null (= default) so ConfigProxy removes it from real storage
        this.config.store.ai.tokenUsage[provider] = null
        this.config.save()
    }

    clearAllUsage (): void {
        for (const p of this.getUsageProviders()) {
            this.config.store.ai.tokenUsage[p] = null
        }
        this.config.save()
    }

    private sumField (field: string): number {
        const usage = this.config.store.ai?.tokenUsage
        if (!usage) return 0
        let total = 0
        for (const v of Object.values(usage) as any[]) {
            total += v?.[field] || 0
        }
        return total
    }
}
