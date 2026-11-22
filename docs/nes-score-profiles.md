# NES 分数布局配置

配置表位于 `src/data/nesScoreProfiles.ts` 的 `NES_SCORE_PROFILES`。每行对应一个游戏的一份**确切 ROM 版本**；运行时用游戏 slug 和核心实际载入的裸 ROM SHA-256 双重匹配。地址不会从同名游戏或相邻 ROM 修订版继承。

运行时读取接口是 `RuntimeHandle.readSystemRam(offset?, length?)`（原始 RAM 快照）和 `RuntimeHandle.readNesScore()`（匹配配置后的十进制字符串）；它们是前端运行时 API，不是 HTTP API。未确认分数布局前，可用玩家工具栏的 RAM 采样面板导出带画面分数标记的本地 JSON。

## 采集可供分析的样本

在游戏页 URL 加 `?nesRamTrace=1`（已有查询参数时改用 `&nesRamTrace=1`），然后开始 NES/FCEUmm 游戏。本地 ROM 页在此模式下会固定用 EmulatorJS/FCEUmm，以保证有 Libretro RAM 接口。此开关默认关闭；只有这次运行、用户点「开始 30 秒采样」后才读取 RAM。采样每 250ms 一次，最多 30 秒；ROM SHA-256 也只在按下开始后计算。数据不发到服务器。

在工具栏打开「RAM 采样」：

1. 官方游戏页会预填 slug；本地 ROM 请填站内正式 slug，暂时不知道可留空。
2. 在「画面上显示的分数」输入当前可见分数，再开始采样。这个初值会和第一份 RAM 快照配对。
3. 分数变化后输入新分数并点「记录当前分数」。尽量采到至少三个不同分数值；只有一个值或分数从未变化时，AI 不能可靠排除生命数、计时器等字段。
4. 停止或等 30 秒结束后下载 JSON，并把文件交给分析助手。

JSON 中 `samples` 是按时间记录的完整 RAM 十六进制快照；`labels` 的 `sampleIndex` 指向分数标记时额外采集的快照。`candidateScan` 会把标记样本逐字节扫描，列出按常见编码完全或部分解码匹配的候选、每个候选的原始字节和解码值；它只用于缩小 AI 的搜索范围，不能单凭命中发布配置。通常 NES/FCEUmm system RAM 是 2048 字节；实际长度写在 `ramBytes`。如果 `romSha256` 为 `null`，该次 ROM 指纹读取失败，先不要发布配置。

## 字段

| 字段 | 含义 |
| --- | --- |
| `gameSlug` | 站内游戏 slug。 |
| `romSha256` | 核心实际载入的裸 ROM 字节的 64 位小写 SHA-256；不是 ZIP / `.8bg` 外层文件哈希。 |
| `version` | 便于维护者识别的地区 / 修订版说明，不参与匹配。 |
| `byteOffsets` | system RAM 中分数占用字节的偏移，按 RAM 地址从小到大列出；可不连续。 |
| `encoding` | 字节解释方式，见下表。 |

| `encoding.kind` | 额外字段 | 规则 |
| --- | --- | --- |
| `binary` | `byteOrder: 'little' \| 'big'` | 无符号二进制整数，结果以十进制字符串返回。 |
| `packed-bcd` | `byteOrder`、`nibbleOrder: 'high-first' \| 'low-first'` | 每个半字节必须是 0–9；保留前导零。 |
| `decimal-digits` | `byteOrder` | 每个字节必须是 0–9；保留前导零。 |
| `ascii-decimal` | 无 | 每个字节必须是 ASCII `0`–`9`；保留前导零。 |

## 配置行模板

把下面对象加进 `NES_SCORE_PROFILES` 数组。尖括号是占位符，不能原样发布；地址与编码都要由游戏内分数变化的 RAM 样本确认。

```ts
{
  gameSlug: '<站内游戏 slug>',
  romSha256: '<裸 ROM 的 64 位小写 SHA-256>',
  version: '<地区 / 修订版>',
  byteOffsets: [0x00, 0x01],
  encoding: { kind: 'packed-bcd', byteOrder: 'little', nibbleOrder: 'high-first' },
},
```

未知配置、重复配置、非法 BCD / 数字字节、ROM 指纹不匹配或 RAM 越界都会返回 `null`，不影响游戏运行。分数以字符串返回，避免大整数精度损失和前导零丢失。

## 交给 Doubao 的提示词

只看 ROM 文件不足以可靠确认分数地址。请同时提供带标记的 `8bitgo.nes-ram-trace.v1` JSON；至少需要三个不同的已知画面分数，并对应至少三份 RAM 快照。样本里的时间序列可用于排除随时间变化的计时器、生命数和动画字段。

```text
你是 NES / FCEUmm 内存分析助手。请从我提供的游戏画面分数和 Libretro system RAM 快照中，寻找能稳定解码游戏当前分数的字节位置与编码。

重要约束：
1. 不要只凭 ROM 文件、游戏标题、常见地址表或单份 RAM 快照猜地址。ROM 文件只用于辅助确认游戏 / 修订版；分数布局必须由多份“画面显示分数 ↔ 同时采集的 RAM”样本验证。
2. `candidateScan` 是本地程序的连续字节预筛结果，不是结论。先核对它列出的 `rawBytesByLabel` 和 `decodedScores`，再回看完整时间序列；若候选扫描截断或没有结果，也要从原始快照检查非连续字段与其它排列。
3. 严格区分当前分数、最高分、生命数、时间、关卡号、随机种子和临时动画数据。只在多个样本中都能按同一规则还原画面当前分数时才判为确认。若分数在画面变化前就变、只在结算后变化或不随当前分数回退，要检查它是否为最高分 / 累计值。
4. 候选编码必须逐一检查：无符号二进制（little / big endian）、packed BCD（little / big endian，high-first / low-first）、每字节一个十进制数字、ASCII 十进制。
5. `byteOffsets` 使用从 system RAM 起点开始的 0-based 偏移，并按地址从小到大列出；如需跳过无关字节，只列实际承载分数的地址。
6. 不能确认时必须返回 `needs_more_samples`，说明还缺哪种样本；不要编造地址、ROM SHA-256、slug 或置信度。
7. 只有确认后才输出可加入代码配置表的 `profileEntry`。ROM SHA-256 必须是核心实际加载的裸 ROM 字节哈希，不是 zip / 8BG 外层包哈希。

输入：
- 8bitgo.nes-ram-trace.v1 JSON 文件：<附加完整文件，不要截断或改写>
- ROM 地区 / 修订版（未知可写 unknown）：<填写>
- 如有游戏内截图，可附上用于确认分数显示格式；RAM 标记时间以 JSON 为准。

JSON 的 `labels` 项包含画面分数和 `sampleIndex`；用该索引查 `samples` 数组中的同刻 RAM 快照。所有 RAM 偏移从 0 开始。请保留所有快照，不要只挑看起来相关的字节。候选报告的完整命中仍需由你对照原始快照确认。

请先列出候选字节偏移、每份样本的原始字节和解码值，再给出结论。`status` 只能是 `confirmed` 或 `needs_more_samples`；`confidence` 只能是 `high`、`medium` 或 `low`。严格输出以下 JSON，不要在 JSON 外补充内容：
{
  "status": "confirmed",
  "gameSlug": "输入的 slug 或 null",
  "romSha256": "输入的哈希或 null",
  "candidate": {
    "byteOffsets": [0, 1],
    "encoding": { "kind": "packed-bcd", "byteOrder": "little", "nibbleOrder": "high-first" },
    "decodedSamples": ["样本 A 解码值", "样本 B 解码值", "样本 C 解码值"]
  },
  "evidence": ["逐条说明样本如何支持 / 排除候选"],
  "confidence": "high",
  "missingSamples": [],
  "profileEntry": {
    "gameSlug": "...",
    "romSha256": "...",
    "version": "...",
    "byteOffsets": [0, 1],
    "encoding": { "kind": "packed-bcd", "byteOrder": "little", "nibbleOrder": "high-first" }
  }
}

若未确认，`candidate` 和 `profileEntry` 都必须为 null，`missingSamples` 写明要补采的具体状态；不得把低 / 中置信度结果伪装成可发布配置。
```
