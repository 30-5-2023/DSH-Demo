# workorder-service

工单服务，**它就是业务系统**——今天这份是 mock 实现，真实部署时由业务方提供同一套东西，**对外的三组接口不变**。所以我们在这边定下来的接口，就是将来要交出去的契约。

它内部三样，都是它自己的实现：**执行引擎**（认产线结构、判输入是否就绪、推状态机、决定什么时候该喊人）、**执行实现**（活动真的怎么跑）、**状态与三张对外面**。引擎不换。

只有「执行实现」是可以单换的一半（`state.executor`）：服务把活动交出去、等它的回执；引擎只认回执，不自己判完成、也不自己编失败原因。demo 里缺省接内置的模拟实现，想让活动真的跑就传一个自己的进来，引擎与这三组接口一个字节都不用改。

零 DSH 依赖：可以单独启动、单独 `curl`，不需要宿主。这条是刻意的，见 [../DESIGN.md](../DESIGN.md)。

## 跑起来

```sh
cd business-agent/workorder-service
node bin/serve.js                      # 默认 127.0.0.1:8090；模拟执行每步 4 秒
node bin/serve.js --port 8090 --step-ms 2000
node bin/serve.js --help
```

建议先跑一遍自检，它不启动 DSH，只用服务自己的接口走一遍：

```sh
node test/smoke.mjs          # 15 项：三组接口 + 换执行实现
node test/standalone-check.mjs http://127.0.0.1:8090   # 对着已启动的实例看产线自己跑
```

## 执行实现（唯一可以只换一半的地方）

| | 活动由谁执行 | 怎么知道跑完了 |
|---|---|---|
| demo（缺省） | 内置模拟实现 `src/executor.js` | 等 `stepMs` 就算跑完；`/demo/fail-next` 让下一步的回执变成失败 |
| 真实实现 | 真的去调工具、跑活动的那段代码 | 它自己的回执喂给 `poll` |

接口就两个方法：

```js
const executor = {
  kind: 'executor',
  submit(activity, atMs) {},           // 把活动交出去：发起执行
  poll(activity, atMs, { force }) {},  // 问回执：null 还在跑 / {status:'done'} / {status:'failed', failure}
}
createService({ executor })
```

引擎只认 `poll` 的返回，不自己判完成、不自己编失败原因——失败原因是执行侧报回来的。`transition()` 在活动进入 `running` 时统一调 `submit`，所以「自动活动」「人在对话里下达」「失败后重跑」三条路径都不会漏交。

demo 的三个旋钮长在模拟实现身上，换成真实实现时 `/demo/*` 一律回 409：那些端点没有落点，不假装成功。

**注意范围**：换「执行实现」是只换活动怎么跑、保留这套服务骨架。真实业务系统整份替换时，连这三组接口一起换——照本文件的接口清单实现即可。

## 对外接口（三组）

同一个服务、同一个端口上的三组入口，按「谁用、用什么协议」分：

| # | 接口 | 路径 | 消费者 | 说明 |
|---|---|---|---|---|
| ① | 读接口（HTTP） | `GET /orders` · `GET /orders/:id` · `GET /orders/:id/decisions` · `GET /bindings/:clientId` · `PUT /bindings/:clientId` | 看板（读）· 唤醒器（写绑定） | 只读查询；唯一可写的是「谁在看哪张单」的登记（唤醒器维护），不碰工单数据 |
| ② | 事件流（SSE） | `GET /events[?orderId=]` | 看板 **和** 唤醒器 | 实时数据只从这条流来，两边订的是同一条 |
| ③ | 工具面（MCP） | `POST /mcp` | agent | 工具名在宿主侧变成 `mcp__workorder__<名字>` |

另有 `GET /health`（含引擎与执行实现状态）与一组 `/demo/*` 控制端点（真实实现里不会有；换成真实执行实现后回 409）。

## 接口上必须守住的三条约定

1. **所有 MCP 工具立即返回。** 「启动工单」返回「已提交」与当前步骤，不等到跑完。一个跑两小时的产线活动不能占住 agent 的一个 turn。
2. **工单号字段叫 `orderId`。** 唤醒器要从工具调用的参数里读它来记「会话 ↔ 工单」绑定（见 [../DESIGN.md](../DESIGN.md) 第二节）。字段名飘了，唤醒器就要跟着改配置。
3. **MCP server 不返回 `instructions`。** DSH 会把 server 的 instructions 自动注入系统提示词，而产线状态会变，做成常驻上下文会污染 KV 缓存。冒烟测试里有一条专门守这个。

## 事件载荷是主机中立的

```json
{
  "type": "activity.changed",
  "rev": 12,
  "at": "2026-09-16T14:20:00.000Z",
  "orderId": "WO-2026-0916-014",
  "orderTitle": "客户 A 年度授信复核",
  "activityId": "a3",
  "activitySeq": 3,
  "activityTitle": "复核财报口径",
  "activityType": "manual",
  "from": "pending",
  "to": "waiting",
  "needsHuman": true,
  "line": "⏸ 步骤 3「复核财报口径」等待人工处理",
  "outputs": [],
  "failure": null
}
```

两条设计意图：

- **`needsHuman` 由服务判定**，不由消费者各算一遍——服务知道活动是不是人工的、是不是失败了。让每个唤醒器重复实现必然漂移。
- **`line` 只描述产线发生了什么**，不出现会话、消息、卡片这类词。拿它做什么呈现，是消费者的事。有了它，唤醒器拼提示时不必自己编文案；没有它，各消费者就会各写各的。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `list_orders` | 工单列表 |
| `get_order` | 整条产线（含自动化标记、输入绑定、失败原因） |
| `start_order` | 启动产线，立即返回当前停在哪一步 |
| `start_activity` / `finish_activity` | 推进人工步骤 |
| `decide` | 质检结论（approve 完成 / reject 转异常） |
| `bind_input` | 改输入绑定（异常处置的落点） |
| `retry_activity` | 重跑失败步骤 |
| `fail_activity` / `skip_activity` | 由人判定异常 / 跳过 |

## demo 控制端点

真实业务系统里不存在这些；它们只是让演示可控、让测试可重复。

```sh
POST /demo/pause      { "paused": true }
POST /demo/speed      { "stepMs": 800 }
POST /demo/fail-next  { "seq": 3 }      # 下一次第 3 步执行时改成失败
```

## 目录

```
bin/serve.js       独立启动入口
src/domain.js      领域模型、状态容器、事件广播
src/seed.js        示例工单
src/operations.js  状态机（唯一的写入口：每次迁移恰好一次事件 + 一条决策记录）
src/engine.js      执行引擎（留在服务里的那层）
src/executor.js    执行实现（demo 是模拟的；真实实现换成真的去跑活动的代码）
src/http.js        接口①②：读接口（HTTP）与事件流（SSE）
src/mcp.js         接口③：工具面（MCP）
test/smoke.mjs     三组接口与换执行实现的自检
```

## 现在的边界

- **不持久化**：状态在内存里，进程重启即回到初始示例工单。demo 够用；真实部署需要把这份状态落进存储——服务的产线状态是权威状态，不是别人的缓存。
- **不做鉴权**：监听 `127.0.0.1`，看板直连同机回环；真实部署的认证与跨域放行归业务方（见 [../DESIGN.md](../DESIGN.md) 第二节）。
- **不主动知道 agent 的存在**：它只发事件，谁来消费、怎么翻译，是消费者的事。这是将来能把服务搬出去、换掉左侧 agent 的前提。
