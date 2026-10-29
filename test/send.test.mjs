import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSongs, matchSong, normalizeSongName, pickRandomSong } from '../src/songbook.mjs';
import { buildRecordMessage, sendVoice, targetPayload, preflightSend } from '../src/send.mjs';

function songbook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songbook-'));
  for (const name of ['起风了.wav', 'lettinggo.wav', 'HugMe.mp3', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }
  return dir;
}

test('listSongs：只认音频，文件名即歌名，忽略其它文件', () => {
  const songs = listSongs(songbook());
  assert.deepEqual(songs.map((s) => s.name).sort(), ['HugMe', 'lettinggo', '起风了'].sort());
  assert.deepEqual(listSongs(path.join(os.tmpdir(), 'nope-不存在的目录')), []);
});

test('normalizeSongName：大小写/空白/标点/全角都不影响匹配', () => {
  assert.equal(normalizeSongName('Ｈｕｇ Ｍｅ！'), 'hugme');
  assert.equal(normalizeSongName('hug-me.mp3'), 'hugme');
  assert.equal(normalizeSongName('《起风了》'), '起风了');
});

test('matchSong：精确 → 唯一子串 → 多候选不猜', () => {
  const songs = listSongs(songbook());
  assert.equal(matchSong('起风了', songs).song.name, '起风了');
  assert.equal(matchSong('起风', songs).reason, '唯一子串命中');
  assert.equal(matchSong('hugme', songs).song.name, 'HugMe');
  const miss = matchSong('不存在的歌', songs);
  assert.equal(miss.song, null);
  assert.match(miss.reason, /没有/);

  const dup = [...songs, { name: '起风了(伴奏)', file: 'x', base: 'x.wav', size: 1 }];
  const multi = matchSong('起风', dup);
  assert.equal(multi.song, null, '多首命中时必须让人挑，不能瞎猜');
  assert.ok(multi.candidates.length >= 2);
});

test('pickRandomSong：rng 边界不越界', () => {
  const songs = [{ name: 'a' }, { name: 'b' }];
  assert.equal(pickRandomSong(songs, () => 0).name, 'a');
  assert.equal(pickRandomSong(songs, () => 0.999).name, 'b');
  assert.equal(pickRandomSong(songs, () => 1).name, 'b');
  assert.equal(pickRandomSong([], () => 0), null);
});

test('buildRecordMessage：Buffer → base64 内联，空内容直接报错', () => {
  const [segment] = buildRecordMessage(Buffer.from('abc'));
  assert.equal(segment.type, 'record');
  assert.equal(segment.data.file, `base64://${Buffer.from('abc').toString('base64')}`);
  assert.deepEqual(buildRecordMessage('base64://xyz'), [{ type: 'record', data: { file: 'base64://xyz' } }]);
  assert.throws(() => buildRecordMessage(Buffer.alloc(0), { filename: 'x.wav' }), /音频内容为空/);
  assert.throws(() => buildRecordMessage('C:/a.mp3', { mode: 'base64' }), /必须是 base64:\/\/ 或 file:\/\//);
});

test('targetPayload：群/私聊 action 与 body 正确，非法目标报错', () => {
  assert.deepEqual(targetPayload('group:123'), {
    action: 'send_group_msg',
    body: { group_id: 123 },
    parsed: { kind: 'group', id: '123', key: 'group:123' }
  });
  assert.equal(targetPayload('private:456').action, 'send_private_msg');
  assert.throws(() => targetPayload('group:0'), /目标格式不对/);
});

test('sendVoice --dryRun：不出网，返回将要发送的 payload', async () => {
  const result = await sendVoice({
    httpUrl: 'http://127.0.0.1:1',
    target: 'group:123',
    source: Buffer.from('abc'),
    dryRun: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'send_group_msg');
  assert.equal(result.payload.group_id, 123);
  assert.equal(result.payload.message[0].type, 'record');
});

test('sendVoice：网关不可达时返回结构化失败，而不是抛异常', async () => {
  const result = await sendVoice({
    httpUrl: 'http://127.0.0.1:1',
    target: 'private:456',
    source: Buffer.from('abc'),
    timeoutMs: 1500
  });
  assert.equal(result.ok, false);
  assert.ok(result.error || result.response);
});

test('preflightSend：非音频/不存在/超限都在发请求前拦下', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  const bad = await preflightSend(path.join(dir, 'note.txt'));
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /不是支持的音频格式/.test(r)));

  const missing = await preflightSend(path.join(dir, 'nope.mp3'));
  assert.equal(missing.ok, false);
  assert.ok(missing.reasons.some((r) => /文件不存在/.test(r)));

  fs.writeFileSync(path.join(dir, 'big.mp3'), Buffer.alloc(2048));
  const tooBig = await preflightSend(path.join(dir, 'big.mp3'), { maxBytes: 1024 });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.reasons.some((r) => /超过上限/.test(r)));
});
