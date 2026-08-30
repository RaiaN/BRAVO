import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import UserMessage from './messages/UserMessage';
import AgentMessage from './messages/AgentMessage';
import ToolResult from './messages/ToolResult';
import ApprovalCard from './messages/ApprovalCard';
import { STATES, stateOf, subjectOf } from '../state/project';

// THE THREAD PANE (§2) — the transcript, newest at the bottom, composer pinned below.
// No tabs inside the pane, no inspector panels, no floating windows.
//
// SELECTION IS IMPLICIT: this thread is the subject of everything typed here. There is
// never a "select something first".

const MAX_COMPOSER_PX = 232;   // ~8 lines, then the composer scrolls instead of growing

function Composer({ onSend, subjectLabel, busy, text, setText }) {
  const ref = useRef(null);

  // Grow to fit, then stop and scroll. Measured from a reset height so deleting a line
  // shrinks it back — reading scrollHeight without the reset only ever grows.
  //
  // An EMPTY composer is never measured. The first layout effect can run before the
  // frame has settled, and a scrollHeight read then comes back wildly too large — which
  // clamps to MAX and leaves an empty box eight lines tall. Nothing needs measuring to
  // know that no text is one line, so CSS owns the resting height and JS only ever grows
  // it once there is content to grow around.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    if (!text) {
      el.style.removeProperty('height');   // back to the CSS one-liner
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_PX ? 'auto' : 'hidden';
  };
  useLayoutEffect(fit, [text]);

  const send = () => {
    const body = text.trim();
    if (!body || busy) return;
    onSend(body);
    setText('');
  };

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter is a newline. A composing IME (Japanese, Chinese, Korean)
    // uses Enter to accept its candidate — sending there would eat the word.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="dock">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={busy}
          placeholder={busy ? 'the agent is working…' : `message the agent about ${subjectLabel}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message the agent"
        />
        <button
          type="button"
          className="send"
          onClick={send}
          disabled={!text.trim() || busy}
          title="Send (Return) · Shift+Return for a newline"
          aria-label="Send"
        >
          ⏎
        </button>
      </div>
      <style jsx>{`
        .dock {
          flex: none;
          padding: 8px 0 20px;
          background: linear-gradient(to bottom, transparent, var(--canvas) 22px);
        }
        .composer {
          display: flex; align-items: flex-end; gap: 8px;
          width: min(var(--pane-w), 100%); margin: 0 auto;
          padding: 8px 8px 8px 15px;
          background: var(--raised);
          border: 1px solid var(--line);
          border-radius: 15px;
          box-shadow: var(--shadow-soft);
          transition: border-color 0.15s ease;
        }
        .composer:focus-within { border-color: rgba(201, 100, 66, 0.45); }
        textarea {
          flex: 1; min-width: 0;
          padding: 6px 0; border: 0; outline: none; resize: none;
          background: transparent; line-height: 1.55;
          /* The resting size, owned by CSS so an empty composer is correct on the very
             first paint with no measurement involved. rows=1 supplies the line. */
          height: auto; overflow-y: hidden;
          max-height: ${MAX_COMPOSER_PX}px;
        }
        textarea::placeholder { color: var(--faint); }
        .send {
          flex: none; width: 30px; height: 30px; border-radius: 9px;
          display: grid; place-items: center;
          background: var(--accent); color: var(--accent-ink);
          font-size: 14px; line-height: 1;
          transition: opacity 0.15s ease;
        }
        .send:disabled { opacity: 0.28; cursor: default; }
      `}</style>
    </div>
  );
}

// Titles are the film's index — the seeded shot has none, so it is edited here rather
// than left as a permanent "—". Escape abandons, Return and blur commit.
function Title({ label, title, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const ref = useRef(null);

  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);

  const commit = () => { setEditing(false); if (draft.trim() !== title) onRename(draft.trim()); };

  return (
    <h1 className="title">
      <span className="n tnum">{label}</span>
      <span className="dot" aria-hidden="true">·</span>
      {editing ? (
        <input
          ref={ref}
          value={draft}
          placeholder="name this shot"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(title); setEditing(false); }
          }}
          aria-label="Shot title"
        />
      ) : (
        <button type="button" className="name" onClick={() => setEditing(true)} title="Rename this shot">
          {title || <span className="none">—</span>}
        </button>
      )}
      <style jsx>{`
        .title {
          display: flex; align-items: baseline; gap: 8px;
          margin: 0; min-width: 0;
          font-size: 15px; font-weight: 550; letter-spacing: -0.005em;
        }
        .n   { color: var(--muted); font-weight: 500; }
        .dot { color: var(--faint); }
        .name {
          padding: 1px 5px; margin-left: -5px; border-radius: 6px;
          font-weight: 550; text-align: left;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .name:hover { background: var(--hover); }
        .none { color: var(--faint); font-weight: 400; }
        input {
          flex: 1; min-width: 0;
          padding: 1px 5px; margin-left: -5px;
          border: 0; outline: none; border-radius: 6px;
          background: var(--hover); font-weight: 550;
        }
      `}</style>
    </h1>
  );
}

export default function Thread({ project, thread, onSend, onRename, onDraft, onApprove, onCancel }) {
  const scroller = useRef(null);
  const restored = useRef({ threadId: null, ids: null });
  const subject = subjectOf(project, thread);
  const messages = thread?.messages || [];

  // Newest at the bottom: pin the scroll there whenever a turn lands. Declared before the
  // early return below so the hook order is the same on every render.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thread?.id]);

  // A resize reflows the transcript taller or shorter under a fixed scrollTop, which
  // walks the newest turn off the bottom edge. Re-pin — but only for a reader who was
  // already at the bottom, so resizing while reading history does not yank them away.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let atBottom = true;
    const NEAR = 48;                       // px of slack: "at the bottom" by intent
    const track = () => { atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR; };
    const repin = () => { if (atBottom) el.scrollTop = el.scrollHeight; };
    el.addEventListener('scroll', track, { passive: true });
    const ro = new ResizeObserver(repin);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', track); ro.disconnect(); };
  }, [thread?.id]);

  if (!thread) {
    return (
      <main className="pane">
        <p className="void">No thread is open.</p>
        <style jsx>{`
          .pane { flex: 1; display: grid; place-items: center; background: var(--canvas); }
          .void { color: var(--muted); }
        `}</style>
      </main>
    );
  }

  // Is anyone actually looking? Read at render time: a turn that arrives in a hidden tab
  // must not depend on an animation that will not run.
  const watching = typeof document === 'undefined' || document.visibilityState === 'visible';

  // The transcript as it arrived from the store. Everything in this set was already
  // there when the thread opened, so it renders plainly; anything that appears later is
  // a turn landing in front of you and gets the entry animation.
  if (restored.current.threadId !== thread.id) {
    restored.current = { threadId: thread.id, ids: new Set(messages.map((m) => m.id)) };
  }

  // §8 forbids substituting a default: the label comes from this thread's own subject,
  // and a subject the film does not hold yields no number rather than someone else's.
  const position = project.film.shots.findIndex((s) => s.id === thread.subjectId);
  const label = !thread.kind
    ? '＋'
    : (thread.kind === 'bible' ? '◆' : (position >= 0 ? String(position + 1).padStart(2, '0') : '—'));

  const state = stateOf(project, thread);
  const busy = thread.status === 'working';

  return (
    <main className="pane">
      <header className="head drag">
        {thread.kind
          ? <Title label={label} title={subject?.title || ''} onRename={onRename} />
          : <h1 className="title unset"><span className="n">＋</span> new thread</h1>}
        <span className={`state ${state}`}>
          {STATES[state].glyph} {thread.kind ? STATES[state].label : 'unrouted'}
        </span>
      </header>

      <div className="scroll transcript" ref={scroller}>
        <div className="measure">
          {messages.length === 0 ? (
            <div className="opening">
              <p className="lede">
                {thread.kind
                  ? (subject?.title ? `${label} · ${subject.title}` : `${label} has no title yet.`)
                  : 'What is this one about?'}
              </p>
              <p className="sub">
                {thread.kind
                  ? 'This thread owns one artifact and nothing else. Say what you want and the agent works here.'
                  : 'A thread starts blank. Say what you want — a shot, an edit, a storyboard, a bible entry — and it becomes that agent\u2019s thread.'}
              </p>
            </div>
          ) : messages.map((m) => {
            // Animate only a turn that lands in front of a watching reader. A hidden tab
            // freezes animations mid-flight, and a frozen fade-in is an invisible
            // message — so when nobody is looking the turn simply appears.
            const enter = !restored.current.ids.has(m.id) && watching;
            if (m.role === 'tool') {
              // An unapproved card is a decision, not a result (§6).
              if (m.tool?.card && !m.tool.approved && !m.tool.output) {
                return <ApprovalCard key={m.id} message={m} busy={busy} onApprove={() => onApprove(m.id)} onCancel={() => onCancel(m.id)} />;
              }
              return <ToolResult key={m.id} message={m} />;
            }
            return m.role === 'user'
              ? <UserMessage key={m.id} message={m} enter={enter} />
              : <AgentMessage key={m.id} message={m} enter={enter} />;
          })}

          {busy && (
            <p className="working"><span className="spin" aria-hidden="true">⟳</span> working…</p>
          )}
        </div>
      </div>

      <Composer
        onSend={onSend}
        busy={busy}
        text={thread.draft || ''}
        setText={onDraft}
        subjectLabel={thread.kind ? (subject?.title ? `\u201c${subject.title}\u201d` : `shot ${label}`) : 'anything'}
      />

      <style jsx>{`
        .pane {
          flex: 1; min-width: 0;
          display: flex; flex-direction: column; min-height: 0;
          background: var(--canvas);
        }
        .head {
          flex: none;
          display: flex; align-items: center; justify-content: space-between; gap: 16px;
          height: 54px;
          padding: var(--chrome-h) 24px 0 20px;
          box-sizing: content-box;
          border-bottom: 1px solid var(--line-soft);
        }
        .state {
          flex: none; font-size: 11.5px; letter-spacing: 0.02em; color: var(--muted);
        }
        .state.working  { color: var(--state-working); }
        .state.needs-you{ color: var(--state-needs); }
        .state.settled  { color: var(--state-settled); }
        .state.stale    { color: var(--state-stale); }

        .transcript { flex: 1; min-height: 0; padding: 0 24px; }
        .measure {
          width: min(var(--pane-w), 100%); margin: 0 auto;
          padding: 26px 0 8px;
          display: flex; flex-direction: column;
        }
        .opening { padding: 44px 0 8px; }
        .lede { margin: 0 0 6px; font-size: 22px; font-weight: 500; letter-spacing: -0.015em; }
        .sub  { margin: 0; max-width: 46ch; color: var(--muted); }
        .working {
          display: flex; align-items: center; gap: 7px;
          margin: 14px 0 0; font-size: 12.5px; color: var(--state-working);
        }
        .spin { display: inline-block; animation: bravo-spin 1.6s linear infinite; }
        .unset { color: var(--muted); font-weight: 500; }
        .unset .n { color: var(--faint); }
      `}</style>
    </main>
  );
}
