export type PermissionModeName = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images?: number; ts?: number }
  | { kind: 'assistant'; id: string; markdown: string; ts?: number }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      title: string;
      detail?: string;
      status: 'running' | 'done' | 'error' | 'denied';
      output?: string;
      file?: string;
      edit?: { added: number; removed: number };
      parentToolUseId?: string;
    }
  | { kind: 'system'; id: string; text: string; level: 'info' | 'warning' | 'error' };

export interface ModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface CommandOption {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface SessionHeader {
  sessionId?: string;
  title: string;
  cwd: string;
  projectName: string;
  branch?: string;
  entrypoint: string;
  readOnly: boolean;
  readOnlyReason?: string;
  canTakeOver?: boolean;
  model?: string;
  models: ModelOption[];
  permissionMode: PermissionModeName;
}

export interface RunStatus {
  state: 'idle' | 'starting' | 'working' | 'waiting' | 'error';
  detail?: string;
}

export interface PermissionRequestView {
  id: string;
  toolName: string;
  title: string;
  detail?: string;
  diff?: { path: string; before: string; after: string };
  canAllowForSession: boolean;
}

export interface QuestionView {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface QuestionRequestView {
  id: string;
  questions: QuestionView[];
}

export type HostToView =
  | { type: 'init'; header: SessionHeader; items: ChatItem[]; hiddenOlder: number; status: RunStatus }
  | { type: 'items'; items: ChatItem[] }
  | { type: 'header'; header: SessionHeader }
  | { type: 'status'; status: RunStatus }
  | { type: 'partial'; text: string | null }
  | { type: 'permission'; request: PermissionRequestView | null }
  | { type: 'question'; request: QuestionRequestView | null }
  | { type: 'error'; message: string }
  | { type: 'commands'; commands: CommandOption[] }
  | { type: 'restoreDraft'; text: string }
  | { type: 'focusComposer' };

export type PermissionDecision = 'allow' | 'allowSession' | 'deny';

export type ViewToHost =
  | { type: 'ready' }
  | { type: 'warm' }
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'setPermissionMode'; mode: PermissionModeName }
  | { type: 'setModel'; model: string }
  | { type: 'permissionResponse'; id: string; decision: PermissionDecision; message?: string }
  | { type: 'questionResponse'; id: string; answers: Record<string, string> | null }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openDiff'; path: string }
  | { type: 'openLink'; href: string }
  | { type: 'switchBranch' }
  | { type: 'openInTerminal' }
  | { type: 'takeOver' }
  | { type: 'showOlder' };
