#!/usr/bin/env node
// voice CLI：语音库查看 / 探测 / 歌本点歌 / 发一条语音（可 dry-run）。
//
//   voice list     [--dir AUDIO_DIR]
//   voice inspect  <file> [--dir AUDIO_DIR]
//   voice plan     group:123 <file> [--volume 2] [--loudness loud]
//   voice send     group:123 <file> --http http://127.0.0.1:3000 [--token T]
//   voice songbook [--songbook DIR]
//   voice sing     group:123 <歌名> --http ... | --dry-run
//   voice doctor
//
// 默认语音库：$VOICE_DIR，其次 ./audio。歌本：$SONGBOOK_DIR，其次 ./songbook。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SECONDS,
  describeAudio,
  formatBytes,
  formatDuration,
  inspectAudio,
  resolveAudioSource,
  resolveAudioProcessing,
  resolveFfmpeg,
  processAudioVolume,
  cleanupTemp,
  listAudioFiles,
  parseTargetKey
} from '../src/voice-core.js';
import { listSongs, matchSong, pickRandomSong } from '../src/songbook.mjs';
import { buildRecordMessage, preflightSend, sendVoice, targetPayload } from '../src/send.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) args._.push(t);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args[t.slice(2)] = true;
    else {
      args[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const voiceDir = (args) => path.resolve(String(args.dir ?? process.env.VOICE_DIR ?? 'audio'));
const songbookDir = (args) => path.resolve(String(args.songbook ?? process.env.SONGBOOK_DIR ?? 'songbook'));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'list';

  if (cmd === 'doctor') {
    const ffmpeg = resolveFfmpeg({ ffmpegPath: args.ffmpeg ?? null });
    const dir = voiceDir(args);
    const files = listAudioFiles(dir);
    const sample = files[0];
    const probe = sample ? await inspectAudio(sample) : { ok: false, reason: '语音库为空' };
    console.log(`Node        ${process.version}`);
    console.log(`语音库      ${dir}${fs.existsSync(dir) ? `（${files.length} 个音频）` : '（不存在）'}`);
    console.log(`歌本        ${songbookDir(args)}（${listSongs(songbookDir(args)).length} 首）`);
    console.log(`ffmpeg      ${ffmpeg}`);
    console.log(`ffprobe     ${probe.ok ? `可用（${describeAudio(probe)}）` : `不可用：${probe.reason}`}`);
    console.log(`上限        单条 ${formatBytes(DEFAULT_MAX_BYTES)} / ${formatDuration(DEFAULT_MAX_SECONDS)}`);
    return probe.ok || !sample ? 0 : 1;
  }

  if (cmd === 'list') {
    const dir = voiceDir(args);
    const files = listAudioFiles(dir);
    if (!files.length) {
      console.log(`${dir} 里没有音频（用 --dir 指定语音库）`);
      return 1;
    }
    for (const f of files) {
      const st = fs.statSync(f);
      console.log(`${formatBytes(st.size).padStart(9)}  ${path.relative(dir, f)}`);
    }
    console.log(`\n共 ${files.length} 个`);
    return 0;
  }

  if (cmd === 'songbook') {
    const songs = listSongs(songbookDir(args));
    if (!songs.length) {
      console.log(`${songbookDir(args)} 里没有歌（歌本目录里文件名就是歌名）`);
      return 1;
    }
    for (const s of songs) console.log(`${s.name.padEnd(20)} ${formatBytes(s.size)}`);
    console.log(`\n共 ${songs.length} 首`);
    return 0;
  }

  if (cmd === 'inspect' || cmd === 'plan') {
    const input = String(args._[args._[0] === 'plan' ? 2 : 1] ?? '');
    if (!input) {
      console.error(`用法：voice ${cmd} ${cmd === 'plan' ? 'group:123 ' : ''}<file>`);
      return 2;
    }
    const resolved = resolveAudioSource(input, { voiceDir: voiceDir(args) });
    if (!resolved.path) {
      console.error(`找不到音频「${input}」${resolved.candidates.length ? `；候选：${resolved.candidates.map((c) => c.path).join(', ')}` : ''}`);
      return 1;
    }
    const info = await inspectAudio(resolved.path);
    console.log(`文件        ${resolved.path}（命中方式：${resolved.via}）`);
    console.log(`探测        ${info.ok ? describeAudio(info) : `失败：${info.reason}`}`);
    if (cmd === 'inspect') return info.ok ? 0 : 1;

    const processing = resolveAudioProcessing({ volume: args.volume ?? 1, normalize: Boolean(args.loudness), loudness: args.loudness ?? 'normal' });
    console.log(`处理        ${processing.loudness ? `loudnorm ${processing.loudness} LUFS` : `音量 ×${processing.volume}`}`);
    const { action, payload } = targetPayload(String(args._[1] ?? ''));
    console.log(`目标        ${action} ${JSON.stringify(payload)}`);
    const pre = await preflightSend(resolved.path);
    console.log(`预检        ${pre.ok ? '通过' : `不通过：${pre.reasons.join('；')}`}`);
    const sample = buildRecordMessage(Buffer.from('demo'), { filename: path.basename(resolved.path) });
    console.log(`消息段      ${sample[0].type}（发送时替换为真实音频，base64 内联）`);
    return pre.ok ? 0 : 1;
  }

  if (cmd === 'sing' || cmd === 'send') {
    const target = String(args._[1] ?? '');
    let input = String(args._[2] ?? '');
    let file = null;

    if (cmd === 'sing') {
      const songs = listSongs(songbookDir(args));
      const picked = args.random ? pickRandomSong(songs) : matchSong(input, songs).song;
      if (!picked) {
        const { candidates, reason } = matchSong(input, songs);
        console.error(reason);
        for (const c of candidates) console.error(`  ${c.name}`);
        return 1;
      }
      file = picked.file;
      console.log(`点歌        ${picked.name}`);
    } else {
      const resolved = resolveAudioSource(input, { voiceDir: voiceDir(args) });
      if (!resolved.path) {
        console.error(`找不到音频「${input}」`);
        return 1;
      }
      file = resolved.path;
    }

    const processing = resolveAudioProcessing({ volume: args.volume ?? 1, normalize: Boolean(args.loudness), loudness: args.loudness ?? 'normal' });
    let sendPath = file;
    let converted = false;
    if (processing.loudness || processing.volume !== 1) {
      const out = await processAudioVolume(file, { ...processing, ffmpegPath: args.ffmpeg ?? null });
      if (!out.ok) {
        console.error(`音量处理失败：${out.reason ?? out.detail ?? '未知原因'}`);
        return 1;
      }
      sendPath = out.path;
      converted = Boolean(out.converted);
      console.log(`处理        ${out.mode}（${out.detail ?? 'ok'}）`);
    }

    try {
      const pre = await preflightSend(sendPath);
      if (!pre.ok) {
        console.error(`预检不通过：${pre.reasons.join('；')}`);
        return 1;
      }
      const buffer = fs.readFileSync(sendPath);
      const dryRun = Boolean(args['dry-run']) || !args.http;
      const result = await sendVoice({
        httpUrl: args.http ? String(args.http) : 'http://127.0.0.1:3000',
        accessToken: args.token ? String(args.token) : undefined,
        target,
        source: buffer,
        options: { filename: path.basename(sendPath) },
        dryRun,
        timeoutMs: Number(args.timeout ?? 30000)
      });
      if (dryRun) {
        console.log(`dry-run     目标 ${result.target}，action ${result.action}`);
        console.log(`            message[0].type=record，base64 长度 ${result.payload.message[0].data.file.length}`);
        return 0;
      }
      if (!result.ok) {
        console.error(`发送失败：${result.error ?? JSON.stringify(result.response).slice(0, 300)}`);
        return 1;
      }
      console.log(`发送成功    ${result.target}（${formatBytes(buffer.length)}）`);
      return 0;
    } finally {
      if (converted) cleanupTemp(sendPath, true);
    }
  }

  console.error(
    [
      '用法：',
      '  voice doctor',
      '  voice list    [--dir AUDIO_DIR]',
      '  voice inspect <file> [--dir AUDIO_DIR]',
      '  voice plan    group:<群号> <file> [--volume 2] [--loudness loud]',
      '  voice songbook [--songbook DIR]',
      '  voice send    group:<群号>|private:<QQ> <file> [--http URL] [--token T] [--dry-run]',
      '  voice sing    group:<群号>|private:<QQ> <歌名> [--random] [--http URL] [--dry-run]',
      '',
      `语音库默认：${voiceDir({})}；歌本默认：${songbookDir({})}（可用环境变量 VOICE_DIR / SONGBOOK_DIR 覆盖）`,
      `临时目录：${os.tmpdir()}`
    ].join('\n')
  );
  return 2;
}

process.exitCode = await main();
