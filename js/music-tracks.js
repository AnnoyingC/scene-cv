// 一张唱片对应一首曲目；UI 和场景唱片共用稳定 ID，后续换片交互直接调用 selectTrack(id)。titleEn / artistEn：英文界面（书房）显示的名字
export const MUSIC_TRACKS = [
  {
    id: 'futatabi', title: 'ふたたび', artist: '久石让', titleEn: 'Futatabi', artistEn: 'Joe Hisaishi',
    src: new URL('../assets/audio/futatabi.mp3', import.meta.url).href,
    label: { color: '#a44532', lines: ['FUTATABI'], credit: 'JOE HISAISHI' },
  },
  {
    id: 'requiem-of-silence', title: 'Requiem of Silence', artist: '',
    src: new URL('../assets/audio/requiem-of-silence.mp3', import.meta.url).href,
    label: { color: '#354e69', lines: ['REQUIEM', 'OF SILENCE'], credit: 'ORIGINAL SOUNDTRACK' },
  },
  {
    id: 'flower-dance', title: '花之舞', artist: 'Bi.Bi Piano · 钢琴版', titleEn: 'Flower Dance', artistEn: 'Bi.Bi Piano · solo piano',
    src: new URL('../assets/audio/flower-dance.mp3', import.meta.url).href,
    label: { color: '#5b7757', lines: ['FLOWER', 'DANCE'], credit: 'BI.BI PIANO' },
  },
];
