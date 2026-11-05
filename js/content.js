// 从 HTML 内容层读出网站数据，交给 3D 房间。内容和画面分开：改内容只改 HTML，不碰 3D 代码。
const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

export function readContent(doc = document) {
  return {
    name: text(doc.querySelector('[data-name]')),
    tagline: text(doc.querySelector('.tagline')),
    about: [...doc.querySelectorAll('#about p')].map(text).filter(Boolean),
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
      // 没有链接时，书名 = li 开头的文字（去掉作者和简介）
      const own = [...li.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
      return { title: text(a) || own.replace(/\s+/g, ' ').trim(), url: a?.href || '', author: text(by), note: text(li.querySelector('p')) };
    }),
    links: [...doc.querySelectorAll('#online li')].map((li) => {
      const a = li.querySelector('a');
      return { label: text(a), url: a?.href || '', handle: text(li.querySelector('span')) };
    }),
  };
}
