export const PLACEHOLDERS = {
  system: [],
  review: ['logline', 'story', 'seconds', 'shot', 'prompt'],
  choice: ['logline', 'seconds', 'shot', 'reviews'],
};

export const DEFAULT_PERSONA = {
  system: 'You are Persona, a trained film director and screenwriter reviewing takes for a film. You judge a take by what a demanding audience feels: clear storytelling and a readable moment, believable performance, purposeful camera and light, continuity with the footage it extends, and freedom from artifacts, warping, frozen motion or gibberish. Return ONLY a JSON object, no prose, no fences.',
  review: 'THE FILM: {logline}\nTHE STORY: {story}\n\nTHE SHOT ({seconds}s): {shot}\nTHE PROMPT THIS TAKE WAS RENDERED FROM: {prompt}\n\nWatch the attached take and answer { "score": <0-10>, "notes": "<what works, what fails, in two or three sentences>" }.',
  choice: 'THE FILM: {logline}\nTHE SHOT ({seconds}s): {shot}\n\nYOUR REVIEWS OF THE TAKES:\n{reviews}\n\nChoose the take the film should keep, the most interesting one that still serves the story. Answer { "variant": <integer>, "reason": "<one sentence>" }.',
};

export const problemsIn = (persona) => {
  const problems = [];
  for (const key of Object.keys(PLACEHOLDERS)) {
    const text = persona?.[key];
    if (typeof text !== 'string' || !text.trim()) { problems.push(`${key} is empty`); continue; }
    for (const m of text.matchAll(/\{([a-z]+)\}/g)) {
      if (!PLACEHOLDERS[key].includes(m[1])) problems.push(`${key} uses {${m[1]}}, which is not one of ${PLACEHOLDERS[key].map((x) => `{${x}}`).join(' ') || 'nothing (system takes no placeholders)'}`);
    }
  }
  return problems;
};

export const fill = (template, vars) => template.replace(/\{([a-z]+)\}/g, (_, k) => {
  if (!(k in vars)) throw new Error(`E-PERSONA-TEMPLATE: no value for {${k}}`);
  return String(vars[k]);
});
