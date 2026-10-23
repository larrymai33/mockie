import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import type { Language } from '../lib/types';

self.MonacoEnvironment = { getWorker(_moduleId: string, label: string) { return label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker(); } };
loader.config({ monaco });
monaco.editor.defineTheme('mockie', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '80978B' }, { token: 'keyword', foreground: 'E0BF88' }, { token: 'string', foreground: 'AFC5AE' }], colors: { 'editor.background': '#101713', 'editor.foreground': '#E4E7DF', 'editorLineNumber.foreground': '#65756B', 'editorLineNumber.activeForeground': '#D4DBD2', 'editor.selectionBackground': '#284C3C', 'editor.lineHighlightBackground': '#18231C', 'editorCursor.foreground': '#E09A32' } });
export default function MonacoEditor({ code, language, readOnly, onChange }: { code: string; language: Language; readOnly?: boolean; onChange(code: string): void; onFailure(): void }) {
  return <Editor height="100%" language={language} value={code} theme="mockie" onChange={value => onChange(value ?? '')} options={{ ariaLabel: 'Code editor', readOnly, fontFamily: 'IBM Plex Mono, Consolas, monospace', fontSize: 14, lineHeight: 24, minimap: { enabled: false }, padding: { top: 24, bottom: 24 }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4, renderLineHighlight: 'gutter', overviewRulerLanes: 0, smoothScrolling: false }} />;
}
