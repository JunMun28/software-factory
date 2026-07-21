import { ChatConversation } from '../chats/chat-conversation/chat-conversation';
import { ChatSidebar } from '../chats/chat-sidebar/chat-sidebar';
import { TurnBlock } from '../chats/turn-block/turn-block';
import { DatabasePanel } from './database-panel/database-panel';
import { DesignPanel } from './design-panel/design-panel';
import { FilesPanel } from './files-panel/files-panel';
import { PreviewPanel } from './preview-panel/preview-panel';

describe('workspace render path', () => {
  it.each([
    ['turn block', TurnBlock],
    ['chat conversation', ChatConversation],
    ['chat sidebar', ChatSidebar],
    ['preview panel', PreviewPanel],
    ['files panel', FilesPanel],
    ['database panel', DatabasePanel],
    ['design panel', DesignPanel],
  ])('uses OnPush change detection for the %s', (_name, component) => {
    const definition = (component as unknown as { ɵcmp: { onPush: boolean } }).ɵcmp;
    expect(definition.onPush).toBe(true);
  });
});
