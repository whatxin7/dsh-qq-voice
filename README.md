# dsh-qq-voice

> **一句话**：把「发一条 QQ 语音」拆成四件可测的事 —— 找到文件、验它能不能发、按需调音量、把 `record` 段投给 OneBot。
>
> 从 `qq-bridge` 抽出的独立项目，对应成本统计里 **「语音 / 唱歌 / 音色」** 这条线。

---

## 为什么单独拆出来

语音是整条链路上**最容易"看起来发了其实没发"**的一环：

- 格式不对 → 网关静默转码失败，QQ 侧什么都不显示；
- 体积过大 → 请求超时，日志里只有一行 `timeout`；
- 音量太小 → 用户听到的是"一串电流声"；
- 歌本名字对不上 → 模型编一个歌名发出去，听起来像在骗人。

所以这里的原则是：**能离线判定的一律离线判定**，发送前给一份"会不会成功"的预检；歌名对不上就报候选，绝不猜。

## 安装

```bash
git clone https://github.com/whatxin7/dsh-qq-voice.git
cd dsh-qq-voice
node --test                 # 16 个用例
node bin/voice.mjs doctor   # 环境体检：Node / 语音库 / 歌本 / ffmpeg / ffprobe
```

需要 Node ≥ 20；调音量与时长校验需要 `ffmpeg` / `ffprobe` 在 PATH（或用 `--ffmpeg` / `FFMPEG_PATH` 指定）。

```
Node        v24.21.0
语音库      ./audio（179 个音频）
歌本        ./songbook（175 首）
ffmpeg      ffmpeg
ffprobe     可用（4秒 · 275.1 KB · pcm_s16le · 32.0kHz · 单声道）
上限        单条 20.00 MB / 5分00秒
```

## 用法

```bash
# 语音库里有什么
voice list --dir ./audio

# 这个文件能不能发（探测 + 预检，不发请求）
voice inspect ./audio/晚安.mp3
voice plan group:123456 ./audio/晚安.mp3 --volume 2

# 歌本
voice songbook --songbook ./songbook
voice sing group:123456 起风了 --dry-run          # 只算 payload，不出网
voice sing group:123456 起风了 --http http://127.0.0.1:3000 --token YOUR_TOKEN

# 直接发某个文件；音量 2 倍 / 智能响度 loud
voice send private:10001 ./audio/晚安.mp3 --volume 2 --http http://127.0.0.1:3000
voice send group:123456 ./audio/晚安.mp3 --loudness loud --http http://127.0.0.1:3000
```

默认语音库 `$VOICE_DIR` → `./audio`；默认歌本 `$SONGBOOK_DIR` → `./songbook`。

`--dry-run`（或不给 `--http`）只打印将要发送的 action 与 base64 长度，**不出网** —— 排障时先用它确认"消息造对了"。

## 四个环节

| 环节 | 模块 | 关键约束 |
|---|---|---|
| 找文件 | `resolveAudioSource` | 绝对路径 → cwd → 语音库 → 补扩展名 → 语音库同名模糊；找不到返回候选而不是猜 |
| 验能不能发 | `preflightSend` + `inspectAudio` | 扩展名白名单、体积上限 20 MB、时长上限 300 s、ffprobe 可用 |
| 调音量 | `processAudioVolume` | `record` 段没有增益字段，必须在本地用 ffmpeg 产出新文件；`loudnorm` 走 EBU R128 |
| 发出去 | `buildRecordMessage` + `sendVoice` | 音频 base64 内联（不依赖同机同路径）、`send_group_msg` / `send_private_msg`、Bearer token |

### 为什么音频要 base64 内联

`record` 段的 `file` 支持 `file://` 与 `base64://`。`file://` 只有在**网关和你在同一个文件系统**时才成立 —— 网关跑在容器、另一台机器、或 Windows 服务账号下时，路径就失效了。所以默认 base64（`--as-path` 才用路径），代价是请求体变大：20 MB 上限在 base64 后约 27 MB，这也是上限设成 20 MB 的原因之一。

### 音量为什么在本地做

SnowLuma 只接受音频文件并自己转 SILK，`record` 段里**没有音量/增益字段**。想说"大声点"只有一条路：本地 ffmpeg 处理完，把结果当普通音频发出去。

两种模式：

- `--volume 2`：倍数（0.1–4），直观可复现；
- `--loudness quiet|normal|loud` 或 `--loudness -16`：EBU R128 响度归一。对"录音忽大忽小 / 整体太小"最有效，但会**大幅改变动态** —— 有音乐/音效的内容别用。

## 歌本

歌本目录里**文件名就是歌名**（`起风了.wav`）。点歌规则：

1. 归一化（全角→半角、去空白/标点/书名号、忽略大小写）后精确命中 → 发；
2. 唯一子串命中 → 发；
3. 命中多首 → **列候选让人挑，不猜**；
4. 没命中 → 明说"歌本里没有这首"。

`--random` 随机挑一首。歌本只收你真唱过的段落：合成旋律和真人声对不上，一听就知道是假的。

## 作为库用

```js
import { inspectAudio, resolveAudioProcessing, processAudioVolume } from 'dsh-qq-voice';
import { matchSong, listSongs } from 'dsh-qq-voice/songbook';
import { sendVoice } from 'dsh-qq-voice/send';

const info = await inspectAudio('./audio/晚安.mp3');
const proc = await processAudioVolume('./audio/晚安.mp3', resolveAudioProcessing({ volume: 2 }));
const result = await sendVoice({
  httpUrl: 'http://127.0.0.1:3000',
  accessToken: process.env.ONEBOT_TOKEN,
  target: 'group:123456',
  source: (await import('node:fs')).readFileSync(proc.path)
});
```

`src/snowluma-conn.js` 还带一个 OneBot 连接发现器（从 SnowLuma 的配置文件里读 ws/http 地址与 access token，读不到就报缺什么），适合"装完就想发一条"的场景。

## 已知边界

- `probeAudio` 把 ffprobe 结果写临时文件再读（受限沙箱里 pipe 会 EPERM），所以需要可写的临时目录。
- 只实现 OneBot v11 的 `send_*_msg`；`upload_group_file` 这类扩展动作不在范围内。
- 不做 TTS 合成：本项目只负责"已有的音频怎么发好"。合成属于另一个项目（persona / 音色侧）。
- 语音库、歌本都是本地目录，不做云同步。

## 项目家族

| 项目 | 对应成本条目 |
|---|---|
| **dsh-qq-voice**（本仓库） | 语音 / 唱歌 / 音色 |
| [dsh-token-meter](https://github.com/whatxin7/dsh-token-meter) | 用量与成本核算 |
| [dsh-qq-access](https://github.com/whatxin7/dsh-qq-access) | 好友 / 白名单 / 权限 |
| [dsh-qq-stickers](https://github.com/whatxin7/dsh-qq-stickers) | 表情包 / 斗图 |
| [dsh-mcp-safe-tools](https://github.com/whatxin7/dsh-mcp-safe-tools) | 能力扩展（视觉 / 搜索 / 语感） |
| [dsh-session-link](https://github.com/whatxin7/dsh-session-link) | 联通会话 / 行为调优 |
| [dsh-persona-kit](https://github.com/whatxin7/dsh-persona-kit) | 人格 / 角色卡 |
| [qq-bridge](https://github.com/whatxin7/qq-bridge) | 桥接内核（旗舰仓库） |

## English

A QQ voice toolkit: library scanning, `ffprobe` inspection, ffmpeg volume/R128 loudness processing, conservative songbook matching (exact → unique substring → candidates, never guess), and OneBot v11 `record` sending with base64 inlining and a dry-run mode. 16 offline tests.

## License

MIT © whatxin7


