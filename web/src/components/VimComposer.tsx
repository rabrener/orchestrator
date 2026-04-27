import { useEffect, useRef } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onExitVim: () => void;
}

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg-elev-2)",
    color: "var(--text)",
    height: "100%",
    fontSize: "var(--font-size-chat)",
  },
  ".cm-content": {
    fontFamily: "var(--mono)",
    caretColor: "var(--accent)",
    padding: "10px 12px",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-fat-cursor": {
    background: "var(--accent)",
    outline: "none",
    color: "var(--bg)",
  },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--border-strong)",
  },
  ".cm-panels": {
    background: "var(--bg-elev)",
    color: "var(--text-dim)",
    fontFamily: "var(--mono)",
    fontSize: "11px",
  },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
});

let vimCommandsRegistered = false;
function registerVimCommands(handlers: { submit: () => void; exit: () => void }): void {
  // Vim's command map is global; rebind handlers each mount via a ref-style dispatch.
  vimCommandsRegistered = true;
  Vim.defineEx("send", "send", () => handlers.submit());
  Vim.defineEx("w", "w", () => handlers.submit());
  Vim.defineEx("wq", "wq", () => handlers.submit());
  Vim.defineEx("q", "q", () => handlers.exit());
}

export function VimComposer({ value, onChange, onSubmit, onExitVim }: Props) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const submitRef = useRef(onSubmit);
  const exitRef = useRef(onExitVim);
  submitRef.current = onSubmit;
  exitRef.current = onExitVim;

  useEffect(() => {
    if (!vimCommandsRegistered) {
      registerVimCommands({
        submit: () => submitRef.current(),
        exit: () => exitRef.current(),
      });
    }
  }, []);

  useEffect(() => {
    // Auto-focus on mount and drop straight into insert mode for typing flow.
    const view = ref.current?.view;
    if (!view) return;
    view.focus();
    const cm = getCM(view);
    if (cm) Vim.handleKey(cm, "i", "");
  }, []);

  return (
    <div className="vim-composer">
      <div className="vim-composer-bar">
        <span className="vim-composer-tag">VIM</span>
        <span className="vim-composer-hint">
          <kbd>:w</kbd> send · <kbd>:q</kbd> exit · <kbd>Ctrl+G</kbd> toggle
        </span>
      </div>
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        extensions={[vim(), editorTheme, EditorView.lineWrapping]}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
        height="100%"
        className="vim-cm"
      />
    </div>
  );
}
