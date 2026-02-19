/**
 * Shell command execution with output streaming, abort support, and timeout.
 * Based on gemini-cli's ShellExecutionService
 * (packages/core/src/services/shellExecutionService.ts).
 */

import { spawn } from 'child_process'
import * as os from 'os'

export interface ShellResult {
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
}

/**
 * Patterns that identify sensitive environment variable names.
 * Any key whose UPPERCASED form contains one of these substrings is stripped.
 */
const SENSITIVE_SUBSTRINGS = [
    'API_KEY',
    'APIKEY',
    'SECRET',
    'TOKEN',
    'PASSWORD',
    'CREDENTIAL',
    'PRIVATE_KEY',
]

/**
 * Prefixes for cloud-provider / AI-service variables that should never leak.
 */
const SENSITIVE_PREFIXES = [
    'AZURE_',
    'AWS_',
    'GCP_',
    'OPENAI_',
    'ANTHROPIC_',
]

/**
 * Build a filtered copy of process.env that strips sensitive keys while
 * keeping standard system variables (PATH, HOME, SHELL, TERM, LANG, etc.).
 */
function buildSafeEnv (): Record<string, string | undefined> {
    const filtered: Record<string, string | undefined> = {}

    for (const [key, value] of Object.entries(process.env)) {
        const upper = key.toUpperCase()

        // Check sensitive substrings
        if (SENSITIVE_SUBSTRINGS.some(s => upper.includes(s))) continue

        // Check sensitive prefixes
        if (SENSITIVE_PREFIXES.some(p => upper.startsWith(p))) continue

        filtered[key] = value
    }

    return filtered
}

/**
 * Execute a shell command, capturing output.
 * Mirrors gemini-cli's ShellExecutionService.execute().
 */
export async function executeCommand (
    command: string,
    cwd: string,
    signal: AbortSignal,
    onOutput?: (chunk: string) => void,
    timeout = 30000,
): Promise<ShellResult> {
    return new Promise((resolve) => {
        const isWindows = os.platform() === 'win32'
        const shell = isWindows ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash'
        const args = isWindows ? ['/c', command] : ['-c', command]

        const child = spawn(shell, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: !isWindows,
            env: {
                ...buildSafeEnv(),
                PAGER: 'cat',
                GIT_PAGER: 'cat',
            },
        })

        let stdout = ''
        let stderr = ''
        let timedOut = false
        const maxBuffer = 512 * 1024

        const abortHandler = () => {
            try {
                if (!isWindows && child.pid) {
                    process.kill(-child.pid, 'SIGTERM')
                } else {
                    child.kill('SIGTERM')
                }
            } catch { /* already dead */ }
        }
        signal.addEventListener('abort', abortHandler, { once: true })

        const timer = setTimeout(() => {
            timedOut = true
            abortHandler()
        }, timeout)

        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString()
            if (stdout.length < maxBuffer) {
                stdout += text
            }
            onOutput?.(text)
        })

        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString()
            if (stderr.length < maxBuffer) {
                stderr += text
            }
            onOutput?.(text)
        })

        child.on('close', (code) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abortHandler)
            resolve({ stdout, stderr, exitCode: code, timedOut })
        })

        child.on('error', (err) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abortHandler)
            resolve({ stdout, stderr: err.message, exitCode: 1, timedOut: false })
        })
    })
}
