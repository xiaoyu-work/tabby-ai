import { Injectable } from '@angular/core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
import { ContextCollector } from './contextCollector'
import { AIService } from './ai.service'
import { AIMiddleware } from './aiMiddleware'

@Injectable()
export class AIDecorator extends TerminalDecorator {
    constructor (
        private ai: AIService,
    ) {
        super()
        console.warn('[tabby-ai] AIDecorator created')
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        console.warn('[tabby-ai] attach() called, session=', !!tab.session)
        const collector = new ContextCollector()
        let currentSession: any = null

        const attachToSession = (source: string) => {
            console.warn(`[tabby-ai] attachToSession(${source}): session=`, !!tab.session, 'same=', tab.session === currentSession)
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
            console.warn('[tabby-ai] AIMiddleware unshifted into session middleware stack')
        }

        // Subscribe to session changes (fires when session is set/changed)
        this.subscribeUntilDetached(tab, tab.sessionChanged$.subscribe(() => {
            attachToSession('sessionChanged$')
        }))

        // Also try immediately in case session already exists
        attachToSession('immediate')

        // Fallback retry for edge cases
        setTimeout(() => attachToSession('timeout-200'), 200)
        setTimeout(() => attachToSession('timeout-1000'), 1000)
        setTimeout(() => attachToSession('timeout-3000'), 3000)
    }
}
