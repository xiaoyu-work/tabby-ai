/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'

import { AIService } from './ai.service'
import { AIDecorator } from './decorator'
import { AIConfigProvider } from './config'
import { AIHotkeyProvider } from './hotkeys'

@NgModule({
    providers: [
        { provide: TerminalDecorator, useClass: AIDecorator, multi: true },
        { provide: ConfigProvider, useClass: AIConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: AIHotkeyProvider, multi: true },
        AIService,
    ],
})
export default class TabbyAIModule {}

export { AIService } from './ai.service'
export { AIDecorator } from './decorator'
export { ContextCollector } from './contextCollector'
