import { useEffect, useRef } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** :wq → copy buffer into chat input, exit vim (does NOT send) */
  onAcceptAndExit: () => void;
  /** :q! → discard buffer changes since last :w and exit. The argument is the
   * last-saved buffer state (== entry value if :w was never run). */
  onDiscardAndExit: (restoreText: string) => void;
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

// openNotification's TS signature insists on a Node. Wrap the string for it.
function showVimMessage(
  cm: ReturnType<typeof getCM> | null | undefined,
  text: string,
  duration: number,
): void {
  if (!cm) return;
  const node = document.createElement("span");
  node.textContent = text;
  cm.openNotification(node, { bottom: true, duration });
}

// Vim's command map is global; bind once and dispatch into refs that hold
// the latest mount's handlers so command callbacks always hit the live state.
type VimHandlers = {
  accept: () => void;
  discard: () => void;
  save: () => void;
  isDirty: () => boolean;
  getCM: () => ReturnType<typeof getCM> | null;
};
const liveHandlers: { current: VimHandlers | null } = { current: null };
let vimCommandsRegistered = false;
function ensureVimCommandsRegistered(): void {
  if (vimCommandsRegistered) return;
  vimCommandsRegistered = true;

  // :w — record the current buffer as the last-saved state. The chat input
  // isn't touched (use :wq for that), but a subsequent :q! will revert to
  // this snapshot rather than the pre-vim text.
  Vim.defineEx("w", "w", () => {
    const h = liveHandlers.current;
    if (!h) return;
    h.save();
    showVimMessage(h.getCM(), "buffer saved · :wq inserts into chat input", 2000);
  });

  // :wq / :wqall — populate chat input with the vim buffer and exit vim.
  // Does NOT send. The bang variants (:wq!, :wqall!) are accepted because
  // vim's parser strips the bang into params.argString.
  const acceptHandler = () => liveHandlers.current?.accept();
  Vim.defineEx("wq", "wq", acceptHandler);
  Vim.defineEx("wqall", "wqa", acceptHandler);

  // :q / :q! / :qall / :qall! — bang ⇒ force-discard, no bang ⇒ only discard
  // when the buffer hasn't changed since the last :w (or vim entry).
  const quitHandler = (_cm: unknown, params: { argString?: string } = {}) => {
    const h = liveHandlers.current;
    if (!h) return;
    const bang = (params.argString ?? "").trim().startsWith("!");
    if (bang || !h.isDirty()) {
      h.discard();
    } else {
      showVimMessage(
        h.getCM(),
        "E37: No write since last change (add ! to override)",
        3000,
      );
    }
  };
  Vim.defineEx("q", "q", quitHandler);
  Vim.defineEx("qall", "qa", quitHandler);
}

export function VimComposer({ value, onChange, onAcceptAndExit, onDiscardAndExit }: Props) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Tracks the last :w snapshot. Initialized to the entry value so :q exits
  // cleanly when the user hasn't edited anything yet, and so :q! restores
  // the entry value when :w was never run.
  const lastSavedRef = useRef(value);

  useEffect(() => {
    ensureVimCommandsRegistered();
    liveHandlers.current = {
      accept: () => onAcceptAndExit(),
      discard: () => onDiscardAndExit(lastSavedRef.current),
      save: () => {
        lastSavedRef.current = valueRef.current;
      },
      isDirty: () => valueRef.current !== lastSavedRef.current,
      getCM: () => (ref.current?.view ? getCM(ref.current.view) : null),
    };
    return () => {
      if (liveHandlers.current && liveHandlers.current.accept === onAcceptAndExit) {
        liveHandlers.current = null;
      }
    };
  }, [onAcceptAndExit, onDiscardAndExit]);

  useEffect(() => {
    // Focus the editor as soon as it's mounted; stay in normal mode so the
    // user can navigate / use ex commands without first pressing Esc.
    let cancelled = false;
    const tryFocus = () => {
      if (cancelled) return;
      const view = ref.current?.view;
      if (!view) {
        requestAnimationFrame(tryFocus);
        return;
      }
      view.focus();
    };
    requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="vim-composer">
      <div className="vim-composer-bar">
        <span className="vim-composer-tag">VIM</span>
        <span className="vim-composer-hint">
          <kbd>:wq</kbd> accept into chat · <kbd>:q!</kbd> discard
        </span>
      </div>
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        autoFocus
        extensions={[vim(), editorTheme, EditorView.lineWrapping]}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          // Disable CodeMirror's built-in keymaps that collide with vim
          // bindings (e.g. Ctrl+[ → indentLess, Ctrl+] → indentMore,
          // Ctrl+A → selectAll, Ctrl+Z → undo). Vim owns these.
          defaultKeymap: false,
          historyKeymap: false,
          searchKeymap: false,
          completionKeymap: false,
          foldKeymap: false,
          lintKeymap: false,
          closeBracketsKeymap: false,
          closeBrackets: false,
        }}
        height="100%"
        className="vim-cm"
      />
    </div>
  );
}
