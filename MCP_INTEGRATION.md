# MCP 接入说明 · 麦麦营养账本 McPet

> 本文说明本项目**实际使用了哪些麦当劳 MCP Server 的工具、调用流程是怎样的、以及它为业务创造了什么价值**。
> 所有数据均为对线上 `https://mcp.mcd.cn` 真实调用所得，非模拟。

---

## 一、接入信息

| 项 | 值 |
|---|---|
| MCP Server | 麦当劳中国官方 MCP |
| 端点 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 认证 | `Authorization: Bearer <MCD_MCP_TOKEN>` |
| 协议版本 | `2025-06-18` |
| 限流 | 600 次 / 分钟 / Token |
| Token 获取 | https://open.mcd.cn/mcp → 手机号登录 → 控制台 → 激活 |

配置示例见 [`mcp-config.example.json`](mcp-config.example.json)（仅使用环境变量占位符，不含任何真实凭据）。

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer ${MCD_MCP_TOKEN}" }
    }
  }
}
```

---

## 二、实际使用的工具

线上该 Server 共返回 **35 个工具**，本项目使用其中 **7 个**，分工如下：

| 工具 | 角色 | 入参 | 项目中的用途 |
|---|---|---|---|
| `list-nutrition-foods` | **核心** | 无 | 取全部餐品的营养数据（热量/蛋白/脂肪/碳水/钠/钙），驱动健康分、每日额度与搭配顾问 |
| `query-meals` | **核心** | `storeCode`,`orderType`,`beType` | 取官方菜单数据，用其中的 `image` 字段落地**官方白底商品图**（126 条），让餐品一眼可辨 |
| `order-list` | 附属 | 可选 `lastId`,`size` | 「历史订单」——把真实消费贴回页面生成饮食报告 |
| `auto-bind-coupons` | 附属 | 无 | 「一键领券」 |
| `campaign-calendar` | 附属 | 无 | 「活动日历」 |
| `query-nearby-stores` | 附属 | `searchType`,`beType`,`city`,`keyword` | 「附近门店」 |
| `now-time-info` | 辅助 | 无 | 需要解析"本月/本周"这类相对时间时，先取服务器时间 |

> 另外 28 个工具（点餐下单、积分商城、抽奖、派对预约等）与本项目"营养记账"的定位无关，**刻意不接入** ——
> 本项目的差异化正是「不帮你点单、不帮你省钱，而是帮你记清楚吃得怎么样」。
>
> ⚠️ 明确说明：页面上的**实时榜单**数据**不来自麦当劳 MCP**，而是比赛仓库的 `RANKING.md`
> （`api.github.com`）。此处列为独立数据源，不与 MCP 混为一谈。

---

## 三、调用流程

### 3.1 主链路 A：营养数据 → 记账与健康分（核心）

```
① list-nutrition-foods {}                 ← 无入参，返回全量营养表
        │  返回 TOON 紧凑文本，含 9 字段
        ▼
② 解析 → 去重（160 条 → 158 条）→ 落盘 data/nutrition.json
        │
        ▼
③ tools/build.py 把数据集内联进 index.html
        │  至此，网页无需 Token 即可完整运行
        ▼
④ 用户挑餐品，加进「这一餐」组合篮子（可多选：汉堡 + 薯条 + 饮料 = 一顿）
        │
        ▼
⑤ 前端 healthScore()  算「麦麦健康分」(0-100)
   dailyBudget()      算今日额度与剩余（对照《中国居民膳食指南（2022）》）
   adviseBasket()     找最短板 → 给出具体加减建议
        │
        ▼
⑥ 六维营养条形图 + 雷达图 + 搭配顾问 + 麦麦的可视化反应（副产物）
        │
        ▼
⑦ 点「记账」→ 记入 localStorage 账本：
     · 今日额度累计扣减
     · 等级按累计餐数推进；麦麦体态按最近 12 餐的热量/脂肪/钠连续变化
     · 连续天数 + 12 项成就
```

### 3.1b 主链路 B：官方菜单 → 官方白底图（视觉层）

```
① query-meals { storeCode, orderType, beType }   ← 先 query-nearby-stores 找营业中门店
        │  返回菜单项，每项带 image 字段：
        │  https://menu-img.mcd.cn/pcm/prod/menu/.../MS_<code>_320.png
        ▼
② tools/fetch-food-photos.py 把菜单名与 158 条营养表对齐
   （剥离「小/中/大/迷你」「-2块」等规格词做别名归一）
        │
        ▼
③ 下载 → 内存中转 96×96 WebP（按 sha1 去重，同图只存一份）→ assets/food/
        │  实测 126/158 条对得上官方图，去重后 55 个文件 / 121 KB
        ▼
④ 生成 data/food-photos.json → tools/build.py 内联索引
        │
        ▼
⑤ 前端 iconHTML()：命中官方图就渲染 <img>，未命中落到程序化手绘图标（27 类）；
   图片加载失败自动回落到手绘，**绝不出现破图**
```

**真实调用取证**（`list-nutrition-foods`，2026-10-10 14:02:16）：

```json
{ "success": true, "code": 200, "message": "请求成功",
  "datetime": "2026-10-10 14:02:16",
  "traceId": "d0c8343513e4438d719b5670ce27c5b3",
  "data": "[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  猪柳麦满分,null,1288,308,16,16,24,781,213\n  ..." }
```

响应特征说明这是真实上游数据，不是本地造的：

- 顶层为 `{success, code, message, datetime, traceId, data}` —— 与麦当劳 MCP 的错误/成功结构一致
- `data` 是 **TOON 紧凑文本**（`[行数]{字段列表}:` + CSV 行），不是普通 JSON 数组 —— 这是该工具的真实返回格式
- 声明 160 条，其中 `小杯玉米杯`、`纯牛奶（盒装）` 各出现 2 次，去重后 **158 条**

### 3.2 附属链路：需要 Token 的能力（Agent 侧执行）

浏览器**不直接调用 MCP**，原因是：

1. 直连 `https://mcp.mcd.cn` 会受浏览器同源策略限制；
2. 若把 Token 放进前端，等于把用户凭据公开给任何人。

因此设计为**指令交接**（页面**不内置 MCP 面板**，保持"一个功能做好"的简洁；入口收敛在「今日」面板底部的导入框）：

```
用户想要复盘自己的真实消费
        ▼
在 WorkBuddy 里说一句自然语言，例如：
  「用麦当劳 MCP 查一下我最近的历史订单（order-list）」
        ▼
MCP 调用发生在 Agent 侧（Token 安全）
        ▼
把返回的 JSON 贴回网页「今日 → 导入订单」框
        ▼
前端解析 + 匹配营养库 → 生成「识别到 N 种餐品 / 平均健康分 / 合计热量 / 最高钠来源」报告
```

这样既满足「真实使用 MCP」，又实现了官方要求的「零门槛体验入口：打开网页就能玩，不需要配置 Token」。

---

## 四、业务价值

### 4.1 它解决了什么问题

麦当劳的餐品营养数据一直是公开的，但以**成分表**形式存在 —— 没有人会在点餐前认真读它。
本项目把同一份数据变成**你这一顿的账目**：

| 原始数据 | 账本里的说法 |
|---|---|
| 能量 1003 kcal | 占掉今天 **50%** 的热量额度 |
| 钠 1373 mg | 占掉今天 **69%** 的钠额度 ← 今天剩下的餐都得清淡点 |
| 蛋白 58 g | 蛋白质这项**已经超额达标** |
| 脂肪 65 g | 脂肪额度只剩 0，且这是今天脂肪的主要来源 |

（同一条数据在麦麦身上会变成表情和台词 —— 但那是**副产品的糖衣**，
真正有用的是左边这列换算。麦麦的存在只是因为：**没人会为一个表格每天都打开一次。**）

### 4.2 三个具体价值

1. **决策前置**：把营养评估放在了"点餐前"，而不是"吃完后后悔"。
   实测「芝士双层安格斯厚牛堡 1003 kcal / 钠 1373 mg」这类数据，用户看到它一口气占掉今天一半额度后，
   会自然地去比较另一个选项。
2. **可解释而非说教**：不止给一个分数，还指出**哪一项拖了后腿**并给出替代建议
   （如"想把薯条换掉，主食留在汉堡上"）。
3. **传播载体**：官方白底图 + 健康分 + 雷达图 + 会变胖的麦麦，天然是社交媒体的截图素材。
   官方赛事以 GitHub Star 排名，传播性本身就是产品设计的一部分。

### 4.3 真实数据分析示例

对 158 条餐品跑健康分，结果与常识一致，说明算法没有失真：

| 排名 | 餐品 | 热量 | 蛋白 | 钠 | 健康分 |
|---|---|---:|---:|---:|---:|
| 低分代表 | 芝士双层安格斯厚牛堡 | 1003 kcal | 58 g | 1373 mg | 偏低 |
| 中位 | 板烧鸡腿堡 | 391 kcal | 23 g | 1041 mg | 中上 |
| 高分代表 | 原味板烧鸡腿麦满分 | 246 kcal | 15 g | 611 mg | 偏高 |

（钠普遍偏高是麦当劳餐品的共性特征 —— 这正是本项目希望让用户"看见"的事实。）

### 4.4 可信度工程：把不确定的部分诚实摊开

榜单上营养类第一名（`mcd-order-calories`，36★）最值得抄的不是功能，而是态度：
**把不可靠的部分明确标出来**。本项目照做了四条：

1. **数据边界明示**：页面写明"MCP 没有提供的指标（游离糖、膳食纤维、饱和脂肪、加工程度）
   一律不估算、不编造"。
2. **算法出处明示**：每日参考值标注来自《中国居民膳食指南（2022）》成人（2000 kcal 水平）；
   单餐参考值标注为"本项目设定"。
3. **评分性质明示**：健康分每次出现都带"启发式评分，非医学建议"。
4. **数据落地可核查**：`data/nutrition.json` 保留 `source` / `endpoint` / `fetched_at` /
   `unit_note` 元信息，`data/food-photos.json` 记了 `store` / `storeName` / `fetched_at` / `how`，
   `data/rank-index.json` 记了 `sourceUrl` / `updated` —— 任何人可以核对每份数据从哪来、什么时候取的。
5. **榜单不造假**：榜单行没匹配到仓库的项目**只显示名字、不给链接**（不猜、不编造）；
   网络不通时明确标注当前是「缓存 / 内置快照」而不是「实时」。

---

## 五、复现方式

```bash
# 1. 取 Token（抓营养表与官方配图都需要）
#    https://open.mcd.cn/mcp → 登录 → 控制台 → 激活 → 复制
export MCD_MCP_TOKEN="你的Token"

# 2. 抓官方菜单白底图（走 query-meals，产物直接落 assets/food/）
python tools/fetch-food-photos.py

# 3. 生成榜单索引：仓库映射 + 离线快照（走 api.github.com，免 Token，可用缓存离线重跑）
python tools/fetch-rank-index.py

# 4. 模板 + 数据 → 单文件页面
python tools/build.py

# 5. 全量校验（渲染 / 图标 / 规格差异 / 投喂动画 / 养成持久化 / 实时榜单 /
#    手机 + 桌面双端 / 截图，共 135 项断言）
node tools/browser-check.js

# 校验线上部署（Edge 不读 HTTP_PROXY，需显式指定代理）
TARGET_URL=https://zhangjunzhe349-coder.github.io/mcpet/ \
  BROWSER_PROXY=http://127.0.0.1:7897 node tools/browser-check.js
```

`tools/build.py` 读取 `data/` 下的三份快照并内联进 `index.html`；
它同时会做一次**防漂移体检**：`src/icons.part.js` 与 `src/rank.part.js` 已手工并入
`src/index.template.html`，若只改了 partial 而没同步模板，构建时会直接告警。

如需自己重新抓取营养表，任意兼容 MCP 的客户端调用 `list-nutrition-foods` 传空对象 `{}` 即可，
返回的 `data` 字段即为 TOON 格式的全量营养表。

---

## 六、声明

- 本项目为**麦当劳程序员节创意开发大赛参赛作品**，由参赛者独立开发，**非麦当劳官方产品**。
- 项目输出仅供参考，**不构成医疗、营养或其他专业建议**；餐品信息、价格及供应状态以麦当劳官方渠道的实时结果为准。
- 仓库与文档中**不包含任何真实 Token、密钥、账号凭证或他人个人信息**，配置文件仅使用环境变量占位符。
