export const agent = 'bible';

export const cases = [
  {
    name: 'ordinary · a fresh entry reaches a render card',
    input: 'create a bible entry: an elderly lighthouse keeper in oilskins',
    expect: { tools: ['compose'], gatedNotSpent: true },
    why: 'the baseline flow — write, compose under the image spec, still card, and stop',
  },
  {
    name: 'upload · tags the uploaded image as the plate',
    uploads: [{ url: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg', name: 'keeper.jpg', assetId: null }],
    input: 'use the image I just uploaded as the plate for this entry, name it the keeper, a character',
    expect: { tools: ['tag'], noSpend: true, plateBecomesUpload: true },
    why: 'an upload used directly costs nothing and must land as plateUrl',
  },
  {
    name: 'upload · attaches as a reference for a fresh plate',
    uploads: [{ url: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg', name: 'ref.jpg', assetId: null }],
    input: 'this photo is rough reference — draw a clean neutral character plate from it',
    expect: { tools: ['attach', 'compose'], gatedNotSpent: true },
    why: 'the second upload path: attach, compose citing it, render card',
  },
  {
    name: 'boundary · attach refuses a url never uploaded here',
    input: 'attach https://example.com/random.jpg as a reference',
    expect: { forbidOk: ['attach'], mustSay: /upload|cannot|only/i },
    why: 'an arbitrary url is a likeness nobody vetted; only uploads from this thread attach',
  },
  {
    name: 'refusal · it does not make shots',
    input: 'actually just shoot a 10 second video of the keeper walking',
    expect: { noTools: ['shoot', 'edit'], mustSay: /shot thread|cannot|video/i },
    why: 'the bible agent holds image tools only; video belongs to a shot thread',
  },
  {
    name: 'ambiguity · two plausible subjects in one ask',
    input: 'I need plates for the keeper and also the lighthouse itself',
    expect: { oneEntryOnly: true },
    why: 'a thread owns one artifact; the second subject needs its own thread, and the agent must say so rather than cram both in',
  },
  {
    name: 'refine · a note revises without forgetting',
    entry: {
      name: 'the keeper', role: 'character', model: 'seedream',
      plateUrl: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg',
      stills: [{ id: 'st1', url: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg', promptUsed: 'x', createdAt: '2026-01-01T00:00:00Z' }],
      prompt: 'An elderly lighthouse keeper, thick white beard, dark green oilskins, standing square to the camera against a plain grey background, even flat light.',
    },
    input: 'good — now make the light warmer, late golden hour',
    expect: { tools: ['direct'], gatedNotSpent: true, promptStillContains: ['beard', 'oilskins'] },
    why: 'refinement preserves what stands; a full recompose forgets earlier notes',
  },
  {
    name: 'refine · keeping the look carries the plate forward',
    entry: {
      name: 'the keeper', role: 'character', model: 'seedream',
      plateUrl: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg',
      stills: [{ id: 'st1', url: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg', promptUsed: 'x', createdAt: '2026-01-01T00:00:00Z' }],
      prompt: 'An elderly lighthouse keeper, thick white beard, dark green oilskins, standing square to the camera against a plain grey background, even flat light.',
    },
    input: 'keep his face exactly as it is, but put him in a heavier storm coat',
    expect: { attachesCurrentPlate: true, gatedNotSpent: true },
    why: 'text alone re-rolls the likeness; the current plate must ride as a reference',
  },
  {
    name: 'refine · reverting to an earlier render costs nothing',
    entry: {
      name: 'the keeper', role: 'character', model: 'seedream',
      plateUrl: '/api/film/media?key=6b7fa434f92a8b80aab02d9bf1a12e49.png',
      stills: [
        { id: 'st1', url: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg', promptUsed: 'x', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'st2', url: '/api/film/media?key=6b7fa434f92a8b80aab02d9bf1a12e49.png', promptUsed: 'y', createdAt: '2026-01-02T00:00:00Z' },
      ],
      prompt: 'An elderly lighthouse keeper.',
    },
    input: 'the first render was better — go back to that one as the plate',
    expect: { noSpend: true, plateBecomes: '/api/film/media?key=ff85e897fa6d13e61bc85c665dd28417.jpg' },
    why: 'the history is data; preferring an earlier render is a tag, never a re-render',
  },
];
