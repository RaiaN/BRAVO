// A rendered take, playable inline (§2: tool results render inline and visual — never a
// wall of text where a picture is the answer).
export default function TakePlayer({ take }) {
  if (!take?.url) return null;
  return (
    <figure className="take">
      <video src={take.url} poster={take.posterUrl || undefined} controls preload="metadata" playsInline />
      <figcaption>
        {take.model} · {take.resolution}
        {take.duration && take.duration !== 'auto' ? ` · ${take.duration}s` : ''}
        {take.editedFrom ? ' · edited' : ''}
        {take.ms ? ` · ${Math.round(take.ms / 1000)}s to render` : ''}
      </figcaption>
      <style jsx>{`
        .take { margin: 0; }
        video { width: 100%; max-height: 460px; border-radius: 10px; background: #000; display: block; }
        figcaption { margin-top: 5px; font-size: 11.5px; color: var(--faint); }
      `}</style>
    </figure>
  );
}
