// 办公室墙上的撕页日历：按今天的日期画纸页（贴到 manifest.calendar.page 那个材质上）。
// 纸页是正方形；画布正着画，CanvasTexture 默认 flipY，和烘焙脚本铺平后的纸页 UV 对得上。
import { makeCanvas } from './tapes/util.js';

const SERIF = '"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","SimSun",serif';
const DIGIT = '"Georgia","Times New Roman",serif';
const RED = '#b8322a';
const CN = '一二三四五六七八九十';
const WEEK = '日一二三四五六';

const cnMonth = (m) => (m === 10 ? '十' : m > 10 ? '十' + CN[m - 11] : CN[m - 1]) + '月';

function lunarDay(n) {
  if (n <= 10) return '初' + CN[n - 1];
  if (n < 20) return '十' + CN[n - 11];
  if (n === 20) return '二十';
  if (n < 30) return '廿' + CN[n - 21];
  return '三十';
}

// 农历（浏览器自带的中国历法）；不支持就返回 null，纸页上不写这一行
function lunar(date) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { year: 'numeric', month: 'long', day: 'numeric' }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const day = parseInt(get('day'), 10);
    let month = get('month');
    if (!month || !day) return null;
    month = month.replace(/^一月$/, '正月').replace(/^十一月$/, '冬月').replace(/^十二月$/, '腊月');
    return { text: `农历${month}${lunarDay(day)}`, year: get('yearName') ? `${get('yearName')}年` : '' };
  } catch {
    return null;
  }
}

export function paintCalendar(date = new Date(), c = makeCanvas(512, 512)) {
  const W = c.width, H = c.height, x = c.getContext('2d');
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  x.fillStyle = '#efe9dc';
  x.fillRect(0, 0, W, H);
  // 顶上一条红边：年、月
  x.fillStyle = RED;
  x.fillRect(0, 0, W, 92);
  x.fillStyle = '#f7efe2';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `bold 46px ${SERIF}`;
  x.fillText(`${date.getFullYear()}年  ${cnMonth(date.getMonth() + 1)}`, W / 2, 50);
  // 大号日期：周末红色，平时黑色
  x.fillStyle = weekend ? RED : '#1e1c1a';
  x.font = `bold 270px ${DIGIT}`;
  x.textBaseline = 'alphabetic';
  x.fillText(String(date.getDate()), W / 2, 338);
  x.font = `bold 52px ${SERIF}`;
  x.fillText(`星期${WEEK[date.getDay()]}`, W / 2, 410);
  // 最下面：农历
  const l = lunar(date);
  x.strokeStyle = 'rgba(60,40,30,0.35)';
  x.lineWidth = 2;
  x.beginPath();
  x.moveTo(36, 440);
  x.lineTo(W - 36, 440);
  x.stroke();
  if (l) {
    x.fillStyle = '#5a4a40';
    x.font = `34px ${SERIF}`;
    x.fillText(`${l.year}  ${l.text}`, W / 2, 486);
  }
  return c;
}
