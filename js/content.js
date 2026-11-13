// 从 HTML 内容层读出网站数据，交给 3D 房间。内容和画面分开：改内容只改 HTML，不碰 3D 代码。
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

export function readContent(doc = document) {
  return {
    name: text(doc.querySelector('[data-name]')),
    tagline: text(doc.querySelector('.tagline')),
    about: [...doc.querySelectorAll('#about > p')].map(text).filter(Boolean),
    // 书桌房间旧电脑上的菜单（js/pc.js）：一种语言一份；每项要么是一页文字（paras），要么是一个列表（entries）
    pcMenus: [...doc.querySelectorAll('#about .pc-menu')].map((m) => ({
      lang: m.getAttribute('lang') || '',
      label: m.dataset.label || m.getAttribute('lang') || '',
      items: [...m.querySelectorAll(':scope > article')].map((a) => ({
        cmd: (a.dataset.cmd || '').toUpperCase(),
        title: text(a.querySelector('h3')),
        updated: a.dataset.updated || '',
        paras: [...a.querySelectorAll(':scope > p')].map(text).filter(Boolean),
        entries: [...a.querySelectorAll(':scope > ol > li')].map((li) => ({
          title: text(li.querySelector('b')), when: li.dataset.when || '', tape: li.dataset.tape || '',
          paras: [...li.querySelectorAll('p')].map(text).filter(Boolean),
        })),
      })).filter((it) => it.cmd && (it.paras.length || it.entries.length)),
    })).filter((m) => m.items.length),
    tapes: [...doc.querySelectorAll('#work li')].map((li) => {
      const a = li.querySelector('a');
      return {
        kind: li.dataset.tape || 'bars',
        color: li.dataset.color || '#88aaff',
        title: text(a),
        url: a?.href || '',
        years: text(li.querySelector('.years')),
        desc: text(li.querySelector('p')),
      };
    }),
    books: [...doc.querySelectorAll('#shelf li')].map((li) => {
      const a = li.querySelector('a');
      const by = li.querySelector('.by');
      const d = li.dataset;
      // 没有链接时，书名 = li 开头的文字（去掉作者和简介）
      const own = [...li.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
      return {
        title: text(a) || own.replace(/\s+/g, ' ').trim(), url: a?.href || '', author: text(by), note: text(li.querySelector('p')),
        // key：左页单独印的那一句（blockquote.key）；quotes：右页的划线
        key: text(li.querySelector('blockquote.key')),
        quotes: [...li.querySelectorAll('blockquote:not(.key)')].map(text).filter(Boolean),
        // 3D 书架用：宽 × 高 × 厚（米）、精装 / 平装、颜色、自动封面的样式、真实封面的文件名、读完的时间
        size: (d.size || '').split(/[x×*]/).map((v) => Number(v) / 1000).filter((v) => v > 0),
        kind: d.kind || 'soft', color: d.color || '', ink: d.ink || '', style: d.style || 'literary', cover: d.cover || '', read: d.read || '',
        progress: d.progress != null && d.progress !== '' ? Number(d.progress) : null, // 还没读完：读到百分之几
        publisher: d.publisher || '', marks: d.marks ? Number(d.marks) : null, // 阅读卡用：出版社、一共划了多少条
      };
    }),
    photos: [...doc.querySelectorAll('#photos li')].map((li) => {
      const img = li.querySelector('img');
      const src = img?.getAttribute('src') || '';
      // 板上用小一号的：名字.webp → 名字.board.webp（做旧脚本两份都会出）
      return { src, board: src.replace(/\.webp$/, '.board.webp'), alt: img?.alt || '', caption: text(li.querySelector('p')) };
    }),
    // 写过的文章（书架上那本牛皮纸本子里）：标题、副标题、一段段正文。data-sealed = 上了锁，正文在密文文件里（js/seal.js 解开）
    writing: [...doc.querySelectorAll('#writing article.essay')].map((a) => {
      const h = a.querySelector('h3'), sub = text(h?.querySelector('small'));
      const sealed = a.dataset.sealed ? new URL(a.dataset.sealed, doc.baseURI).href : '';
      return {
        title: text(h).replace(sub, '').trim(), sub, sealed,
        blocks: sealed ? [] : [...a.querySelectorAll('p')].map((p) => ({ t: 'p', text: text(p) })).filter((b) => b.text),
      };
    }),
    links: [...doc.querySelectorAll('#online li')].map((li) => {
      const a = li.querySelector('a');
      return { label: text(a), url: a?.href || '', handle: text(li.querySelector('span')) };
    }),
  };
}
