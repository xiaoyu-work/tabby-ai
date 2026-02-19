/**
 * Captures terminal output and state for AI context injection.
 *
 * Each terminal tab gets its own ContextCollector instance.
 * The decorator feeds PTY output into it, and when the AI is
 * triggered, we produce a snapshot of what the user is seeing.
 */

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[a-zA-Z]/g

export class ContextCollector {
    private buffer: string[] = []
    private _cwd = ''
    private readonly maxLines: number
    private totalLinesPushed = 0

    constructor (maxLines = 100) {
        this.maxLines = maxLines
    }

    /**
     * Feed raw PTY output — strips ANSI, splits into lines, keeps last N.
     */
    pushOutput (data: Buffer): void {
        const clean = data.toString('utf-8').replace(ANSI_REGEX, '')
        const lines = clean.split(/\r?\n/)
        this.totalLinesPushed += lines.length
        this.buffer.push(...lines)
        if (this.buffer.length > this.maxLines) {
            this.buffer = this.buffer.slice(-this.maxLines)
        }
    }

    /**
     * Get terminal output added since the given checkpoint.
     * Returns the text and a new checkpoint value.
     */
    getOutputSince (checkpoint: number): { text: string; checkpoint: number } {
        const newLines = this.totalLinesPushed - checkpoint
        if (newLines <= 0) {
            return { text: '', checkpoint: this.totalLinesPushed }
        }
        const available = Math.min(newLines, this.buffer.length)
        const lines = this.buffer.slice(-available)
        return {
            text: lines.join('\n'),
            checkpoint: this.totalLinesPushed,
        }
    }

    set cwd (value: string) {
        this._cwd = value
    }

    get cwd (): string {
        return this._cwd
    }

    /**
     * Build a context snapshot for the AI prompt.
     */
    snapshot (): { cwd: string; scrollback: string; shell: string } {
        return {
            cwd: this._cwd,
            scrollback: this.buffer.slice(-50).join('\n'),
            shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
        }
    }

    /**
     * Format context as a string for the AI system prompt.
     */
    toPromptString (): string {
        const ctx = this.snapshot()
        const parts: string[] = [
            '<terminal_context>',
            `cwd: ${ctx.cwd}`,
            `shell: ${ctx.shell}`,
        ]

        if (ctx.scrollback) {
            parts.push('', 'Recent terminal output:', ctx.scrollback)
        }

        parts.push('</terminal_context>')
        return parts.join('\n')
    }
}
