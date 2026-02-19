import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
import { ContextCollector } from './contextCollector'
import { AIService } from './ai.service'
import { AIMiddleware } from './aiMiddleware'

@Injectable()
export class AIDecorator extends TerminalDecorator {
    constructor (
        private ai: AIService,
        private config: ConfigService,
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        const maxLines = this.config.store.ai?.maxContextLines ?? 100
        const collector = new ContextCollector(maxLines)
        let currentSession: any = null

        const attachToSession = () => {
            if (!tab.session || tab.session === currentSession) {
                return
            }
            currentSession = tab.session

            // Context collection
            this.subscribeUntilDetached(tab, tab.session.binaryOutput$.subscribe(data => {
                collector.pushOutput(data)
            }))

            if (tab.session.oscProcessor) {
                this.subscribeUntilDetached(tab, tab.session.oscProcessor.cwdReported$.subscribe(cwd => {
                    collector.cwd = cwd
                }))
            }

            // Insert AI middleware at the front of the stack
            tab.session.middleware.unshift(new AIMiddleware(this.ai, collector))
        }

        // Subscribe to session changes (fires when session is set/changed)
        this.subscribeUntilDetached(tab, tab.sessionChanged$.subscribe(() => {
            attachToSession()
        }))

        // Also try immediately in case session already exists
        attachToSession()

        // Fallback retry for edge cases
        setTimeout(() => attachToSession(), 200)
        setTimeout(() => attachToSession(), 1000)
    }
}
