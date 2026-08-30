// Seedream stills, as a grid. One image is still a grid of one — the storyboard is the
// same component with more panels.
export default function StillGrid({ stills = [] }) {
  const list = stills.filter((s) => s?.url);
  if (!list.length) return null;
  return (
    <div className="grid">
      {list.map((s) => (
        <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="cell">
          <img src={s.url} alt={s.promptUsed?.slice(0, 120) || 'still'} loading="lazy" />
        </a>
      ))}
      <style jsx>{`
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 7px; }
        .cell { display: block; border-radius: 9px; overflow: hidden; background: var(--hover); }
        img { width: 100%; display: block; aspect-ratio: 16/9; object-fit: cover; }
      `}</style>
    </div>
  );
}
