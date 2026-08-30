import { useEffect, useMemo, useState } from 'react';
import {
  addSkill, allSkills, hydrateSkills, removeSkill, resetSkill,
  setSkillModels, setSkillText, skillTokens,
} from '../utils/film/skills';
import { ROOT_CONFIG } from '../utils/film/suiteConfig';

const SLOTS = Object.keys(ROOT_CONFIG.models);

export default function SkillsScreen({ onClose }) {
  const [skills, setSkills] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState('');
  const [tick, setTick] = useState(0);
  const [lock, setLock] = useState({});
  const [lockError, setLockError] = useState(null);

  useEffect(() => { hydrateSkills().then(() => setSkills(allSkills())); }, []);
  useEffect(() => {
    fetch('/api/skills-lock')
      .then((r) => r.json())
      .then((j) => setLock(j.skills || {}))
      .catch((err) => setLockError(err.message));
  }, []);
  useEffect(() => { setSkills(allSkills()); }, [tick]);

  const open = useMemo(() => skills.find((s) => s.id === openId) || null, [skills, openId]);
  const refresh = () => setTick((t) => t + 1);

  const unbound = SLOTS.filter((slot) => !skills.some((s) => (s.models || []).includes(slot) && String(s.text || '').trim()));

  const startEdit = (s) => { setOpenId(s.id); setDraft(s.text || ''); };
  const save = () => { setSkillText(open.id, draft); refresh(); };

  return (<main className="screen">
      <header className="head drag">
        <h1>Skills</h1>
        <button type="button" className="close" onClick={onClose}>done</button>
      </header>

      <div className="scroll body">
        <div className="measure">
          <p className="lede">
            A skill is a vendor prompt spec bound to model slots and sent <b>verbatim</b> in
            the system prompt of every call that model makes. A slot with nothing bound
            refuses to compose — there is no fallback and no house style.
          </p>

          {lockError && (
            <p className="warn">Provenance unavailable ({lockError}) — vendor and local specs cannot be told apart below.</p>
          )}

          {unbound.length > 0 && (<p className="warn">
              Unbound: {unbound.join(', ')}. Any shot on those slots will refuse to compose.
            </p>
          )}

          {skills.map((s) => (<section key={s.id} className={`skill${openId === s.id ? ' open' : ''}`}>
              <div className="row">
                <button type="button" className="name" onClick={() => (openId === s.id ? setOpenId(null) : startEdit(s))}>
                  <span className="id">{s.name || s.id}</span>
                  <span className="weight tnum">{skillTokens(s.text).toLocaleString()} tok</span>
                  {lock[s.id] && <span className={`badge src ${lock[s.id].sourceType}`}>{lock[s.id].sourceType}</span>}
                  {s.source === 'custom' && <span className="badge">yours</span>}
                  {s.edited && <span className="badge edited">edited</span>}
                  {(s.models || []).length === 0 && <span className="badge unbound">unbound</span>}
                </button>
                <div className="acts">
                  {s.edited && s.source === 'disk' && (<button type="button" onClick={() => { resetSkill(s.id); setOpenId(null); refresh(); }}>reset to disk</button>
                  )}
                  {s.source === 'custom' && (<button type="button" className="danger" onClick={() => { removeSkill(s.id); setOpenId(null); refresh(); }}>remove</button>
                  )}
                </div>
              </div>

              {s.description && <p className="desc">{s.description}</p>}
              {lock[s.id]?.note && <p className="prov">{lock[s.id].note} <span className="from">— {lock[s.id].source}</span></p>}

              <div className="binds">
                {SLOTS.map((slot) => {
                  const on = (s.models || []).includes(slot);
                  return (<button
                      key={slot}
                      type="button"
                      className={`bind${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        const next = on ? (s.models || []).filter((m) => m !== slot) : [...(s.models || []), slot];
                        setSkillModels(s.id, next);
                        refresh();
                      }}
                    >
                      {slot}
                    </button>
                  );
                })}
              </div>

              {openId === s.id && (<div className="editor">
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
                  <div className="editacts">
                    <button type="button" className="save" onClick={save}>save</button>
                    <span className="cnt tnum">{draft.length.toLocaleString()} chars · {Math.round(draft.length / 4).toLocaleString()} tok</span>
                  </div>
                </div>
              )}
            </section>
          ))}

          <button
            type="button"
            className="add"
            onClick={() => { const e = addSkill({ name: 'new skill', text: '', models: [] }); refresh(); startEdit({ ...e, text: '' }); }}
          >
            + add your own
          </button>
        </div>
      </div>

      <style jsx>{`
        .screen { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: var(--canvas); }
        .head {
          flex: none; display: flex; align-items: center; justify-content: space-between;
          height: 54px; padding: var(--chrome-h) 24px 0 24px; box-sizing: content-box;
          border-bottom: 1px solid var(--line-soft);
        }
        h1 { margin: 0; font-size: 15px; font-weight: 550; }
        .close { font-size: 13px; color: var(--muted); }
        .close:hover { color: var(--ink); }
        .body { flex: 1; min-height: 0; padding: 0 24px 32px; }
        .measure { width: min(var(--pane-w), 100%); margin: 0 auto; padding: 22px 0; }
        .lede { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; line-height: 1.6; }
        .warn {
          margin: 0 0 16px; padding: 8px 11px; border-radius: 8px;
          background: var(--accent-wash); color: var(--accent); font-size: 12.5px;
        }
        .skill { border: 1px solid var(--line); border-radius: 11px; padding: 11px 13px; margin-bottom: 9px; background: var(--raised); }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .name { display: flex; align-items: baseline; gap: 9px; text-align: left; }
        .id { font-size: 13.5px; font-weight: 600; }
        .weight { font-size: 11px; color: var(--faint); }
        .badge { font-size: 10px; padding: 0 5px; border-radius: 4px; background: var(--hover); color: var(--muted); }
        .edited { color: var(--state-working); }
        .src.vendor      { background: rgba(92,138,92,.16); color: var(--state-settled); }
        .src.starter-kit { background: var(--hover); color: var(--muted); }
        .src.bravo       { background: var(--accent-wash); color: var(--accent); }
        .unbound { background: rgba(176,74,61,.14); color: var(--state-stale); }
        .prov { margin: 5px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--faint); }
        .from { opacity: .75; }
        .acts { display: flex; gap: 10px; }
        .acts button { font-size: 11.5px; color: var(--muted); }
        .acts button:hover { color: var(--ink); }
        .danger:hover { color: var(--state-stale) !important; }
        .desc { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
        .binds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 9px; }
        .bind {
          padding: 2px 8px; border-radius: 999px; font-size: 11px;
          background: var(--hover); color: var(--muted);
        }
        .bind.on { background: var(--accent); color: var(--accent-ink); }
        .editor { margin-top: 10px; }
        textarea {
          width: 100%; height: 340px; padding: 10px;
          border: 1px solid var(--line); border-radius: 9px; outline: none; resize: vertical;
          background: var(--canvas);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55;
        }
        .editacts { display: flex; align-items: center; gap: 12px; margin-top: 7px; }
        .save { padding: 5px 13px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-size: 12.5px; }
        .cnt { font-size: 11px; color: var(--faint); }
        .add { margin-top: 6px; padding: 7px 12px; border-radius: 9px; font-size: 13px; color: var(--muted); }
        .add:hover { background: var(--hover); color: var(--ink); }
      `}</style>
    </main>
  );
}
