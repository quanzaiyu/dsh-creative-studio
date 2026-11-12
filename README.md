# creative-studio · 创作展示台

一个 DSH（DeepSeek Harness）插件：多供应商 AI 创作工作台，支持 **生图 / 生视频 / 音乐 / 配音** 四种能力，纯文字提示词或附加多个参考图 / 参考视频 / 参考音频进行生成。

## 功能

- 🖼 **生图**：文生图、图生图 / 图像编辑（传参考图即切换）
- 🎬 **生视频**：文生视频、图生视频（首帧 / 多模态参考，部分供应商支持参考视频与音频）
- 🎵 **音乐**：提示词 + 歌词生成歌曲（供应商支持时）
- 🎙 **配音**：文本转语音，MOSS 支持上传参考音频自动克隆音色
- 🗂 **作品库**：生成结果自动落盘并进图库，支持预览 / 下载 / 删除
- ⚙️ **供应商设置**：API Key 存本机凭据存储，不回传浏览器
- 📌 **DSH 集成**：注册进 DSH 左侧菜单，以整页面板打开

## 支持的供应商与能力矩阵

| 供应商 | 生图 | 生视频 | 音乐 | 配音 | 备注 |
|---|---|---|---|---|---|
| MOSS（api.mosi.cn） | ✅ | — | — | ✅ 支持参考音频克隆音色 | |
| MiniMax（api.minimaxi.com） | ✅ | ✅ H3 首帧参考 | ⚠️ 新用户已停售 | ✅ t2a_v2 | 音频 hex 解码已处理 |
| 阿里云百炼（dashscope） | ✅ 万相 | ✅ 万相3.0 | ✅ fun-music | ✅ CosyVoice / Qwen-TTS | 异步任务轮询 |
| Agnes（apihub.agnes-ai.com） | ✅ 多参考图 | ✅ 2.5 多参考 | — | — | |
| 火山引擎（方舟 Ark） | ✅ Seedream | ✅ Seedance 多模态参考 | — | ✅ seed-audio（独立语音 Key） | |

## 安装（DSH）

一条命令安装并挂载（推荐）：

```bash
dsh plugin --profile web add @quanzaiyu/dsh-creative-studio
```

重启 DSH 宿主后，左侧菜单出现「创作展示台」。

<details>
<summary>手动 link 方式（本地开发）</summary>

1. 将本目录放到任意位置（例如 DSH 工作区内）。
2. 在 DSH 的 profile（通常 `C:\<user>\.dsh\profiles\web`）中：
   - `package.json` 的 dependencies 加入 `"@local/creative-studio": "link:<本目录绝对路径>"`；
   - 加入 `dsh.profile.bundles` 数组：`"@local/creative-studio"`；
   - 本地 `cordis.patch.yml` 需自行插入 \`{id: creative-studio, name: '@local/creative-studio'}\`。
3. `pnpm install` 后重启 DSH 宿主。
</details>

## API Key 配置

打开工作台右上角「⚙ 设置」，按供应商填入 Key（已配置的会显示 ✅）：

- \`MOSS_API_KEY\`、\`MINIMAX_CN_API_KEY\`、\`AGNES_API_KEY\`
- \`DASHSCOPE_API_KEY\`（百炼）
- \`ARK_API_KEY\` + \`VOLCANO_SPEECH_API_KEY\`（火山方舟 + 语音两把）

Key 保存在 DSH 凭据存储，不会回传浏览器、不写入仓库。

## 目录结构

\`\`\`
creative-studio/
├── index.js              # host 半区入口
├── client.js             # client 半区（左侧菜单 + 面板）
├── cordis.patch.yml      # 插件注册补丁
├── lib/
│   ├── server.js         # /studio 页面 + /studio/api/* + 资产服务
│   ├── store.js          # 凭据 / 配置 / 作品清单 / 任务
│   ├── registry.js       # 供应商注册中心（统一适配器契约）
│   ├── util.js
│   └── providers/        # moss / minimax / bailian / agnes / volcano
└── web/index.html        # 工作台单页应用
\`\`\`

## 新增供应商

在 \`lib/providers/\` 下新增一个适配器并注册进 \`registry.js\`：声明 \`capabilities.{image,video,music,tts}\` 的模型、参数表单、参考素材上限与 \`generate()\` 实现，即可自动出现在工作台。
