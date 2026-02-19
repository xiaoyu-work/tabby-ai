import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
import { ContextCollector } from './contextCollector'
import { AIService } from './ai.service'
import { AIMiddleware } from './aiMiddleware'

/**
 * Terminal decorator that attaches the AIMiddleware to every terminal session.
 *
 * Follows the ZModemDecorator pattern (tabby-terminal/src/features/zmodem.ts)
 * for robust session attachment — defers work with setTimeout and subscribes
 * to sessionChanged$ for future session changes (including tab restoration).
 */
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
            try {
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
                tab.session.middleware.unshift(new AIMiddleware(this.ai, collector, this.config))
            } catch (e) {
                console.error('[tabby-ai] Failed to attach AI middleware:', e)
            }
        }

        // Defer initial attach to next tick — matches ZModemDecorator pattern.
        // This ensures the session has been fully initialized even for
        // restored tabs where initializeSession() may complete asynchronously.
        setTimeout(() => {
            attachToSession()

            // Subscribe to future session changes (reconnect, new session, etc.)
            this.subscribeUntilDetached(tab, tab.sessionChanged$.subscribe(() => {
                attachToSession()
            }))
        })

        // Additional fallback retries for edge cases (slow session restore)
        setTimeout(() => attachToSession(), 500)
        setTimeout(() => attachToSession(), 2000)
    }
}
