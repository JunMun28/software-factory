import { Component, inject } from '@angular/core';

import { ChatService } from '../../services/chat.service';
import { WorkspaceShellService } from '../../services/workspace-shell.service';
import { DatabasePanel } from '../database-panel/database-panel';
import { DesignPanel } from '../design-panel/design-panel';
import { FilesPanel } from '../files-panel/files-panel';
import { PreviewPanel } from '../preview-panel/preview-panel';

@Component({
  selector: 'app-right-panel',
  imports: [PreviewPanel, DesignPanel, FilesPanel, DatabasePanel],
  host: { class: 'flex h-full min-w-0 flex-1' },
  template: `
    @if (chatService.activeChatId()) {
      <section class="h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background" data-panel="workspace">
        @switch (shell.activeTool()) {
          @case ('preview') {
            <app-preview-panel />
          }
          @case ('design') {
            <app-design-panel />
          }
          @case ('code') {
            <app-files-panel />
          }
          @case ('database') {
            <app-database-panel />
          }
        }
      </section>
    }
  `,
})
export class RightPanel {
  readonly chatService = inject(ChatService);
  readonly shell = inject(WorkspaceShellService);
}
