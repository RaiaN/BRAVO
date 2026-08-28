// Seedream-supported output dimensions, by resolution tier × aspect ratio.
// Values are the exact "WxH" pixel strings the API accepts as `size`. Picking an
// aspect ratio that matches your intended shot keeps subject proportions intact —
// e.g. don't blend a full-body portrait reference into a square frame.

export const SEEDREAM_SIZES = {
  '2K': {
    '1:1': '2048x2048',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
    '16:9': '2848x1600',
    '9:16': '1600x2848',
    '3:2': '2496x1664',
    '2:3': '1664x2496',
    '21:9': '3136x1344',
  },
  '3K': {
    '1:1': '3072x3072',
    '4:3': '3456x2592',
    '3:4': '2592x3456',
    '16:9': '4096x2304',
    '9:16': '2304x4096',
    '3:2': '3744x2496',
    '2:3': '2496x3744',
    '21:9': '4704x2016',
  },
  '4K': {
    '1:1': '4096x4096',
    '4:3': '4704x3520',
    '3:4': '3520x4704',
    '16:9': '5504x3040',
    '9:16': '3040x5504',
    '3:2': '4992x3328',
    '2:3': '3328x4992',
    '21:9': '6240x2656',
  },
};

export const SIZE_TIERS = Object.keys(SEEDREAM_SIZES);          // ['2K','3K','4K']
export const ASPECT_RATIOS = Object.keys(SEEDREAM_SIZES['2K']); // 1:1, 4:3, … 21:9

// Resolve a (tier, ratio) pair to a Seedream "WxH" size string. Degrades safely:
// unknown ratio → the tier's 1:1; unknown tier → the value as-is, so an already
// resolved "2848x1600" or a legacy bare tier ("1K"/"2K") passes straight through.
export const resolveImageSize = (tier, ratio = '1:1') => {
  const tierMap = SEEDREAM_SIZES[tier];
  if (!tierMap) return tier;
  return tierMap[ratio] || tierMap['1:1'];
};
