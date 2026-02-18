import { Injectable } from '@angular/core'
import { HotkeysService } from 'tabby-core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
import { ContextCollector } from './contextCollector'
import { AIService } from './ai.service'

/**
 * Attaches to each terminal tab:
 * 1. Collects terminal context (output, CWD)
 * 2. Listens for the AI hotkey
 * 3. Shows/hides an AI panel overlay (pure DOM)
 */
@Injectable()
export class AIDecorator extends TerminalDecorator {
    constructor (
        private hotkeys: HotkeysService,
        private ai: AIService,
    ) {
        super()
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        const collector = new ContextCollector()
        let panel: AIPanel | null = null

        // --- Context collection ---
        const attachToSession = () => {
            if (!tab.session) {
                return
            }
            this.subscribeUntilDetached(tab, tab.session.binaryOutput$.subscribe(data => {
                collector.pushOutput(data)
            }))
            if (tab.session.oscProcessor) {
                this.subscribeUntilDetached(tab, tab.session.oscProcessor.cwdReported$.subscribe(cwd => {
                    collector.cwd = cwd
                }))
            }
        }

        setTimeout(() => {
            attachToSession()
            this.subscribeUntilDetached(tab, tab.sessionChanged$.subscribe(() => {
                attachToSession()
            }))
        })

        // --- Hotkey: toggle AI panel ---
        this.subscribeUntilDetached(tab, this.hotkeys.unfilteredHotkey$.subscribe(hotkey => {
            if (!tab.hasFocus) {
                return
            }
            if (hotkey === 'ai-trigger') {
                if (!panel) {
                    panel = new AIPanel(tab.element.nativeElement, this.ai, collector, () => {
                        tab.frontend?.focus()
                    })
                }
                panel.toggle()
            }
        }))
    }
}

/**
 * Pure-DOM AI panel overlay. No Angular template needed.
 */
class AIPanel {
    private container: HTMLDivElement
    private input: HTMLInputElement
    private responseArea: HTMLPreElement
    private loadingIndicator: HTMLDivElement
    private visible = false

    constructor (
        private host: HTMLElement,
        private ai: AIService,
        private collector: ContextCollector,
        private onClose: () => void,
    ) {
        this.container = document.createElement('div')
        this.container.className = 'ai-panel-overlay'
        this.container.style.cssText = `
            position: fixed;
            right: 20px;
            top: 40px;
            width: 520px;
            max-width: 85vw;
            max-height: 70vh;
            z-index: 100;
            border-radius: 8px;
            background: rgba(30, 30, 30, 0.97);
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            display: none;
            flex-direction: column;
            overflow: hidden;
            font-family: inherit;
            color: #e0e0e0;
        `
        this.container.addEventListener('click', e => e.stopPropagation())
        this.container.addEventListener('keydown', e => e.stopPropagation())

        // Header
        const header = document.createElement('div')
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.08);'
        header.innerHTML = '<span style="font-size:0.85rem; font-weight:600; color:rgba(255,255,255,0.7);">AI Assistant</span>'

        const closeBtn = document.createElement('button')
        closeBtn.textContent = '\u00d7'
        closeBtn.style.cssText = 'background:none; border:none; color:rgba(255,255,255,0.4); font-size:1.2rem; cursor:pointer; padding:2px 6px;'
        closeBtn.addEventListener('click', () => this.hide())
        header.appendChild(closeBtn)
        this.container.appendChild(header)

        // Input row
        const inputRow = document.createElement('div')
        inputRow.style.cssText = 'display:flex; gap:6px; padding:10px 12px;'

        this.input = document.createElement('input')
        this.input.type = 'text'
        this.input.placeholder = 'Ask about your terminal...'
        this.input.style.cssText = `
            flex:1; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
            color:#e0e0e0; font-size:0.9rem; border-radius:6px; padding:6px 10px; outline:none;
        `
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                this.submit()
            }
            if (e.key === 'Escape') {
                this.hide()
            }
        })
        this.input.addEventListener('focus', () => {
            this.input.style.borderColor = 'rgba(100,160,255,0.5)'
        })
        this.input.addEventListener('blur', () => {
            this.input.style.borderColor = 'rgba(255,255,255,0.12)'
        })
        inputRow.appendChild(this.input)

        const submitBtn = document.createElement('button')
        submitBtn.textContent = '\u27a4'
        submitBtn.style.cssText = 'flex-shrink:0; padding:6px 12px; border-radius:6px; border:none; background:#0d6efd; color:white; cursor:pointer; font-size:0.9rem;'
        submitBtn.addEventListener('click', () => this.submit())
        inputRow.appendChild(submitBtn)

        this.container.appendChild(inputRow)

        // Loading indicator
        this.loadingIndicator = document.createElement('div')
        this.loadingIndicator.textContent = 'Thinking...'
        this.loadingIndicator.style.cssText = 'display:none; padding:0 12px 8px; color:rgba(255,255,255,0.5); font-size:0.85rem;'
        this.container.appendChild(this.loadingIndicator)

        // Response area
        this.responseArea = document.createElement('pre')
        this.responseArea.style.cssText = `
            display:none; margin:0 12px 12px; padding:10px; background:rgba(0,0,0,0.3);
            border-radius:6px; color:#d4d4d4; font-size:0.85rem; line-height:1.5;
            white-space:pre-wrap; word-wrap:break-word; max-height:50vh; overflow-y:auto;
            font-family:'Cascadia Code','Fira Code','Consolas',monospace;
        `
        this.container.appendChild(this.responseArea)

        this.host.appendChild(this.container)
    }

    toggle (): void {
        if (this.visible) {
            this.hide()
        } else {
            this.show()
        }
    }

    show (): void {
        this.container.style.display = 'flex'
        this.visible = true
        setTimeout(() => this.input.focus(), 50)
    }

    hide (): void {
        this.container.style.display = 'none'
        this.visible = false
        this.onClose()
    }

    private async submit (): Promise<void> {
        const query = this.input.value.trim()
        if (!query) {
            return
        }

        this.loadingIndicator.style.display = 'block'
        this.responseArea.style.display = 'none'
        this.responseArea.textContent = ''
        this.input.disabled = true

        try {
            const context = this.collector.toPromptString()
            const response = await this.ai.query(query, context)
            this.responseArea.textContent = response
            this.responseArea.style.display = 'block'
        } catch (err: any) {
            this.responseArea.textContent = `Error: ${err.message}`
            this.responseArea.style.display = 'block'
        } finally {
            this.loadingIndicator.style.display = 'none'
            this.input.disabled = false
            this.input.focus()
        }
    }

    destroy (): void {
        this.container.remove()
    }
}
