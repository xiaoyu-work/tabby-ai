/**
 * Agent React Loop — drives the stream → tools → continue cycle.
 *
 * Mirrors gemini-cli's useGeminiStream hook:
 *   submitQuery() → processGeminiStreamEvents() → scheduleToolCalls()
 *   → handleCompletedTools() → submitQuery(continuation)
 *
 * Reference: packages/cli/src/ui/hooks/useGeminiStream.ts
 */

import { AIService, ChatMessage, ToolDefinition } from './ai.service'
import { ContextCollector } from './contextCollector'
import { EventType, ToolCallRequest } from './streamEvents'
import { executeCommand, ShellResult } from './shellExecutor'
import * as fs from 'fs/promises'
import * as path from 'path'

/** Tool definitions — mirrors gemini-cli's coreTools.ts */
const TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'run_shell_command',
            description: 'Execute a shell command and return its output. Use this for any system operations, checking status, installing packages, running builds, etc.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to execute',
                    },
                },
                required: ['command'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the contents of a file. Returns the file text content.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path (absolute or relative to CWD)',
                    },
                },
                required: ['path'],
            },
        },
    },
]

export interface AgentCallbacks {
    onContent: (text: string) => void
    onThinking: (text: string) => void
    onConfirmCommand: (cmd: string) => void
    waitForApproval: () => Promise<boolean>
    onCommandStart: (cmd: string) => void
    onCommandOutput: (chunk: string) => void
    onCommandDone: (result: ShellResult) => void
    onDone: () => void
    onError: (err: string) => void
}

export class AgentLoop {
    private messages: ChatMessage[] = []
    private maxTurns = 20

    constructor (
        private ai: AIService,
        private collector: ContextCollector,
        private callbacks: AgentCallbacks,
        private signal: AbortSignal,
    ) {}

    /**
     * Main loop — mirrors gemini-cli's submitQuery → processGeminiStreamEvents
     * → scheduleToolCalls → handleCompletedTools → submitQuery(continuation)
     */
    async run (userQuery: string): Promise<void> {
        const context = this.collector.toPromptString()

        this.messages = [
            { role: 'system', content: this.buildSystemPrompt(context) },
            { role: 'user', content: userQuery },
        ]

        try {
            for (let turn = 0; turn < this.maxTurns; turn++) {
                if (this.signal.aborted) break

                // Trim messages to prevent unbounded growth.
                // Keep the system message at [0] and the last 40 messages.
                if (this.messages.length > 50) {
                    const systemMsg = this.messages[0]
                    this.messages = [systemMsg, ...this.messages.slice(-40)]
                }

                // === processGeminiStreamEvents() ===
                const toolCallRequests: ToolCallRequest[] = []
                let assistantContent = ''

                const stream = this.ai.streamWithTools(
                    this.messages, TOOLS, this.signal,
                )

                for await (const event of stream) {
                    if (this.signal.aborted) break

                    switch (event.type) {
                        case EventType.Content:
                            assistantContent += event.value
                            this.callbacks.onContent(event.value)
                            break

                        case EventType.Thought:
                            this.callbacks.onThinking(event.value)
                            break

                        case EventType.ToolCall:
                            toolCallRequests.push(event.value as ToolCallRequest)
                            break

                        case EventType.Error:
                            this.callbacks.onError(event.value)
                            return

                        case EventType.Finished:
                            break
                    }
                }

                // No tool calls → agent is done
                if (toolCallRequests.length === 0) break

                // === handleCompletedTools() ===
                // Add assistant message with tool_calls to history
                this.messages.push({
                    role: 'assistant',
                    content: assistantContent || null,
                    tool_calls: toolCallRequests.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: tc.function,
                    })),
                })

                // === scheduleToolCalls() — execute each tool ===
                for (const call of toolCallRequests) {
                    if (this.signal.aborted) break

                    const result = await this.executeTool(call)

                    // Add tool result to history as functionResponse
                    // (mirrors gemini-cli's responseParts → submitQuery(continuation))
                    this.messages.push({
                        role: 'tool',
                        content: result,
                        tool_call_id: call.id,
                    })
                }

                // === Continuation: loop back to top, streamWithTools with tool results ===
            }
        } catch (err: any) {
            if (err.name === 'AbortError' || this.signal.aborted) {
                this.callbacks.onContent('\r\n(aborted)\r\n')
            } else {
                this.callbacks.onError(err.message)
                return
            }
        }

        this.callbacks.onDone()
    }

    private async executeTool (call: ToolCallRequest): Promise<string> {
        let args: any
        try {
            args = JSON.parse(call.function.arguments)
        } catch {
            return `Error: Invalid tool arguments: ${call.function.arguments}`
        }

        switch (call.function.name) {
            case 'run_shell_command':
                return this.executeShellCommand(args.command)
            case 'read_file':
                return this.readFile(args.path)
            default:
                return `Unknown tool: ${call.function.name}`
        }
    }

    /**
     * Mirrors gemini-cli's ShellToolInvocation.execute()
     * + resolveConfirmation() for human-in-the-loop approval
     */
    private async executeShellCommand (command: string): Promise<string> {
        // 1. Request user approval (resolveConfirmation)
        this.callbacks.onConfirmCommand(command)
        const approved = await this.callbacks.waitForApproval()

        if (!approved) {
            return 'User declined to run this command.'
        }

        // 2. Execute (ShellExecutionService.execute)
        this.callbacks.onCommandStart(command)
        const cwd = this.collector.cwd || process.cwd()

        const result = await executeCommand(
            command, cwd, this.signal,
            (chunk) => this.callbacks.onCommandOutput(chunk),
        )

        this.callbacks.onCommandDone(result)

        // 3. Format result (ShellToolInvocation result formatting)
        const output = (result.stdout + result.stderr).trim()
        if (result.timedOut) {
            return `Command timed out after 30s.\nPartial output:\n${output}`
        }
        if (result.exitCode !== 0) {
            return `Command exited with code ${result.exitCode}\n${output}`
        }
        return output || '(no output)'
    }

    /** Sensitive dotfile basenames / directory names that must never be read. */
    private static readonly BLOCKED_DOTFILES = new Set([
        '.env', '.env.local', '.env.production', '.env.development', '.env.staging',
        '.ssh', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.docker',
        '.aws', '.azure', '.gcloud',
        '.git-credentials', '.bash_history', '.zsh_history',
    ])

    /**
     * Returns true when the given *resolved* path should be blocked because it
     * is a sensitive dotfile/directory or lives inside one.
     */
    private isSensitivePath (resolved: string): boolean {
        const cwd = this.collector.cwd || process.cwd()
        const relative = path.relative(cwd, resolved)
        const segments = relative.split(path.sep)

        for (const seg of segments) {
            if (AgentLoop.BLOCKED_DOTFILES.has(seg.toLowerCase())) {
                return true
            }
        }
        return false
    }

    /**
     * Mirrors gemini-cli's ReadFileToolInvocation.execute()
     *
     * Security: restricts reads to the current working directory and blocks
     * known sensitive dotfiles/directories.
     */
    private async readFile (filePath: string): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const resolved = path.resolve(cwd, filePath)

        // --- Path-traversal guard: resolved path must be inside cwd ---
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            return `Error: Access denied – "${filePath}" resolves to a path outside the working directory.`
        }

        // --- Block sensitive dotfiles / directories ---
        if (this.isSensitivePath(resolved)) {
            return `Error: Access denied – reading sensitive dotfiles is not allowed ("${filePath}").`
        }

        // --- User confirmation (same flow as shell commands) ---
        this.callbacks.onConfirmCommand(`Read file: ${filePath}`)
        const approved = await this.callbacks.waitForApproval()
        if (!approved) {
            return 'User declined to read this file.'
        }

        try {
            const content = await fs.readFile(resolved, 'utf-8')
            if (content.length > 10000) {
                return content.slice(0, 10000) + '\n... (truncated, 10000 chars shown)'
            }
            return content
        } catch (err: any) {
            return `Error reading file: ${err.message}`
        }
    }

    private buildSystemPrompt (context: string): string {
        return [
            'You are an AI assistant embedded in the Tabby terminal.',
            'You can run shell commands and read files to help the user complete tasks.',
            '',
            'Guidelines:',
            '- When you need to investigate or take action, USE the tools instead of just suggesting commands.',
            '- Explain what you are about to do before using a tool.',
            '- After getting tool results, analyze them and decide if more actions are needed.',
            '- Be concise in explanations.',
            '- If a command fails, try to diagnose and fix the issue.',
            '',
            context,
        ].join('\n')
    }
}
