import { sfx } from './sfx.js';
import { someDigits } from './dial.js';

// 桌子左前角的转盘电话 = 给主人留言（热点 phone，bake_room.py 里摆的）。留言发到主人的邮箱：
// index.html #messages 里那张 form.leave-message 的 action 是表单服务的地址（Formspree 之类，它们把提交转成邮件）。
//   - 点电话：提起听筒"咔"，拨号音，转盘拨三位（js/dial.js，"嗒嗒嗒"），响一声回铃，答录机接起来（磁带"咔哒"、小红灯常亮 = 在录），"嘀"——
//     屏幕下方出一块写留言的地方，用的就是答录机放留言的那套字幕样式（.tvsub / .amsub，别改）：
//     上面一行小号大写的提示，中间居中的衬线正文（就是输入框），下面斜体一行写"你是谁、怎么找你"。
//   - 回车发出（Shift+回车换行）：发出去的字立刻清空，不留草稿。没发就挂断（Esc、再点一下电话、去别的地方），
//     写了一半的留在这个浏览器里，下次拿起来还在；发送失败、一分钟内第二条，字也留着
//   - 发出去：磁带停"咔哒"，红灯闪两下，"Message sent"；发不出去：提示再试一次，字留着
//   - 一分钟只能发一条；表单里有一个看不见的 _gotcha 栏（机器人会填，Formspree 据此丢掉）
//   - action 是示例地址（模板默认的 …/f/your-form-id）：演示模式。拿起、写留言都一样，按回车不往外发任何请求，
//     如实告诉访客"这是演示、什么都没发"（按了回车就算发过：字清空，不留草稿）
//   - action 没填：电话就是联系方式，点它打开 Contact 面板（和记事本一样）
const DRAFT = 'scenecv.phone.draft', SENT = 'scenecv.phone.sent';
const GAP = 60 * 1000; // 两条留言至少隔多久（毫秒）
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 存不了就算了 */ } },
};

// 回铃音：440 + 480 赫兹叠在一起（北美的回铃），一声 0.9 秒
function ringback(delay = 0) {
  sfx.tone(440, { dur: 0.9, gain: 0.07, delay });
  sfx.tone(480, { dur: 0.9, gain: 0.07, delay });
}

export function createPhone({ form, owner = '', parent = document.body, before = null, answering = null, dial = null, openContact = () => {}, onHangUp = () => {} } = {}) {
  const endpoint = /^https?:\/\//i.test(form?.getAttribute('action') || '') ? form.action : '';
  const demo = /your-form-id/i.test(endpoint); // 模板里的示例地址：演示，不发

  const sub = document.createElement('div');
  sub.className = 'tvsub amsub phonesub';
  sub.hidden = true;
  sub.innerHTML = '<p class="amsub-head"></p>'
    + '<textarea class="tvsub-text amsub-text phone-text" rows="1" maxlength="1200" spellcheck="true" aria-label="Your message"></textarea>'
    + '<input class="phone-from" maxlength="160" autocomplete="name" aria-label="Your name, and how to reach you">'
    + '<p class="phone-hint"></p>';
  parent.insertBefore(sub, before);
  const head = sub.querySelector('.amsub-head'), text = sub.querySelector('.phone-text'), from = sub.querySelector('.phone-from');
  const hint = sub.querySelector('.phone-hint');
  const HINT = `Enter to send${owner ? ` to ${owner}` : ''} · Shift+Enter for a new line · Esc to hang up`;

  let state = 'idle', timers = [], hissing = null; // idle | open | sending | sent
  const later = (ms, f) => timers.push(setTimeout(f, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const fit = () => { text.style.height = 'auto'; text.style.height = text.scrollHeight + 'px'; };
  const saveDraft = () => store.set(DRAFT, JSON.stringify({ text: text.value, from: from.value }));

  function open() {
    if (!endpoint) { sfx.play('switch', { gain: 0.42, rate: 0.7 }); openContact(); return; }
    answering?.stop();
    clearTimers();
    state = 'open';
    let d = null;
    try { d = JSON.parse(store.get(DRAFT) || 'null'); } catch { /* 草稿坏了就不要 */ }
    text.value = d?.text || '';
    from.value = d?.from || '';
    text.placeholder = 'Say something…';
    from.placeholder = '— your name, and how to reach you (optional)';
    head.textContent = 'Calling…';
    hint.textContent = HINT;
    sub.hidden = false;
    fit();
    text.focus({ preventScroll: true });
    sfx.play('switch', { gain: 0.42, rate: 0.7 }); // 提起听筒
    const dialing = dial?.start(someDigits()) || 0; // 先拨号：转盘转三位（js/dial.js），不想看动画的系统设置下直接打过去
    if (dialing) head.textContent = 'Dialing…';
    later(dialing * 1000, () => { // 拨完了：对面响铃
      if (state !== 'open') return;
      head.textContent = 'Calling…';
      ringback(0.25);
      answering?.recording(true);
      later(1300, () => { // 答录机接起来
        if (state !== 'open') return;
        sfx.play('tape-latch', { gain: 0.9, rate: 1.25, lp: 4000 });
        sfx.tone(1000, { dur: 0.45, delay: 0.35 });
        hissing = sfx.hiss({ gain: 0.011 }); // 电话那头的答录机：比在桌上放留言再远一点
        later(350, () => { if (state === 'open') head.textContent = 'Leave a message after the beep'; });
      });
    });
  }

  function hangUp() {
    if (state === 'idle') return;
    clearTimers();
    dial?.stop(); // 拨到一半挂了：松手，转盘自己转回去
    if (state === 'open' || state === 'sending') saveDraft(); // 正在发的也存一份：发成功了会把它清掉
    state = 'idle';
    sub.hidden = true;
    hissing?.stop();
    hissing = null;
    answering?.recording(false);
    sfx.play('switch', { gain: 0.4, rate: 0.9 }); // 听筒放回去
    text.blur();
    from.blur();
    onHangUp();
  }

  async function send() {
    const msg = text.value.trim();
    if (state !== 'open' || msg.length < 2) return;
    if (demo) return demoSend();
    const last = Number(store.get(SENT) || 0);
    if (Date.now() - last < GAP) { head.textContent = 'One message a minute, please'; return; }
    state = 'sending';
    head.textContent = 'Sending…';
    const body = new FormData();
    body.set('message', msg);
    body.set('from', from.value.trim());
    body.set('_subject', `A message from the desk room${owner ? ` (${owner})` : ''}`);
    body.set('_gotcha', form.querySelector('[name="_gotcha"]')?.value || '');
    for (const el of form.querySelectorAll('input[type="hidden"]')) if (el.name && !body.has(el.name)) body.set(el.name, el.value); // 有的表单服务要一个隐藏的 key
    let ok = false;
    try {
      const r = await fetch(endpoint, { method: 'POST', body, headers: { Accept: 'application/json' } });
      ok = r.ok;
    } catch { ok = false; }
    if (ok) { store.set(SENT, String(Date.now())); store.set(DRAFT, null); } // 发出去了：草稿作废（发的时候挂断了也一样）
    if (state !== 'sending') return; // 发的时候挂断了
    if (!ok) { state = 'open'; head.textContent = 'Couldn’t send · press Enter to try again'; return; }
    hissing?.stop();
    hissing = null;
    sfx.play('tape-latch', { gain: 0.9, rate: 1.1, lp: 4000 }); // 磁带停
    answering?.recording(false, { blinks: 2 });
    finished('Message sent · thank you', '', 2600);
  }

  // 发完（真发出去、或者演示）：输入框立刻清空，提示留一会儿，再放下听筒
  function finished(title, note, ms) {
    state = 'sent';
    dial?.stop();
    text.value = '';
    from.value = '';
    text.placeholder = '';
    from.placeholder = '';
    fit();
    text.blur();
    from.blur();
    head.textContent = title;
    hint.textContent = note;
    later(ms, () => { if (state === 'sent') hangUp(); });
  }

  // 演示：什么都不发。磁带停，灯灭，如实说没发出去；按了回车就算发过：字清空、草稿作废
  function demoSend() {
    store.set(DRAFT, null);
    hissing?.stop();
    hissing = null;
    sfx.play('tape-latch', { gain: 0.9, rate: 1.1, lp: 4000 });
    answering?.recording(false);
    finished('Demo line · nothing was sent', 'This copy of the template isn’t connected to an inbox yet: put a form address in #messages to get these by email', 4200);
  }

  text.addEventListener('input', () => { fit(); if (state === 'open' && /^(One message|Couldn)/.test(head.textContent)) head.textContent = 'Leave a message after the beep'; });
  for (const el of [text, from]) {
    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 打字的时候房间别跟着响应（方向键换带、Esc 回桌前）
      if (e.key === 'Escape') { e.preventDefault(); hangUp(); }
      else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
  }

  return {
    canTakeMessages: !!endpoint,
    get overlayHeight() { return sub.offsetHeight; },
    get open() { return state !== 'idle'; },
    hint() { return !endpoint ? 'Telephone · Contact' : state === 'idle' ? 'Telephone · Leave a message' : 'Telephone · Hang up'; },
    click() { if (state === 'idle') open(); else hangUp(); },
    hangUp,
  };
}
