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
import { EventType, ToolCallRequest, TokensSummary } from './streamEvents'
import { executeCommand, ShellResult } from './shellExecutor'
import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Tool definitions — mirrors gemini-cli's coreTools.ts
 * (packages/core/src/tools/definitions/model-family-sets/default-legacy.ts)
 */
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
            description: 'Read the contents of a file at the specified path. Returns the file content with line numbers. For large files, use offset and limit to read specific sections.',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'The path to the file to read (absolute or relative to CWD)',
                    },
                    offset: {
                        type: 'integer',
                        description: 'Optional: The line number to start reading from (1-based). Defaults to 1.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Optional: The number of lines to read. Defaults to reading the entire file (up to 2000 lines).',
                    },
                },
                required: ['file_path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Writes content to a specified file. Creates the file and parent directories if they do not exist. Overwrites existing content.',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'The path to the file to write to (absolute or relative to CWD)',
                    },
                    content: {
                        type: 'string',
                        description: 'The content to write to the file',
                    },
                },
                required: ['file_path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'replace',
            description: 'Replaces text within a file. By default, replaces a single occurrence, but can replace multiple when expected_replacements is specified. Always use read_file first to examine the file before editing. The old_string must uniquely identify the text to change — include enough surrounding context (at least 3 lines before and after) to ensure a unique match.',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'The path to the file to modify (absolute or relative to CWD)',
                    },
                    old_string: {
                        type: 'string',
                        description: 'The exact literal text to replace. Must match the file content precisely, including whitespace and indentation.',
                    },
                    new_string: {
                        type: 'string',
                        description: 'The exact literal text to replace old_string with.',
                    },
                    expected_replacements: {
                        type: 'integer',
                        description: 'Optional: Number of replacements expected. Defaults to 1.',
                        minimum: 1,
                    },
                },
                required: ['file_path', 'old_string', 'new_string'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'Lists the names of files and subdirectories directly within a specified directory path.',
            parameters: {
                type: 'object',
                properties: {
                    dir_path: {
                        type: 'string',
                        description: 'The path to the directory to list (absolute or relative to CWD)',
                    },
                },
                required: ['dir_path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'glob',
            description: 'Finds files matching a glob pattern (e.g., "src/**/*.ts", "**/*.md"), returning paths sorted by modification time (newest first). Ideal for locating files by name or path structure.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'The glob pattern to match against (e.g., "**/*.py", "docs/*.md")',
                    },
                    dir_path: {
                        type: 'string',
                        description: 'Optional: The directory to search within (absolute or relative to CWD). Defaults to CWD.',
                    },
                },
                required: ['pattern'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'grep_search',
            description: 'Searches for a regular expression pattern within file contents. Returns matching lines with file paths and line numbers. Max 100 matches.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'The regular expression pattern to search for within file contents',
                    },
                    dir_path: {
                        type: 'string',
                        description: 'Optional: The directory to search within (absolute or relative to CWD). Defaults to CWD.',
                    },
                    include: {
                        type: 'string',
                        description: 'Optional: A glob pattern to filter which files are searched (e.g., "*.js", "*.{ts,tsx}")',
                    },
                },
                required: ['pattern'],
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

/** Result from AgentLoop.run() */
export interface AgentResult {
    messages: ChatMessage[]
    usage: TokensSummary
}

export class AgentLoop {
    private messages: ChatMessage[] = []
    private maxTurns = 20
    /** Accumulated token usage across all turns — maps to gemini-cli's ModelMetrics.tokens */
    private usage: TokensSummary = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }

    constructor (
        private ai: AIService,
        private collector: ContextCollector,
        private callbacks: AgentCallbacks,
        private signal: AbortSignal,
    ) {}

    /**
     * Main loop — mirrors gemini-cli's submitQuery → processGeminiStreamEvents
     * → scheduleToolCalls → handleCompletedTools → submitQuery(continuation)
     *
     * Accepts pre-built messages (system + history + user query).
     * Returns only the messages produced during this run (assistant + tool results)
     * so the caller can append them to persistent conversation history.
     */
    async run (messages: ChatMessage[]): Promise<AgentResult> {
        this.messages = messages
        const startIndex = messages.length

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

                        case EventType.Usage: {
                            // Accumulate token usage — maps to gemini-cli's
                            // uiTelemetry.ts:processApiResponse() accumulation
                            const u = event.value as TokensSummary
                            this.usage.promptTokens += u.promptTokens
                            this.usage.completionTokens += u.completionTokens
                            this.usage.cachedTokens += u.cachedTokens
                            this.usage.totalTokens += u.totalTokens
                            break
                        }

                        case EventType.Retry:
                            this.callbacks.onContent(
                                `\r\n(Retrying... attempt ${event.value.attempt + 1}/${event.value.maxAttempts})\r\n`,
                            )
                            break

                        case EventType.Error:
                            this.callbacks.onError(event.value)
                            return { messages: this.messages.slice(startIndex), usage: this.usage }

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
                return { messages: this.messages.slice(startIndex), usage: this.usage }
            }
        }

        this.callbacks.onDone()
        return { messages: this.messages.slice(startIndex), usage: this.usage }
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
                return this.readFile(args.file_path || args.path, args.offset, args.limit)
            case 'write_file':
                return this.writeFile(args.file_path, args.content)
            case 'replace':
                return this.editFile(args.file_path, args.old_string, args.new_string, args.expected_replacements)
            case 'list_directory':
                return this.listDirectory(args.dir_path)
            case 'glob':
                return this.globSearch(args.pattern, args.dir_path)
            case 'grep_search':
                return this.grepSearch(args.pattern, args.dir_path, args.include)
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
     * Supports offset/limit for paginated reading of large files.
     *
     * Security: restricts reads to the current working directory and blocks
     * known sensitive dotfiles/directories.
     */
    private async readFile (filePath: string, offset?: number, limit?: number): Promise<string> {
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
            const lines = content.split('\n')
            const totalLines = lines.length

            // Apply offset/limit (1-based offset)
            const startLine = Math.max(1, offset || 1)
            const maxLines = limit || 2000
            const selectedLines = lines.slice(startLine - 1, startLine - 1 + maxLines)

            // Format with line numbers (like gemini-cli's read_file)
            const numbered = selectedLines.map((line, i) =>
                `${String(startLine + i).padStart(6)} | ${line}`,
            ).join('\n')

            let result = numbered
            if (startLine + selectedLines.length - 1 < totalLines) {
                result += `\n\n... (${totalLines} total lines, showing ${startLine}-${startLine + selectedLines.length - 1})`
            }

            return result
        } catch (err: any) {
            return `Error reading file: ${err.message}`
        }
    }

    /**
     * Mirrors gemini-cli's WriteFileTool.execute()
     * Creates parent directories if needed.
     * Requires user confirmation.
     */
    private async writeFile (filePath: string, content: string): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const resolved = path.resolve(cwd, filePath)

        // --- Path-traversal guard ---
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            return `Error: Access denied – "${filePath}" resolves to a path outside the working directory.`
        }

        // --- Block sensitive dotfiles ---
        if (this.isSensitivePath(resolved)) {
            return `Error: Access denied – writing to sensitive dotfiles is not allowed ("${filePath}").`
        }

        // --- User confirmation ---
        this.callbacks.onConfirmCommand(`Write file: ${filePath}`)
        const approved = await this.callbacks.waitForApproval()
        if (!approved) {
            return 'User declined to write this file.'
        }

        try {
            // Create parent directories if needed (mirrors gemini-cli's mkdirp)
            await fs.mkdir(path.dirname(resolved), { recursive: true })
            await fs.writeFile(resolved, content, 'utf-8')
            const lineCount = content.split('\n').length
            return `Successfully wrote ${lineCount} lines to ${filePath}`
        } catch (err: any) {
            return `Error writing file: ${err.message}`
        }
    }

    /**
     * Mirrors gemini-cli's EditTool.execute() — replace old_string with new_string.
     * Uses exact string matching.
     * Requires user confirmation.
     */
    private async editFile (
        filePath: string,
        oldString: string,
        newString: string,
        expectedReplacements?: number,
    ): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const resolved = path.resolve(cwd, filePath)

        // --- Path-traversal guard ---
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            return `Error: Access denied – "${filePath}" resolves to a path outside the working directory.`
        }

        // --- Block sensitive dotfiles ---
        if (this.isSensitivePath(resolved)) {
            return `Error: Access denied – editing sensitive dotfiles is not allowed ("${filePath}").`
        }

        // --- Read current content ---
        let content: string
        try {
            content = await fs.readFile(resolved, 'utf-8')
        } catch (err: any) {
            return `Error reading file: ${err.message}`
        }

        // --- Count occurrences ---
        const expected = expectedReplacements || 1
        let count = 0
        let searchFrom = 0
        while (true) {
            const idx = content.indexOf(oldString, searchFrom)
            if (idx === -1) break
            count++
            searchFrom = idx + oldString.length
        }

        if (count === 0) {
            // Fallback: try flexible matching (trimmed lines)
            const result = this.flexibleReplace(content, oldString, newString, expected)
            if (result) {
                content = result.content
                count = result.count
            } else {
                return `Error: old_string not found in ${filePath}. Use read_file to examine the current content first.`
            }
        } else {
            if (count !== expected) {
                return `Error: Expected ${expected} occurrence(s) of old_string, but found ${count}. Provide more context to make the match unique, or set expected_replacements=${count}.`
            }

            // --- Perform replacement ---
            content = this.replaceNOccurrences(content, oldString, newString, expected)
        }

        // --- User confirmation ---
        const summary = `Edit file: ${filePath} (${count} replacement${count > 1 ? 's' : ''})`
        this.callbacks.onConfirmCommand(summary)
        const approved = await this.callbacks.waitForApproval()
        if (!approved) {
            return 'User declined to edit this file.'
        }

        try {
            await fs.writeFile(resolved, content, 'utf-8')
            return `Successfully replaced ${count} occurrence(s) in ${filePath}`
        } catch (err: any) {
            return `Error writing file: ${err.message}`
        }
    }

    /**
     * Replace exactly N occurrences of a string.
     * Mirrors gemini-cli's exact strategy.
     */
    private replaceNOccurrences (content: string, oldStr: string, newStr: string, n: number): string {
        let result = ''
        let remaining = content
        let replaced = 0

        while (replaced < n) {
            const idx = remaining.indexOf(oldStr)
            if (idx === -1) break
            result += remaining.slice(0, idx) + newStr
            remaining = remaining.slice(idx + oldStr.length)
            replaced++
        }

        return result + remaining
    }

    /**
     * Flexible replacement — matches line-by-line with trimmed whitespace.
     * Mirrors gemini-cli's flexible strategy in EditTool.
     */
    private flexibleReplace (
        content: string,
        oldString: string,
        newString: string,
        expected: number,
    ): { content: string; count: number } | null {
        const contentLines = content.split('\n')
        const oldLines = oldString.split('\n').map(l => l.trim())
        const newLines = newString.split('\n')

        if (oldLines.length === 0) return null

        let count = 0
        const resultLines: string[] = []
        let i = 0

        while (i < contentLines.length) {
            // Try to match oldLines starting at position i
            let matched = true
            if (i + oldLines.length > contentLines.length) {
                resultLines.push(contentLines[i])
                i++
                continue
            }

            for (let j = 0; j < oldLines.length; j++) {
                if (contentLines[i + j].trim() !== oldLines[j]) {
                    matched = false
                    break
                }
            }

            if (matched && count < expected) {
                // Determine indentation from first matched line
                const indent = contentLines[i].match(/^(\s*)/)?.[1] || ''
                for (const nl of newLines) {
                    resultLines.push(nl.trim() ? indent + nl.trimStart() : nl)
                }
                i += oldLines.length
                count++
            } else {
                resultLines.push(contentLines[i])
                i++
            }
        }

        if (count === 0) return null
        return { content: resultLines.join('\n'), count }
    }

    /**
     * Mirrors gemini-cli's LSTool.execute()
     * No confirmation required — read-only operation.
     */
    private async listDirectory (dirPath: string): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const resolved = path.resolve(cwd, dirPath)

        // --- Path-traversal guard ---
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            return `Error: Access denied – "${dirPath}" resolves to a path outside the working directory.`
        }

        try {
            const entries = await fs.readdir(resolved, { withFileTypes: true })

            // Sort: directories first, then alphabetically
            entries.sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) {
                    return a.isDirectory() ? -1 : 1
                }
                return a.name.localeCompare(b.name)
            })

            const lines = entries.map(e =>
                e.isDirectory() ? `${e.name}/` : e.name,
            )

            if (lines.length === 0) {
                return `(empty directory: ${dirPath})`
            }

            return lines.join('\n')
        } catch (err: any) {
            return `Error listing directory: ${err.message}`
        }
    }

    /**
     * Mirrors gemini-cli's GlobTool.execute()
     * Uses shell command for cross-platform glob support.
     * No confirmation required — read-only operation.
     */
    private async globSearch (pattern: string, dirPath?: string): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const searchDir = dirPath ? path.resolve(cwd, dirPath) : cwd

        // --- Path-traversal guard ---
        if (!searchDir.startsWith(cwd + path.sep) && searchDir !== cwd) {
            return `Error: Access denied – "${dirPath}" resolves to a path outside the working directory.`
        }

        try {
            // Use git ls-files + shell glob for .gitignore respect, fall back to find
            const isGit = await fs.access(path.join(cwd, '.git')).then(() => true).catch(() => false)

            let command: string
            if (isGit) {
                // git ls-files respects .gitignore automatically
                command = `git ls-files --cached --others --exclude-standard "${pattern}" | head -200`
            } else {
                // Fallback: use find (Unix) or dir (Windows)
                const isWindows = process.platform === 'win32'
                if (isWindows) {
                    command = `dir /s /b "${pattern}" 2>NUL | head -200`
                } else {
                    command = `find . -name "${pattern}" -not -path "./.git/*" | head -200`
                }
            }

            const result = await executeCommand(command, searchDir, this.signal)
            const output = result.stdout.trim()

            if (!output) {
                return `No files found matching pattern: ${pattern}`
            }

            return output
        } catch (err: any) {
            return `Error searching files: ${err.message}`
        }
    }

    /**
     * Mirrors gemini-cli's GrepTool.execute()
     * Uses git grep (preferred) or grep as fallback.
     * No confirmation required — read-only operation.
     */
    private async grepSearch (pattern: string, dirPath?: string, include?: string): Promise<string> {
        const cwd = this.collector.cwd || process.cwd()
        const searchDir = dirPath ? path.resolve(cwd, dirPath) : cwd

        // --- Path-traversal guard ---
        if (!searchDir.startsWith(cwd + path.sep) && searchDir !== cwd) {
            return `Error: Access denied – "${dirPath}" resolves to a path outside the working directory.`
        }

        try {
            const isGit = await fs.access(path.join(cwd, '.git')).then(() => true).catch(() => false)
            const maxMatches = 100

            let command: string
            if (isGit) {
                // git grep: fastest, respects .gitignore
                const includeArg = include ? ` -- "${include}"` : ''
                command = `git grep --untracked -n -E --ignore-case -m ${maxMatches} "${pattern.replace(/"/g, '\\"')}"${includeArg}`
            } else {
                // Fallback: grep -r
                const includeArg = include ? ` --include="${include}"` : ''
                command = `grep -r -n -H -E -i${includeArg} "${pattern.replace(/"/g, '\\"')}" . | head -${maxMatches}`
            }

            const result = await executeCommand(command, searchDir, this.signal, undefined, 10000)
            const output = result.stdout.trim()

            if (!output) {
                return `No matches found for pattern: ${pattern}`
            }

            return output
        } catch (err: any) {
            return `Error searching: ${err.message}`
        }
    }

}
