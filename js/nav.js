// 顶部导航栏：左边是名字，右边是内容层里每个带 data-nav 的 <section> 一项。3D 房间和纯文字版共用。
//   - 3D 版：点一项 = 点场景里对应的物件（调用场景的 go(id)：镜头飞过去、打开面板、地址变成 #id）。
//     再点一次当前项、或者点名字，回到总览。鼠标停在某一项上时，场景里对应的物件跟着高亮。
//   - 纯文字版：就是普通的页内锚点。
//   - 场景还在加载时点了：先把地址改成 #id，场景加载完会直接从这个视角开始。
// 场景里没有对应物件的项（以后的 posts 之类）链接到纯文字版的那一节。
// 上锁的项（locked，书桌房间里还没找到的东西，js/achievements.js）：位置照留，字模糊成一团、点不了，
// 鼠标停上去也不高亮场景里的物件（不剧透）；unlock(id) 时字从模糊里浮出来，变成普通的一项。纯文字版不上锁（样式只在 .is-room 下）
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

export function createNav(doc = document, { locked = [] } = {}) {
  const html = doc.documentElement;
  const homeUrl = () => location.pathname + location.search;
  const items = [...doc.querySelectorAll('#content section[data-nav]')]
    .map((s) => ({ id: s.id, label: s.dataset.nav || text(s.querySelector('h2')) }))
    .filter((it) => it.id && it.label);

  const bar = doc.createElement('header');
  bar.id = 'topbar';
  bar.className = 'topbar';
  const brand = doc.createElement('a');
  brand.className = 'brand';
  brand.href = homeUrl();
  brand.textContent = text(doc.querySelector('[data-name]')) || doc.title;
  const tabs = doc.createElement('nav');
  tabs.className = 'tabs';
  tabs.setAttribute('aria-label', 'Sections');
  const links = items.map(({ id, label }) => {
    const a = doc.createElement('a');
    a.href = '#' + id;
    a.dataset.route = id;
    const span = doc.createElement('span');
    span.className = 'tab-label';
    span.textContent = label;
    a.append(span);
    if (locked.includes(id)) lock(a);
    tabs.append(a);
    return a;
  });
  function lock(a) {
    a.classList.add('is-locked');
    a.setAttribute('aria-disabled', 'true');
    a.tabIndex = -1;
    a.dataset.tip = 'Not yet discovered';
  }
  const isLocked = (a) => a.classList.contains('is-locked') && isRoom();
  bar.append(brand, tabs);
  doc.body.prepend(bar);

  let scene = null; // { go, routes, current, preview }：3D 场景加载完以后接上
  function isRoom() { return html.classList.contains('is-room'); }
  const plainClick = (e) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey; // 新标签页打开等，交给浏览器

  function setActive(route) {
    for (const a of links) {
      if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }
  const hashRoute = () => {
    let id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch { /* 保留原样 */ }
    return id;
  };

  for (const a of links) {
    const id = a.dataset.route;
    a.addEventListener('click', (e) => {
      if (isLocked(a)) { // 还没找到：不跳，轻轻晃一下
        e.preventDefault();
        a.classList.remove('is-nudge');
        void a.offsetWidth;
        a.classList.add('is-nudge');
        return;
      }
      if (plainClick(e)) return;
      if (scene) {
        if (!scene.routes.includes(id)) return; // 场景里没有这个物件：按链接去纯文字版
        e.preventDefault();
        scene.go(scene.current() === id ? 'home' : id);
      } else if (isRoom()) { // 场景还在加载
        e.preventDefault();
        history.pushState(null, '', '#' + id);
        setActive(id);
      }
      // 纯文字版：普通锚点
    });
    a.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !isLocked(a)) scene?.preview?.(id); });
    a.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') scene?.preview?.(null); });
  }
  brand.addEventListener('click', (e) => {
    if (plainClick(e)) return;
    e.preventDefault();
    if (scene) return scene.go('home');
    history.pushState(null, '', homeUrl());
    setActive(null);
    if (!isRoom()) scrollTo({ top: 0, behavior: 'smooth' });
  });
  addEventListener('hashchange', () => { if (!scene) setActive(hashRoute()); });
  setActive(hashRoute());

  return {
    el: bar,
    setActive,
    // 场景加载完调用：go(id) 切视角，routes 是场景里有物件的路由，current() 返回当前视角，preview(id | null) 高亮物件
    bind(s) {
      scene = s;
      for (const a of links) if (!s.routes.includes(a.dataset.route)) a.href = '?plain=1#' + a.dataset.route;
      setActive(s.current() === 'home' ? null : s.current());
    },
    // 导航栏上这一项叫什么
    label: (id) => text(links.find((a) => a.dataset.route === id)),
    // 解锁一项：quiet = 不放动画（3D 加载失败换成纯文字版时，一次全打开）
    unlock(id, { quiet = false } = {}) {
      const a = links.find((x) => x.dataset.route === id);
      if (!a?.classList.contains('is-locked')) return;
      a.classList.remove('is-locked', 'is-nudge');
      a.removeAttribute('aria-disabled');
      a.removeAttribute('tabindex');
      delete a.dataset.tip;
      if (!quiet) {
        a.classList.add('is-revealed');
        a.addEventListener('animationend', () => a.classList.remove('is-revealed'), { once: true });
      }
    },
    unlockAll() { for (const a of links) this.unlock(a.dataset.route, { quiet: true }); },
    // 导航栏挡住了屏幕顶部多少像素（镜头取景时让开）
    height: () => (bar.isConnected ? Math.max(0, bar.getBoundingClientRect().bottom) : 0),
  };
}
