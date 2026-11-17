// 唱机上的唱片：一张唱片对应一首曲目（mp3）。公开仓库里是空的：音乐有版权，不随模板分发。
// 想让唱机放歌：把 mp3 放进 assets/audio/（这个文件夹不进 Git），再在下面的列表里每首写一项，例如
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
export const MUSIC_TRACKS = [];
