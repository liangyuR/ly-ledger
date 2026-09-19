import { pinyin } from 'pinyin-pro';

export interface Pinyin {
  full: string;
  abbr: string;
}

/** 只留字母数字。商品名里的括号、空格、中点不该进拼音索引 */
const keepAlnum = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * 商品名 / 客户名 → 拼音，用于搜索。
 *
 * 全拼和首字母两个都要：只做首字母会逼老板记缩写，只做全拼则打字太多。
 * 这样 `mt` 和 `maotai` 都能命中「茅台飞天」。
 *
 * 多音字会有错（「长城」「重庆」这类），所以两个字段都允许手工修正 —— 见 docs/02。
 */
export function toPinyin(name: string): Pinyin {
  const text = name.trim();
  if (!text) return { full: '', abbr: '' };

  const full = keepAlnum(pinyin(text, { toneType: 'none', type: 'array' }).join(''));
  const abbr = keepAlnum(pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }).join(''));

  return { full, abbr };
}
