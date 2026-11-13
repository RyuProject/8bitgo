# j2me-web

在浏览器里直接运行老手机 Java 游戏（J2ME / MIDP，`.jar`）—— 电脑和手机都能玩，纯前端，不需要安装任何东西。

**j2me-web** 是一个用 TypeScript 从零写的 J2ME 运行时：它内置了一个小 JVM，直接解释 MIDlet 的字节码，并把 CLDC / MIDP 的 API 实现到 HTML canvas、WebAudio 和浏览器存储之上。所以游戏是**原样运行**的 —— 关卡、数值、碰撞都和当年手机上一模一样，不是重制、不是移植。

- **文件不上传。** 运行器不附带任何游戏。你打开自己的 `.jar`，它和游戏的存档只存在你自己的浏览器里（IndexedDB + localStorage）。
- **零依赖运行。** 没有 Docker、没有真 JVM、没有 WASM、没有后端、没有 CDN 追踪。构建产物是 4 个文件，gzip 后约 50 KB。
- **为今天的设备做的。** 键盘、手柄、触屏虚拟按键，像素级整数缩放，全屏支持。

---

## 支持到什么程度

**已实现**

| 领域 | 内容 |
| --- | --- |
| 虚拟机 | 字节码解释器、多线程、`synchronized` / `wait` / `notify`、`Class` / `Reflection` 基础 |
| 图形 | `Canvas`、`GameCanvas`、`Graphics`、`Image`、`Font`、`Command`、`Alert` / `AlertType` |
| 图片格式 | PNG（含交错）、**JPEG**（基线 / 渐进式 / 灰度 / CMYK，4:4:4 / 4:2:2 / 4:2:0） |
| 音频 | `javax.microedition.media` 完整签名 + **真 MIDI 播放**（自研 SMF 解析器 + WebAudio 合成器） |
| 存储 | `RecordStore` 全套（记录枚举、过滤器、比较器、变更监听），落到 localStorage |
| 工具类 | `Vector`、`Hashtable`、`Random`、`String` / `StringBuffer`、`Date`、`Calendar`、`Timer` |
| 三星扩展 | `AudioClip`、`Vibration`、`LCDLight` |
| 其它 | 屏幕尺寸自动探测（清单 / 文件名 / 游戏实际绘图）、按键映射修复、按游戏的可配置预设 |

**暂不支持**

- 表单类界面：`Form`、`List`、`TextBox`、`TextField`、`ChoiceGroup`（目前会打警告并跳过，Canvas 类游戏不受影响）
- 音频格式：除 MIDI 外仍是静音分支（wav / amr / mp3）
- 3D API：M3G、Mascot Capsule
- `invokedynamic`（Java 7+ 字节码；绝大多数 2000 年代中期的 J2ME 游戏不用它）
- 诺基亚 UI 扩展 API

---

## 操作方式

| 键盘 | 手机 |
| --- | --- |
| 方向键 | 摇杆 |
| Enter / Space | 中键 |
| F1 或 Q / F2 或 E | 左 / 右软键 |
| 0–9、− / = | 数字、`*` / `#` |
| Backspace | 清除 |

手柄使用标准映射（十字键 / 左摇杆，A = 中键，肩键 = 软键）。触屏设备下方会自动出现十字键、动作键和数字键盘。

老游戏常见的按键问题也做了修复：按住方向键后再按其它键会丢状态（松开其它键时补发方向键）；可选的组合键（例如 方向 + 跳跃 = 斜跳）。

---

## 架构

```
src/
├── jar/        解包 .jar
├── jvm/        虚拟机核心
│   ├── classfile.ts      class 文件解析
│   ├── descriptor.ts     方法/字段描述符
│   ├── interpreter.ts    字节码执行
│   ├── jvm.ts            类加载、方法解析
│   ├── thread.ts         线程调度
│   └── natives/          CLDC / MIDP API 实现，按包分文件
│       ├── lang.ts       Object / String / Math / Thread / System
│       ├── io.ts         java.io 流
│       ├── util.ts       Vector / Hashtable / Date / Calendar / Timer
│       ├── lcdui.ts      Display / Canvas / Graphics / Image / Font / Alert
│       ├── media.ts      javax.microedition.media + MIDI 播放
│       ├── rms.ts        RecordStore
│       ├── midlet.ts     MIDlet 生命周期
│       └── vendor.ts     三星扩展
├── gfx/        PNG / JPEG 解码
├── midi/       SMF 解析（smf.ts）+ WebAudio 合成（synth.ts）
├── platform/   浏览器侧实现：canvas、音频、localStorage、字体
├── player/     游戏生命周期、输入、设备适配、预设
├── ui/         界面与触屏控件
└── main.ts
```

关键分层：`jvm/natives/` 决定 API 的**语义**，`platform/` 决定它**怎么落地到浏览器**。加一个新 API 只动前者，改渲染只动后者。

---

## 开发

```bash
npm install
npm run dev
```

开发时想自动加载本地游戏，把路径写进 `.env.local`（已被 git 忽略），然后打开 `http://localhost:5173/?dev`：

```
J2ME_DEV_JAR=/path/to/game.jar
```

辅助工具：

- `npm run refs -- game.jar` —— 列出这个游戏用到了哪些平台类和 API
- `npm run javap -- game.jar ClassName [method]` —— 反汇编字节码

排查游戏兼容性时这两个非常有用：先用 `refs` 看它依赖什么，如果某个包缺失或行为不对，再用 `javap` 看它到底怎么调用的。

部署：`npm run build` 后把 `dist/` 丢到任意静态服务器即可。构建使用相对路径，放在子目录（`github.io/<repo>`、`/games/j2me/`）也能正常工作。

完整方法论（约束、选型轴、git-based vs artifact-based、五层验证）见
**[docs/静态托管方法论.md](docs/静态托管方法论.md)**。

### 静态托管

构建产物是**纯静态**，没有后端、没有 SSR、没有 WASM、没有 CDN 依赖，没有任何运行时外部请求。丢到哪儿都能跑：

- 任意静态托管：GitHub Pages、Cloudflare Pages、Nginx、对象存储
- 放子目录可以（`base: './'` 走相对路径）
- `file://` 直接打开 `index.html` 也能跑

正式构建 4 个文件，gzip 后约 50 KB。

### 存档导入导出

**只有一种存档格式，一个 `.jsav` 文件里可以装多个游戏。** 你不需要区分
「备份」和「分享」，导入时程序会自己看文件里有几个游戏就写几个。

游戏库顶部有两个按钮：

| 按钮 | 作用 |
| --- | --- |
| **备份全部** | 一个文件存下所有游戏的进度 + 游戏本体 |
| **恢复备份** | 读回这个文件；存档里带了 jar 而库里没有的游戏，会直接放进库里 |

游戏内工具栏的 `⇅` 按钮则针对单个游戏：导出得到一个自包含的 `.jsav`，
可以自己留底，也可以把游戏连同进度一起发给朋友，对方导入即可直接玩，
不需要先去找 jar。

几个实现上的取舍：

- **默认只补空缺**，不覆盖已有进度；要覆盖得主动勾选
- 每个存档记住导出时的 `storageId`，所以**库界面版导出的存档，打包版也认**
  （两边身份不同，导入时同时写到两个身份下，不需要迁移）
- 库里有、但身份对不上的孤儿存档也会一起备份，不会弄丢
- 格式与版本都有校验，坏文件直接报错而不是静默写坏数据
- 恢复进度后需要重启游戏才生效

### 单游戏打包（实验性）

除了「上传 jar」的形态，还支持把模拟器和某个游戏编译进**同一个静态页面**，
打开即玩，不显示库界面，也不出现 jar / J2ME 这些概念：

```bash
npx vite build --config experiments/pack-jianxin/vite.pack.config.ts
```

产物同样是纯静态，丢到任意静态托管即可（实测一份商业游戏：3 个文件
1.72 MB，压缩后 1.20 MB）。游戏 jar 需要自己准备，不入仓库。

**含商业游戏的产物不能用 git-based 托管**（Pages 从仓库构建，
jar 进历史就等于公开分发且删不干净），要用 direct upload。
判断依据见 [docs/静态托管方法论.md](docs/静态托管方法论.md) 第 4 章。

详见 [experiments/README.md](experiments/README.md)。

---

## 相关项目

| 项目 | 说明 |
| --- | --- |
| [xianjian-wangqing-web](https://github.com/chentianxiong123/xianjian-wangqing-web) | 《仙剑奇侠传-忘情篇》的 J2ME 逆向工程与复刻尝试（已结案中止，剧情覆盖率 20.6%）。它的 73 类反编译源码、9976 个地图对象、1146 条脚本是**认识这个游戏内部如何工作的权威资料** —— 本运行时遇到反常行为时的对照物。两者互补：它负责解释清楚，本项目负责跑起来。 |

也可以看那份文档：它结案时写的
[「替代方案：别复刻了，直接跑原版 jar」](https://github.com/chentianxiong123/xianjian-wangqing-web/blob/master/4-文档/替代方案-j2me-web.md)
—— 里面有本仓库静态部署、单游戏打包、存档导入导出的用法摘录，
以及「测试全绿 ≠ 游戏能玩」这类教训。

---

## 许可

MIT

本项目基于 MIT 许可的第三方 J2ME 运行时开发，原作者版权声明保留在 [LICENSE](LICENSE) 中。