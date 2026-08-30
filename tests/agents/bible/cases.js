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
];
