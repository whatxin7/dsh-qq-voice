import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUDIO_EXTS,
  isAudioFile,
  formatBytes,
  formatDuration,
  listAudioFiles,
  resolveAudioSource,
  safeJoinLibrary,
  parseTargetKey,
  sanitizeUploadName,
  uniqueLibraryPath,
  resolveAudioProcessing,
  VOLUME_MIN,
  VOLUME_MAX
} from '../src/voice-core.js';

function library() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-lib-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, '你好.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', '晚安.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  return dir;
}

test('isAudioFile / formatBytes / formatDuration 基本口径', () => {
  assert.equal(isAudioFile('a.mp3'), true);
  assert.equal(isAudioFile('a.WAV'), true);
  assert.equal(isAudioFile('a.txt'), false);
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(75), '1分15秒');
  assert.equal(formatDuration(9), '9秒');
  assert.ok(AUDIO_EXTS.includes('.mp3'));
});

test('listAudioFiles：递归、跳过隐藏与非法扩展、排序稳定', () => {
  const dir = library();
  const files = listAudioFiles(dir).map((f) => path.relative(dir, f));
  assert.deepEqual(files, ['你好.mp3', 'sub\\晚安.wav'].map((f) => f.replace('\\', path.sep)));
});

test('resolveAudioSource：绝对路径 / cwd / 语音库 / 补扩展名 四条路都能命中', () => {
  const dir = library();
  const abs = path.join(dir, '你好.mp3');
  assert.equal(resolveAudioSource(abs).via, 'absolute');
  assert.equal(resolveAudioSource('你好.mp3', { voiceDir: dir }).via, 'voice-dir');
  assert.equal(resolveAudioSource('你好', { voiceDir: dir }).path, abs, '没写扩展名要能补上');
  assert.equal(resolveAudioSource('', {}).path, null);
  const miss = resolveAudioSource('不存在的歌', { voiceDir: dir });
  assert.equal(miss.path, null);
  assert.equal(miss.via, 'not-found');
});

test('safeJoinLibrary：拒绝路径穿越与绝对路径逃逸', () => {
  const dir = library();
  assert.ok(safeJoinLibrary(dir, '你好.mp3').endsWith('你好.mp3'));
  assert.equal(safeJoinLibrary(dir, '../../etc/passwd'), null);
  assert.equal(safeJoinLibrary(dir, 'C:/Windows/win.ini'), null);
  assert.equal(safeJoinLibrary(dir, ''), null);
});

test('parseTargetKey：只认 group:/private: + 正整数', () => {
  assert.deepEqual(parseTargetKey('group:123'), { kind: 'group', id: '123', key: 'group:123' });
  assert.deepEqual(parseTargetKey(' private:456 '), { kind: 'private', id: '456', key: 'private:456' });
  assert.equal(parseTargetKey('group:0'), null);
  assert.equal(parseTargetKey('group:007'), null);
  assert.equal(parseTargetKey('user:123'), null);
});

test('sanitizeUploadName / uniqueLibraryPath：文件名净化与去冲突', () => {
  const dir = folder();
  function folder() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-up-'));
    fs.writeFileSync(path.join(d, 'a.mp3'), 'x');
    return d;
  }
  assert.equal(sanitizeUploadName('../../evil<1>.mp3'), 'evil_1_.mp3');
  assert.equal(sanitizeUploadName('noext'), 'noext.mp3');
  const next = uniqueLibraryPath(dir, 'a.mp3');
  assert.equal(path.basename(next), 'a-2.mp3');
});

test('resolveAudioProcessing：音量范围校验，loudness 优先且支持直接给 LUFS', () => {
  assert.deepEqual(resolveAudioProcessing({ volume: 2 }), { volume: 2, loudness: null, loudnessKey: null });
  assert.throws(() => resolveAudioProcessing({ volume: VOLUME_MIN - 0.01 }), /音量倍数需在/);
  assert.throws(() => resolveAudioProcessing({ volume: VOLUME_MAX + 1 }), /音量倍数需在/);
  assert.deepEqual(resolveAudioProcessing({ normalize: true, loudness: 'loud' }), { volume: 1, loudness: -13, loudnessKey: 'loud' });
  assert.deepEqual(resolveAudioProcessing({ normalize: true, loudness: -18 }), { volume: 1, loudness: -18, loudnessKey: '-18' });
  assert.throws(() => resolveAudioProcessing({ normalize: true, loudness: 'huge' }), /未知的响度档位/);
  assert.throws(() => resolveAudioProcessing({ normalize: true, loudness: -60 }), /目标响度需在/);
});
