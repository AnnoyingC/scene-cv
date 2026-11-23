// 唱机上的唱片：一张唱片对应一首曲目（mp3），排在第一张的是默认唱片（访客选过别的，浏览器会记住）。
// 公开仓库自带两张：石坂公美子演奏的《哥德堡变奏曲》A 面 / B 面（The Open Goldberg Variations，CC0，来源见 assets/records/README.md）。
// 换成自己的歌：把 mp3 放进 assets/audio/（这个文件夹不进 Git：歌大多有版权，不随模板分发），再在下面的列表里每首写一项，例如
//
//   {
//     id: 'my-song',                 // 稳定的 ID：选中的唱片按它记在浏览器里，切歌也用它（selectTrack(id)）
//     title: '曲名', artist: '演奏者',  // 唱片卡片上显示的名字；titleEn / artistEn 是英文界面（书桌房间）显示的名字，可以不写
//     src: new URL('../assets/audio/my-song.mp3', import.meta.url).href,
//     label: { color: '#a44532', lines: ['MY', 'SONG'], credit: 'ARTIST' },  // 唱片中间的标签：底色、一两行大字、下面一行小字
//   },
//
// 有了曲目，书桌房间点唱机会打开唱片卡片：选唱片、播放 / 暂停、调音量、切换黑胶音色，唱机上的唱片跟着转。
// 列表是空的时候不放播放器，唱机上是一张没印字的唱片。
export const MUSIC_TRACKS = [
  {
    id: 'goldberg-side-a', title: 'Goldberg Variations · Side A', artist: 'J. S. Bach · Kimiko Ishizaka', // Aria，第 1～7 变奏
    src: new URL('../assets/records/goldberg-side-a.mp3', import.meta.url).href,
    label: { color: '#8c2f2a', lines: ['GOLDBERG', 'SIDE A'], credit: 'KIMIKO ISHIZAKA' },
  },
  {
    id: 'goldberg-side-b', title: 'Goldberg Variations · Side B', artist: 'J. S. Bach · Kimiko Ishizaka', // 第 13、30 变奏，最后回到 Aria
    src: new URL('../assets/records/goldberg-side-b.mp3', import.meta.url).href,
    label: { color: '#2e4866', lines: ['GOLDBERG', 'SIDE B'], credit: 'KIMIKO ISHIZAKA' },
  },
];
