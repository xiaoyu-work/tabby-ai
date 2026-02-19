/**
 * Terminal SessionMiddleware that intercepts `@ ` at command line start
 * and drives the AI agent loop.
 *
 * Replaces gemini-cli's React Ink UI layer with terminal ANSI output.
 * Confirmation flow mirrors gemini-cli's resolveConfirmation()
 * (packages/core/src/scheduler/confirmation.ts)
 */

import colors from 'ansi-colors'
import { SessionMiddleware } from 'tabby-terminal'
import { AIService } from './ai.service'
import { ContextCollector } from './contextCollector'
import { AgentLoop } from './agentLoop'

const enum State {
    /** Normal mode — all input goes to shell */
    NORMAL,
    /** Saw @ at line start, waiting for space or other char */
    PENDING,
    /** Collecting AI prompt text */
    CAPTURING,
    /** Agent running — AI streaming response */
    AGENT_STREAMING,
    /** Agent paused — waiting for user to approve a command */
    AGENT_CONFIRMING,
    /** Agent running — a shell command is executing */
    AGENT_EXECUTING,
}

export class AIMiddleware extends SessionMiddleware {
    private state = State.NORMAL
    private promptBuffer = ''
    private atLineStart = true
    private abortController: AbortController | null = null
    private confirmResolve: ((approved: boolean) => void) | null = null
    private bannerShown = false

    constructor (
        private ai: AIService,
        private collector: ContextCollector,
    ) {
        super()
    }

    feedFromSession (data: Buffer): void {
        if (!this.bannerShown) {
            this.bannerShown = true
            this.outputToTerminal.next(Buffer.from(
                '\r\n' + colors.cyan('  [AI Ready] ') + colors.gray('Type "@ " + prompt + Enter to chat with AI') + '\r\n',
            ))
        }
        // Any shell output means cursor is at a prompt/new line
        this.atLineStart = true
        this.outputToTerminal.next(data)
    }

    feedFromTerminal (data: Buffer): void {
        // Multi-byte data (paste)
        if (data.length !== 1) {
            if (this.state === State.CAPTURING) {
                const text = data.toString('utf-8')
                this.promptBuffer += text
                this.outputToTerminal.next(Buffer.from(colors.white(text)))
                return
            }
            if (this.state === State.NORMAL) {
                this.atLineStart = false
                this.outputToSession.next(data)
            }
            // In agent states, swallow multi-byte input
            return
        }

        const byte = data[0]

        switch (this.state) {
            case State.NORMAL:
                if (byte === 0x40 /* @ */ && this.atLineStart) {
                    this.state = State.PENDING
                    this.outputToTerminal.next(Buffer.from(colors.cyan('@')))
                    return
                }
                this.atLineStart = (byte === 0x0D)
                this.outputToSession.next(data)
                return

            case State.PENDING:
                if (byte === 0x20 /* space */) {
                    this.state = State.CAPTURING
                    this.promptBuffer = ''
                    this.outputToTerminal.next(Buffer.from(colors.cyan(' ')))
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    // Backspace — erase the @ we echoed
                    this.outputToTerminal.next(Buffer.from('\b \b'))
                    this.state = State.NORMAL
                    this.atLineStart = true
                    return
                }
                // Not a space — flush @ + current char to shell
                this.outputToTerminal.next(Buffer.from('\b \b'))
                this.state = State.NORMAL
                this.atLineStart = false
                this.outputToSession.next(Buffer.from('@'))
                this.outputToSession.next(data)
                return

            case State.CAPTURING:
                if (byte === 0x0D /* Enter */) {
                    this.startAgent()
                    return
                }
                if (byte === 0x7F || byte === 0x08) {
                    if (this.promptBuffer.length > 0) {
                        this.promptBuffer = this.promptBuffer.slice(0, -1)
                        this.outputToTerminal.next(Buffer.from('\b \b'))
                    }
                    return
                }
                if (byte === 0x03 /* Ctrl+C */ || byte === 0x1B /* Escape */) {
                    this.outputToTerminal.next(Buffer.from('\r\n'))
                    this.state = State.NORMAL
                    this.atLineStart = true
                    this.promptBuffer = ''
                    this.outputToSession.next(Buffer.from('\r'))
                    return
                }
                // Regular character
                const char = String.fromCharCode(byte)
                this.promptBuffer += char
                this.outputToTerminal.next(Buffer.from(colors.white(char)))
                return

            case State.AGENT_CONFIRMING:
                if (byte === 0x0D /* Enter = approve */) {
                    this.confirmResolve?.(true)
                    this.confirmResolve = null
                    return
                }
                if (byte === 0x03 /* Ctrl+C = skip this command */) {
                    this.confirmResolve?.(false)
                    this.confirmResolve = null
                    return
                }
                return // Swallow all other input during confirmation

            case State.AGENT_STREAMING:
            case State.AGENT_EXECUTING:
                if (byte === 0x03 /* Ctrl+C = abort entire agent */) {
                    this.abortController?.abort()
                    return
                }
                return // Swallow all other input during agent execution
        }
    }

    private async startAgent (): Promise<void> {
        const query = this.promptBuffer.trim()
        this.promptBuffer = ''

        if (!query) {
            this.state = State.NORMAL
            this.atLineStart = true
            this.outputToSession.next(Buffer.from('\r'))
            return
        }

        this.outputToTerminal.next(Buffer.from('\r\n'))
        this.state = State.AGENT_STREAMING
        this.abortController = new AbortController()

        const loop = new AgentLoop(this.ai, this.collector, {
            onContent: (text) => {
                this.state = State.AGENT_STREAMING
                const formatted = text.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.green(formatted)))
            },

            onThinking: (text) => {
                const formatted = text.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.gray(formatted)))
            },

            onConfirmCommand: (cmd) => {
                this.state = State.AGENT_CONFIRMING
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' +
                    colors.yellow(`  ⚡ ${cmd}`) +
                    colors.gray('  [Enter=run / Ctrl+C=skip]'),
                ))
            },

            waitForApproval: () => {
                return new Promise<boolean>((resolve) => {
                    // Reject any outstanding confirmation to avoid a dangling promise
                    if (this.confirmResolve) {
                        this.confirmResolve(false)
                    }
                    this.confirmResolve = resolve
                })
            },

            onCommandStart: () => {
                this.state = State.AGENT_EXECUTING
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onCommandOutput: (chunk) => {
                const formatted = chunk.replace(/\n/g, '\r\n')
                this.outputToTerminal.next(Buffer.from(colors.dim(formatted)))
            },

            onCommandDone: () => {
                this.state = State.AGENT_STREAMING
                this.outputToTerminal.next(Buffer.from('\r\n'))
            },

            onDone: () => {
                this.outputToTerminal.next(Buffer.from('\r\n'))
                this.state = State.NORMAL
                this.atLineStart = true
                this.abortController = null
                // Trigger shell to show new prompt
                this.outputToSession.next(Buffer.from('\r'))
            },

            onError: (err) => {
                this.outputToTerminal.next(Buffer.from(
                    '\r\n' + colors.red(`  Error: ${err}`) + '\r\n',
                ))
                this.state = State.NORMAL
                this.atLineStart = true
                this.abortController = null
                this.outputToSession.next(Buffer.from('\r'))
            },
        }, this.abortController.signal)

        await loop.run(query)
    }
}
