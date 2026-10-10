<div align="center">

# 🍔 麦麦宠物 McPet

**点麦当劳 = 喂宠物。**

用麦当劳官方 MCP 的**真实营养数据**驱动一只像素小宠物：<br>
你吃什么，它就变成什么样。

[**🎮 立即体验（零配置，打开就玩）**](https://zhangjunzhe349-coder.github.io/mcpet/) ·
[技术架构](#-技术架构) · [参赛声明](CONTEST_DECLARATION.md)

<img src="assets/screenshot-mobile.png" alt="麦麦宠物 McPet 手机端界面" width="330">

</div>

---

## 这是什么

一只叫**麦麦**的像素小宠物住在这个网页里。你选一份麦当劳餐品喂它，
它会根据这份餐品的**真实营养数据**（热量 / 蛋白质 / 脂肪 / 碳水 / 钠 / 钙）给出不同反应：

| 你这餐的情况 | 麦麦的反应 |
|---|---|
| 高蛋白 · 热量适中 | 浑身发光 ✨「这顿好轻盈，我浑身在发光」 |
| 热量超标 | 肚子撑圆 🥲「呃…肚子圆了一圈，让我躺会儿」 |
| 钠太高 | 吐舌头流汗 💧「好咸好咸！我要喝水！！」 |
| 碳水太高 | 眼皮下沉 😴「碳水好高…想躺平」 |

同时给你一份**麦麦健康分（0-100）**、一张**营养雷达图**、逐项对照条形图，
以及一句针对你这一餐最短板的具体建议。

> 表面上是养宠物，**本质是一个营养健康分析工具** —— 只不过它让你愿意每天都打开。

## 为什么做这个

麦当劳餐品的营养数据一直公开可查，但都是**冷冰冰的表格**。没人会在点餐前认真读一张营养成分表。

麦麦宠物做的是同一件事的**另一种包装**：把「钠 1041 mg 超标了」翻译成
「麦麦渴得吐舌头」。信息量没少，但你会看，还会截图发给朋友。

## 怎么玩

1. 打开 [Demo 页面](https://zhangjunzhe349-coder.github.io/mcpet/)（**不需要 Token，不需要配置**）
2. 在「喂麦麦」里搜一份餐品，比如「板烧」「巨无霸」
3. 看麦麦的反应 + 你的健康分
4. 想深入一点 → 切到「营养档案」看雷达图和逐项对照
5. 想知道自己最近吃了啥 → 切到「MCP 能力」，复制指令到 WorkBuddy 里执行 `order-list`，
   把结果贴回来生成一张**饮食报告**

<p align="center">
  <img src="assets/screenshot-desktop.png" alt="桌面端界面" width="620">
</p>

---

## 🔧 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  浏览器（index.html · 单文件 · 零依赖）                    │
│  ├─ 像素宠物渲染器（Canvas，20×20 网格，5 种状态）          │
│  ├─ 麦麦健康分算法（蛋白30 + 热量25 + 钠20 + 脂肪15 + 碳水10）│
│  ├─ 营养可视化（SVG 雷达图 + 逐项对照条形图）                │
│  └─ 内联营养数据集快照（158 条 × 9 字段）                   │
└─────────────────────────────────────────────────────────┘
                          ▲
        list-nutrition-foods 的快照（构建时内联）
                          │
┌─────────────────────────────────────────────────────────┐
│  麦当劳中国官方 MCP · https://mcp.mcd.cn                  │
│  ├─ list-nutrition-foods   ← 核心：营养数据（无入参）      │
│  ├─ auto-bind-coupons      ← 一键领券                    │
│  ├─ campaign-calendar      ← 活动日历                    │
│  ├─ query-nearby-stores    ← 附近门店                    │
│  └─ order-list             ← 历史订单 → 饮食报告          │
└─────────────────────────────────────────────────────────┘
```

### 为什么 Demo 不用 Token 也能玩

`list-nutrition-foods` **没有入参**，返回的是一张**不随门店变化的全量表**
（实测 158 条去重餐品）。既然它是静态数据，构建时把它快照进 `data/nutrition.json`
并内联到页面，就能实现官方要求的「**零门槛体验入口：打开网页就能玩**」。

而需要 Token 的能力（领券 / 活动 / 门店 / 订单）**不在前端硬编码调用** ——
页面生成一段指令，由你在 WorkBuddy 里执行，MCP 调用发生在 Agent 侧。
这样既保证「真实使用 MCP」，又不需要把 Token 交给浏览器。

详见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)。

## 麦麦健康分怎么算

满分 100，五个维度分段线性评分，越健康越高：

| 维度 | 满分 | 满分线 | 归零线 |
|---|---:|---|---|
| 蛋白质 | 30 | ≥ 25 g | — |
| 热量 | 25 | ≤ 250 kcal | ≥ 1100 kcal |
| 钠 | 20 | ≤ 400 mg | ≥ 2000 mg |
| 脂肪 | 15 | ≤ 10 g | ≥ 60 g |
| 碳水 | 10 | ≤ 35 g | ≥ 120 g |

评级：**S** ≥85 · **A** ≥70 · **B** ≥55 · **C** ≥40 · **D** <40

算法实现在 `src/index.template.html` 的 `healthScore()`，欢迎按自己的标准改。

## 快速开始

### 方式一：直接用（推荐）

下载 `index.html`，双击打开。就这一个文件，没有依赖、没有构建、没有网络请求。

```bash
curl -O https://raw.githubusercontent.com/zhangjunzhe349-coder/mcpet/main/index.html
open index.html      # Windows: start index.html
```

### 方式二：本地改代码

```bash
git clone https://github.com/zhangjunzhe349-coder/mcpet.git
cd mcpet

# 重新抓取最新营养数据（需要 MCP Token）
export MCD_MCP_TOKEN="你的Token"      # https://open.mcd.cn/mcp 控制台激活获取

# 从模板 + 数据集重新生成单文件页面
python tools/build.py

# 无头浏览器全量校验（渲染 / 交互 / 手机适配 / 截图）
node tools/browser-check.js
```

### 方式三：接到你自己的 WorkBuddy 里

把 `SKILL.md` 放进你的技能目录（详见 [SKILL.md](SKILL.md)），
就可以直接对 WorkBuddy 说「喂麦麦吃一份巨无霸，看看它健康分多少」。

## 项目结构

```
mcpet/
├── index.html                  ← 构建产物：单文件 Demo（可直接部署/分享）
├── SKILL.md                    ← Agent Skill 定义（让 WorkBuddy 会用「麦麦宠物」）
├── MCP_INTEGRATION.md          ← MCP 接入说明：工具、调用流程、业务价值
├── mcp-config.example.json     ← MCP 配置示例（仅环境变量占位符）
├── workbuddy.md                ← WorkBuddy 开发对话上下文
├── CONTEST_DECLARATION.md      ← 参赛声明（官方原文）
├── LICENSE                     ← MIT
├── data/
│   └── nutrition.json          ← MCP 营养数据快照（158 条 × 9 字段）
├── src/
│   └── index.template.html     ← 页面源文件（含占位符）
├── tools/
│   ├── build.py                ← 构建：模板 + 数据 → index.html
│   └── browser-check.js        ← 无头浏览器全量校验
└── assets/
    └── screenshot-*.png
```

## 数据来源

全部营养数据来自**麦当劳中国官方 MCP** 的 `list-nutrition-foods` 工具，
经 `tools/build.py` 快照内联。数据字段与单位：

| 字段 | 单位 | 说明 |
|---|---|---|
| `energyKj` / `energyKcal` | kJ / kcal | 能量（本页以 kcal 展示） |
| `protein` | g | 蛋白质 |
| `fat` | g | 脂肪 |
| `carbohydrate` | g | 碳水化合物 |
| `sodium` | mg | 钠 |
| `calcium` | mg | 钙 |

> MCP 不提供的数据（本页也不编造）：单独含糖量、膳食纤维、饱和/反式脂肪、加维生素明细、加工程度评分。

---

<div align="center">

**麦麦宠物 McPet** · 麦当劳程序员节创意开发大赛参赛作品

本项目由参赛者独立开发，**非麦当劳官方产品**。<br>
页面输出仅供参考，不构成医疗、营养或其他专业建议。<br>
餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。

MIT License © 2026 张俊哲 (Jayzen)

</div>
