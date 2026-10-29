// 歌本：把「我这台机器上真实唱过的段落」当成一个可检索的曲库。
//
// 为什么单独一层：语音库里除了歌还有日常语音（问候、晚安、吐槽）。歌本只认「文件名 = 歌名」
// 的那批文件，并且**只按名字点歌**——不让模型"用歌词现造旋律"。理由很实际：
// 合成出来的调子和人声版对不上，用户一听就知道是假的。
//
// 匹配规则故意保守：先精确（去扩展名、忽略大小写与空白、全角半角归一），再唯一子串；
// 命中多个就给候选列表让人挑，绝不"猜一个最像的"发出去。

import fs from 'node:fs';
import path from 'node:path';
import { isAudioFile } from './voice-core.js';

/** 归一化名字：小写、去空白与标点、全角转半角。 */
export function normalizeSongName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[\s\-_·.,，。!！?？'"“”‘’()（）\[\]【】《》「」]/g, '');
}

/**
 * 列出歌本。
 * @param {string} dir 歌本目录（文件名即歌名）
 * @returns {Array<{name:string, file:string, base:string, size:number}>}
 */
export function listSongs(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const songs = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!isAudioFile(entry.name)) continue;
    const file = path.join(dir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    songs.push({ name: path.basename(entry.name, path.extname(entry.name)), file, base: entry.name, size });
  }
  return songs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/**
 * 按名字找歌。
 * @returns {{song: object|null, candidates: object[], reason: string}}
 */
export function matchSong(query, songs) {
  const list = Array.isArray(songs) ? songs : [];
  const want = normalizeSongName(query);
  if (!want) return { song: null, candidates: [], reason: '没给歌名' };

  const exact = list.filter((s) => normalizeSongName(s.name) === want || normalizeSongName(s.base) === want);
  if (exact.length === 1) return { song: exact[0], candidates: [], reason: '精确命中' };
  if (exact.length > 1) return { song: null, candidates: exact, reason: '有多个同名文件，请指定其中一个' };

  const partial = list.filter((s) => {
    const n = normalizeSongName(s.name);
    return n.includes(want) || want.includes(n);
  });
  if (partial.length === 1) return { song: partial[0], candidates: [], reason: '唯一子串命中' };
  if (partial.length > 1) return { song: null, candidates: partial, reason: '匹配到多首，请从候选里挑' };
  return { song: null, candidates: [], reason: `歌本里没有「${String(query)}」` };
}

/** 随机挑一首（`--random` 用）。传入 rng 便于测试。 */
export function pickRandomSong(songs, rng = Math.random) {
  const list = Array.isArray(songs) ? songs : [];
  if (!list.length) return null;
  const index = Math.min(list.length - 1, Math.max(0, Math.floor(Number(rng()) * list.length)));
  return list[index];
}
