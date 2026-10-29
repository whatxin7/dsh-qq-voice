// OneBot v11 语音发送：把音频变成一条 `record` 段消息，POST 给 SnowLuma 的 HTTP API。
//
// 三条实现口径（都踩过）：
//
// 1. **音频走 base64 内联**，不写网关可见的临时路径。网关和自己可能不在同一台机器/同一路径
//    命名空间；`file://` 只有在同机同路径时才成立，所以默认 base64，`--as-path` 才用路径。
// 2. **音量必须在这里做完**。`record` 段没有增益字段（只有 file/magic/url…），
//    要调音量只能先用 ffmpeg 产出新文件再发（见 `voice-core.processAudioVolume`）。
// 3. **发送前先校验**格式/体积/时长上限，别把 20MB 的 wav 丢给网关等它超时。
//
// 本文件只负责「造消息 + 发出去」，不做策略判断：允许发给谁由 dsh-qq-access 决定。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_SECONDS, formatBytes, inspectAudio, isAudioFile, parseTargetKey } from './voice-core.js';

/**
 * 造一条语音消息段。
 * @param {Buffer|string} source Buffer（→ base64）或已就绪的 `file://` / `base64://` 串
 * @param {object} [opts]
 * @param {'base64'|'path'} [opts.mode]
 * @param {string} [opts.filename] 仅用于日志/错误信息
 * @returns {Array<{type:'record', data:{file:string}}>}
 */
export function buildRecordMessage(source, { mode = 'base64', filename = 'audio' } = {}) {
  let file;
  if (Buffer.isBuffer(source)) {
    if (!source.length) throw new Error(`${filename}：音频内容为空`);
    file = `base64://${source.toString('base64')}`;
  } else {
    const s = String(source ?? '').trim();
    if (!s) throw new Error(`${filename}：音频来源为空`);
    if (/^(base64|file):\/\//i.test(s)) file = s;
    else if (mode === 'path') file = `file://${path.resolve(s).replace(/\\/g, '/')}`;
    else throw new Error('字符串来源必须是 base64:// 或 file://；本地文件请先读成 Buffer');
  }
  return [{ type: 'record', data: { file } }];
}

/** 目标 → OneBot action 与 body 片段。 */
export function targetPayload(target) {
  const parsed = typeof target === 'string' ? parseTargetKey(target) : target;
  if (!parsed) throw new Error(`目标格式不对：需要 group:<群号> 或 private:<QQ>，收到「${String(target)}」`);
  return parsed.kind === 'group'
    ? { action: 'send_group_msg', body: { group_id: Number(parsed.id) }, parsed }
    : { action: 'send_private_msg', body: { user_id: Number(parsed.id) }, parsed };
}

/**
 * 发送前检查（纯逻辑，不发请求）。
 * @returns {{ok:boolean, reasons:string[], info:object|null}}
 */
export async function preflightSend(file, { maxBytes = DEFAULT_MAX_BYTES, maxSeconds = DEFAULT_MAX_SECONDS, ffprobePath = 'ffprobe' } = {}) {
  const reasons = [];
  if (!isAudioFile(file)) reasons.push(`不是支持的音频格式（${path.extname(file) || '无扩展名'}）`);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    reasons.push(`文件不存在：${file}`);
  }
  if (stat && stat.size > maxBytes) reasons.push(`文件 ${formatBytes(stat.size)} 超过上限 ${formatBytes(maxBytes)}`);
  const info = reasons.length ? null : await inspectAudio(file, { ffprobePath });
  if (info && !info.ok) reasons.push(`探测失败：${info.reason ?? 'ffprobe 不可用（时长无法校验）'}`);
  if (info?.ok && Number(info.seconds) > maxSeconds) reasons.push(`时长 ${info.seconds}s 超过上限 ${maxSeconds}s`);
  return { ok: reasons.length === 0, reasons, info, size: stat?.size ?? null };
}

/**
 * 发送一条语音。
 * @param {object} args
 * @param {string} args.httpUrl   OneBot HTTP API 根地址，如 http://127.0.0.1:3000
 * @param {string} [args.accessToken]
 * @param {string} args.target    `group:<id>` / `private:<id>`
 * @param {Buffer|string} args.source
 * @param {object} [args.options] buildRecordMessage 的选项
 * @param {boolean} [args.dryRun] 只返回将要发出的 payload
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ok:boolean, dryRun?:boolean, payload:object, response?:object, error?:string}>}
 */
export async function sendVoice({ httpUrl, accessToken, target, source, options = {}, dryRun = false, timeoutMs = 30000 } = {}) {
  const { action, body, parsed } = targetPayload(target);
  const message = buildRecordMessage(source, options);
  const payload = { ...body, message };
  if (dryRun) return { ok: true, dryRun: true, payload, action, target: parsed.key };

  const base = String(httpUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('缺少 httpUrl（OneBot HTTP API 地址）');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 网关偶尔回纯文本（例如 401 的认证失败页），不能当成功
    }
    const ok = response.ok && json?.status !== 'failed' && json?.retcode !== 1;
    return { ok, payload, action, target: parsed.key, response: json ?? { raw: text.slice(0, 500) }, status: response.status };
  } catch (error) {
    return { ok: false, payload, action, target: parsed.key, error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}
