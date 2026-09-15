import { useEffect, useRef, useState } from 'react';

const STORAGE = 'bravo.extend';
const recall = () => { try { return JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch { return {}; } };
const remember = (patch) => { try { localStorage.setItem(STORAGE, JSON.stringify({ ...recall(), ...patch })); } catch { } };

export default function AgentSidebar() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(null);
  const [revision, setRevision] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [fields, setFields] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toggle = useRef(null);
  const closeButton = useRef(null);
  const wasOpen = useRef(false);
  const initialized = useRef(false);
  const dirty = config && JSON.stringify(config) !== saved;

  const load = async (restoreDraft = false) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/agents');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load agent settings');
      const stored = recall();
      const draft = restoreDraft ? stored.agentsDraft : null;
      let next = draft?.config || data.config;
      if (restoreDraft && !draft && stored.personaDraft) next = { ...next, persona: { ...next.persona, ...stored.personaDraft } };
      setConfig(next); setSaved(JSON.stringify(data.config)); setRevision(draft?.revision || data.revision);
      setDefaults(data.defaults); setFields(data.fields);
      setNote(JSON.stringify(next) !== JSON.stringify(data.config) ? 'Unsaved edits restored. Save to use them in the next run.' : '');
      if (!restoreDraft) remember({ agentsDraft: null, personaDraft: null });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    load(true);
  }, []);
  useEffect(() => {
    if (config && saved) remember({ agentsDraft: dirty ? { config, revision } : null });
  }, [config, saved, dirty, revision]);
  useEffect(() => {
    if (open) closeButton.current?.focus();
    else if (wasOpen.current) toggle.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = () => setOpen(false);
  const save = async () => {
    setBusy(true); setNote(''); setError('');
    try {
      const response = await fetch('/api/agents', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save agent settings');
      setConfig(data.config); setSaved(JSON.stringify(data.config)); setRevision(data.revision);
      remember({ agentsDraft: null, personaDraft: null });
      setNote('Saved and journaled. These settings apply to the next run.');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const groups = config && fields ? [
    { key: 'persona', title: 'Persona', description: 'Reviews takes and selects the improvement receipt.', value: config.persona, fields: fields.persona },
    ...config.qc.map((agent, index) => ({ key: agent.id, title: agent.name, description: 'Independent film QC agent.', value: agent, fields: fields.qc, index })),
    { key: 'planner', title: 'Shot planner', description: 'Turns the story into a sequence of shots.', value: config.planner, fields: fields.planner },
    { key: 'variator', title: 'Take variations', description: 'Creates distinct render prompts for each shot.', value: config.variator, fields: fields.variator },
  ] : [];
  const replace = (group, value) => setConfig((current) => group.index === undefined
    ? { ...current, [group.key]: value }
    : { ...current, qc: current.qc.map((agent, index) => index === group.index ? value : agent) });

  return (
    <aside className={`agent-sidebar${open ? ' expanded' : ''}`} aria-label="Agent settings" onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(); } }}>
      <button ref={toggle} type="button" className="toggle" aria-expanded={open} aria-controls="agent-settings" onClick={() => setOpen(!open)}>
        {open ? '›' : '‹'} Agents{dirty ? ' •' : ''}
      </button>
      <div id="agent-settings" className="drawer" hidden={!open}>
        <div className="heading">
          <h2>Agents</h2>
          <button ref={closeButton} type="button" className="ghost" onClick={close} aria-label="Collapse agent settings">Close ›</button>
        </div>
        <p className="hint">Persona + five independent film QC agents.<br />Reasoning engine: Seed 2.0 Pro.</p>
        <p className="hint">Saved settings apply to the next run. Each run journals its exact configuration, prompts, responses and decisions.</p>
        {groups.map((group) => (
          <details key={group.key}>
            <summary>{group.title}</summary>
            <p className="hint">{group.description}</p>
            {group.fields.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                {field.singleLine
                  ? <input value={group.value[field.key]} onChange={(event) => replace(group, { ...group.value, [field.key]: event.target.value })} disabled={busy} maxLength={50000} />
                  : <textarea rows={field.key === 'focus' ? 3 : 7} value={group.value[field.key]} onChange={(event) => replace(group, { ...group.value, [field.key]: event.target.value })} disabled={busy} spellCheck={false} maxLength={50000} />}
                {!!field.placeholders?.length && <small>Placeholders: {field.placeholders.map((key) => `{${key}}`).join(' ')}</small>}
              </label>
            ))}
            <button type="button" className="ghost" disabled={busy} onClick={() => replace(group, structuredClone(group.index === undefined ? defaults[group.key] : defaults.qc.find((agent) => agent.id === group.key)))}>Restore this agent’s defaults</button>
          </details>
        ))}
        <div className="actions">
          <button type="button" className="save" onClick={save} disabled={!dirty || busy}>{busy ? 'Working…' : 'Save agents'}</button>
          <button type="button" className="ghost" onClick={() => load(false)} disabled={busy}>Reload saved</button>
        </div>
        {note && <p className="hint" role="status">{note}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <style jsx>{`
        .agent-sidebar { width: 88px; flex: none; margin-left: auto; position: sticky; top: 0; align-self: flex-start; }
        .agent-sidebar.expanded { width: 380px; }
        .toggle { width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised); color: var(--ink); font-size: 13px; }
        .expanded .toggle { display: none; }
        .drawer { max-height: calc(100dvh - 64px); overflow-y: auto; padding: 0 0 24px 20px; border-left: 1px solid var(--line-soft); }
        .drawer[hidden] { display: none; }
        .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        h2 { font-size: 16px; margin: 0; }
        .hint, small { color: var(--muted); font-size: 12px; line-height: 1.5; }
        details { border-top: 1px solid var(--line-soft); padding: 12px 0; }
        summary { cursor: pointer; font-size: 13px; font-weight: 550; overflow-wrap: anywhere; }
        label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; font-size: 12px; }
        input, textarea { width: 100%; box-sizing: border-box; font: inherit; line-height: 1.45; color: var(--ink); background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; }
        textarea { resize: vertical; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
        button { cursor: pointer; }
        button:disabled { opacity: .5; cursor: default; }
        button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
        .ghost, .save { padding: 8px 10px; border-radius: var(--radius); font-size: 12px; }
        .ghost { border: 1px solid var(--line); background: transparent; color: var(--ink-soft); }
        .save { background: var(--accent); color: var(--accent-ink); }
        .error { font-size: 12px; color: var(--state-stale); line-height: 1.5; }
        @media (max-width: 1080px) {
          .agent-sidebar { position: fixed; right: 16px; top: 16px; z-index: 30; }
          .agent-sidebar.expanded { width: min(400px, calc(100vw - 24px)); height: calc(100dvh - 24px); top: 12px; right: 12px; background: var(--rail); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 40px #0003; }
          .drawer { height: 100%; max-height: 100%; box-sizing: border-box; border: 0; padding: 16px; }
        }
      `}</style>
    </aside>
  );
}
