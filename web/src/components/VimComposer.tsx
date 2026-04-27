import { useEffect, useRef } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** :wq → copy buffer into chat input, exit vim (does NOT send) */
  onAcceptAndExit: () => void;
  /** :q! → discard buffer, restore pre-vim chat input, exit */
  onDiscardAndExit: () => void;
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
  getValue: () => string;
  getCM: () => ReturnType<typeof getCM> | null;
};
const liveHandlers: { current: VimHandlers | null } = { current: null };
let vimCommandsRegistered = false;
function ensureVimCommandsRegistered(): void {
  if (vimCommandsRegistered) return;
  vimCommandsRegistered = true;

  // :w — explicit no-op. Inserting from vim into the chat input must be intentional.
  Vim.defineEx("w", "w", () => {
    showVimMessage(
      liveHandlers.current?.getCM(),
      "use :wq to copy buffer into chat input, or click send",
      2500,
    );
  });

  // :wq — populate chat input with the vim buffer and exit vim. Does NOT send.
  Vim.defineEx("wq", "wq", () => liveHandlers.current?.accept());

  // :q — exit only if buffer is empty. Otherwise show vim's classic error.
  Vim.defineEx("q", "q", () => {
    const h = liveHandlers.current;
    if (!h) return;
    if (h.getValue().trim() === "") {
      h.discard();
    } else {
      showVimMessage(
        h.getCM(),
        "E37: No write since last change (add ! to override)",
        3000,
      );
    }
  });

  // :q! — discard the buffer and restore the chat input to its pre-vim state.
  Vim.defineEx("q!", "q!", () => liveHandlers.current?.discard());
}

export function VimComposer({ value, onChange, onAcceptAndExit, onDiscardAndExit }: Props) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    ensureVimCommandsRegistered();
    liveHandlers.current = {
      accept: () => onAcceptAndExit(),
      discard: () => onDiscardAndExit(),
      getValue: () => valueRef.current,
      getCM: () => (ref.current?.view ? getCM(ref.current.view) : null),
    };
    return () => {
      if (liveHandlers.current && liveHandlers.current.accept === onAcceptAndExit) {
        liveHandlers.current = null;
      }
    };
  }, [onAcceptAndExit, onDiscardAndExit]);

  useEffect(() => {
    // Drop straight into insert mode after the editor mounts. The autoFocus
    // prop on <CodeMirror> handles the actual focus; we just retry until the
    // view is available so `i` lands in the right place.
    let cancelled = false;
    const tryEnterInsert = () => {
      if (cancelled) return;
      const view = ref.current?.view;
      if (!view) {
        requestAnimationFrame(tryEnterInsert);
        return;
      }
      view.focus();
      const cm = getCM(view);
      if (cm) Vim.handleKey(cm, "i", "");
    };
    requestAnimationFrame(tryEnterInsert);
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
