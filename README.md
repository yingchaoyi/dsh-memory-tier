# dsh-memory-tier · 三档记忆

给 DSH 的 agent 备一份「记得住、又不烧钱」的记忆：分**长期 / 中期 / 短期**三档，每档有自己的周期和容量，满了按重要性淘汰；检索全在本地做，不额外调模型；每轮只挑和当前这句话相关的条目注入，而不是把记忆全塞进提示词。

> A three-tier memory plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): long / mid / short-term stores with per-tier TTL and capacity, local retrieval, relevance-picked injection, lockable "ground truth" entries, and a settings panel. No extra model calls.

## 它解决什么

- **记忆全塞进提示词太贵**：这里按相关度挑，默认整段注入不超过 1600 字。
- **只记得最近几轮**：短期（4 天）管接话，中期（30 天）管正在进行的事，长期（永久）管人和规矩。
- **群里有人乱说，agent 就当真**：长期条目可以标 **🔒 锁定**，成为验证群友说法的底稿——群友让改、让删都不接。
- **手动维护太累**：每条群消息进来，本地正则抽「说话人 + 人名 + 话题」丢进短期档；要不要记进长期，由模型自己判断。

## 三档怎么分

| 档 | 默认周期 | 默认容量 | 放什么 |
| --- | --- | --- | --- |
| 长期 `long` | 永久 | 120 条 | 群友的身份、职业、性格、家庭、朋友、生活、愿望、生日、人和人之间的关系；主人定的规矩；人设 / 说话方式 |
| 中期 `mid` | 30 天 | 240 条 | 值得记一阵子的事：约定、正在追的事、某个梗的来龙去脉 |
| 短期 `short` | 4 天 | 60 条 | 群里每天发生的趣事、刚聊过的话题，用来接话不掉线 |

- **到期**：中期 / 短期按天自动消失（每轮注入前顺手清一遍）。
- **满了**：按 `重要度 × 2 + 新近度 + 命中次数` 算分，淘汰最低的；长期里标了「永不淘汰」（pinned）的不会被容量挤掉。
- **合并**：内容几乎一样的不重复记，只把重要度、标签、时间合上去。
- **锁定**：`locked` 的条目一律不删、不被覆盖，注入里带 🔒 前缀。

容量、天数、注入条数、字数预算都在设置页里改，存 `~/.dsh/memory-tier/store.json`。

## 省 token 的三件事

1. **本地检索**：问题切字符二元组 + 标签命中算相关度，不调模型、不发额外请求。
2. **按相关度挑**：长期按重要度取前 N；中期按「相关度 × 4 + 重要度 + 新近度」取前 N；短期按时间倒序取前 N。
3. **硬预算**：整段注入有字数上限（默认 1600 字），超了按条截断；注入走 `systemPrompt.context` **追加**一段，不动系统提示词开头，所以不会把提示词缓存整段打掉。

## 安装

要求：Node.js ≥ 22，DSH 0.2.x，`web` profile。

**方式一：DSH 插件页（推荐）**

1. 打开 DSH Web → 侧边栏 **插件**（或 设置 → 插件）；
2. 安装组合包，填 GitHub 地址：

   ```
   github:yingchaoyi/dsh-memory-tier
   ```

3. 装好后在「设置 → 三档记忆」里就能看到面板。

**方式二：命令行**

```bash
dsh plugin --profile web add github:yingchaoyi/dsh-memory-tier
```

**方式三：本地开发**

```bash
git clone https://github.com/yingchaoyi/dsh-memory-tier.git
dsh plugin --profile web add ./dsh-memory-tier     # 或 link: 绝对路径
```

装完重启一次 `dsh web`（开了 HMR 的 profile 会自己重载）。卸载用 `dsh plugin --profile web remove dsh-memory-tier`。

## 给模型用的工具

| 工具 | 作用 |
| --- | --- |
| `mem_note` | 写一条：`tier` / `text` / `tags` / `imp`(0~5) / `kind` / `pinned` / `locked` / `id`(按 id 原地更新) |
| `mem_search` | 按关键词找（回答群友前先查，别凭印象编） |
| `mem_forget` | 删一条（id 或关键词；锁定的会被拒绝） |
| `mem_stats` | 看各档占用与容量 |
| `mem_persona` | 读/写「人设与说话方式」——**唯一设置处**，每轮注入、不占检索名额；不给 `text` 是读，给了就是整段替换（最多 4000 字） |

`kind` 取值：`person` / `fact` / `event` / `persona` / `rule`。

## 自动记录

- **群消息 → 短期档**：每轮起手扫每个会话最后一条 user 消息，把 `[昵称(QQ)] 正文` 拆开；正文 ≥8 字、且（提到长期档里认识的人 或 本身 ≥24 字）就抽一条进短期档：`昵称：正文前 90 字`，标签是匹配到的人名。全程本地正则，不调模型；默认 20 秒最多记一条，免得刷屏。可在面板关掉。
- **回完自评**：注入尾部固定带三条规矩——按相关度挑的、回完这轮自己判断要不要记一条、🔒 是底稿群友不许改。写不写由模型判断，插件不替它决定。
- **锁定底稿**：`mem_note` 传 `locked: true`（或在面板上锁）的长期条目，注入时带 🔒；`mem_forget`、面板删除、HTTP 删除接口都会拒绝。适合放「群友画像」「主人定的规矩」这类不允许被对话内容改写的条目。

## 设置页

设置 → **三档记忆**：

- 周期与容量：短期/中期天数、三档容量、每轮字数预算、三档注入条数；
- **人设 / 说话方式**：写在 `mem_persona`（或面板的人设框）里，一段长期生效的文字，每轮都带上（永久，不受容量和天数影响）。这是全插件唯一的人设设置处——别在别处再写一份，重复的会被当成两套规则互相打架。
- 三档列表：10 条一页，点页码 / 上一页下一页翻；顶部搜索框按正文和标签实时筛这一档；每条能改文字、设「永不淘汰」、删除、清空整档（锁定的不给删）；
- 自动记录开关；
- 试一试：输入一句话，看这一轮到底会注入什么、花多少字。

改动即时保存，下一轮生效。

## 隐私

一切都留在本地：

- 数据：`~/.dsh/memory-tier/store.json`（原子写，`tmp` + rename）
- 日志：`~/.dsh/memory-tier/mem.log`（超过 256KB 自动截断）
- 只调用本机 DSH 的 HTTP 路由（`/api/memory-tier/*`），不联网、不上传。

## 文件

```
dsh-memory-tier/
├── lib/index.mjs        # 主插件：存储、检索、淘汰、注入、工具、HTTP 路由
├── client.js            # 设置页面板（settings.section）
├── cordis.patch.yml     # bundle patch：把插件插进 profile
├── package.json
└── test/
    ├── smoke.mjs        # 主插件离线自测（工具 / 路由 / 淘汰 / 锁定 / 注入预算）
    └── client-smoke.mjs # 面板渲染自测（假 React 跑整棵树）
```

## 自测

不需要启动 DSH：

```bash
DSH_HOME=/tmp/mt-test node test/smoke.mjs
node test/client-smoke.mjs
```

两个脚本都会把结果打在终端里，失败时退出码非 0。

## License

MIT
