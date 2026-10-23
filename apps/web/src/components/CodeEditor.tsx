import { lazy, Suspense, useState } from 'react';
import type { Language } from '../lib/types';

const MonacoEditor = lazy(() => import('./MonacoEditor'));
export function CodeEditor({ code, language, readOnly, onChange }: { code: string; language: Language; readOnly?: boolean; onChange(code: string): void }) {
  const [plain, setPlain] = useState(import.meta.env.MODE === 'test');
  const fallback = <textarea aria-label="Code editor" className="plain-editor" value={code} onChange={event => onChange(event.target.value)} spellCheck={false} readOnly={readOnly} />;
  return <div className="code-editor">
    <div className="editor-toolbar"><span className="file-tab"><span className="file-dot" />solution.{language === 'python' ? 'py' : 'js'}</span><button className="editor-mode" onClick={() => setPlain(!plain)}>{plain ? 'Use Monaco' : 'Use plain editor'}</button></div>
    {plain ? fallback : <Suspense fallback={fallback}><MonacoEditor code={code} language={language} readOnly={readOnly} onChange={onChange} onFailure={() => setPlain(true)} /></Suspense>}
  </div>;
}
