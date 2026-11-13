// 录像带画面注册表。每个模块的接口：
//   export default { mount({ canvas, ctx, width, height, tape }) { return { frame(t, dt), stop?() } } }
// 新增一种画面：写一个模块，在这里注册，然后在 HTML 里用 data-tape="名字" 选它。
import bars from './bars.js';
import synth from './synth.js';
import bounce from './bounce.js';
import rain from './rain.js';

export default { bars, synth, bounce, rain };
