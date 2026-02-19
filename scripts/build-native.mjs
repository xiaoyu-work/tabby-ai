#!/usr/bin/env node
import { rebuild } from '@electron/rebuild'
import * as path from 'path'
import * as vars from './vars.mjs'

import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))


if (process.platform === 'win32' || process.platform === 'linux') {
    process.env.ARCH = ((process.env.ARCH || process.arch) === 'arm') ? 'armv7l' : process.env.ARCH || process.arch
} else {
    process.env.ARCH ??= process.arch
}

if (process.platform === 'win32' && !process.env.VCToolsVersion) {
    // VS 2026's default v180 toolset lacks Spectre-mitigated libs.
    // Find a toolset that has them (v143's 14.44.x typically does).
    const fs = await import('fs')
    const vsEditions = ['Community', 'Professional', 'Enterprise']
    for (const edition of vsEditions) {
        const toolsBase = path.resolve('C:/Program Files/Microsoft Visual Studio/18', edition, 'VC/Tools/MSVC')
        try {
            const versions = fs.readdirSync(toolsBase)
                .filter(v => fs.existsSync(path.join(toolsBase, v, 'lib/spectre/x64')))
                .sort()
            if (versions.length > 0) {
                process.env.VCToolsVersion = versions[versions.length - 1]
                console.info('Using VCToolsVersion', process.env.VCToolsVersion, '(has Spectre libs)')
                break
            }
        } catch {
            // This VS edition not installed, try next
        }
    }
}

let lifecycles = []
for (let dir of ['app', 'tabby-core', 'tabby-local', 'tabby-ssh', 'tabby-terminal']) {
    const build = rebuild({
        buildPath: path.resolve(__dirname, '../' + dir),
        electronVersion: vars.electronVersion,
        arch: process.env.ARCH,
        force: true,
    })
    build.catch(e => {
        console.error(e)
        process.exit(1)
    })
    lifecycles.push([build.lifecycle, dir])
}

console.info('Building against Electron', vars.electronVersion)

for (let [lc, dir] of lifecycles) {
    lc.on('module-found', name => {
        console.info('Rebuilding', dir + '/' + name)
    })
}
