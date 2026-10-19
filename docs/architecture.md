---
title: Pi 版 always-on-agent 架构设计
date: 2026-10-18
tags:
  - substrate
  - pi
  - always-on-agent
  - agent-runtime
  - design
  - spec
---

> **一句话**
> 复用 pi-chat 的频道与对话状态、always-on-agent 的空闲挂起策略、substrate 的可挂起 actor，在 actor 内跑 `pi --mode rpc`，得到「连接常开、计算按需」的 Pi 版 always-on-agent。

## 问题

个人 agent 的使用节奏是突发式的：聊几轮后离开，几小时甚至几天后回来继续。agent 绝大部分时间空闲，但用户希望它「一直在线」。现有的三条路径各有缺口：

1. 本地常驻进程。实现最简单，但持续占用本机资源，没有沙箱隔离；合上笔记本或退出终端，会话就断了，也无法把多个 agent 复用到少量计算资源上。
2. 直接用 substrate 的任务驱动形态。actor 可以挂起，状态可跨恢复保留，但只有同步 HTTP `/submit`，没有流式输出、没有 TUI 体验，也没有连接保持与空闲判定。挂起需要外部显式调用。
3. pi-chat。有 Discord/Telegram 频道、对话日志、流式渲染、附件和 secrets 交换，但每个频道拉起本地 Gondolin micro-VM 与 tmux worker，没有挂起概念，也不能交给 substrate 调度。

三个平台侧限制同时存在：

- substrate 没有 exec/attach，标准 Pi/Claude TUI 不能直接连到远端 actor；
- 平台没有自动空闲挂起，suspend 都是显式触发；
- 挂起会断开连接。内存快照能恢复进程，但对端 socket 不会复活，恢复后必须重连并重新对齐状态。

结果是用户只能在两种损失之间选择：牺牲体验（只能通过 API 或自制 UI 使用），或者牺牲效率（把 agent 常驻在本机）。

## 设计

系统分四层，各自负责一件事：

| 层 | 角色 | 来源 |
|---|---|---|
| 频道层 | 人在哪里说话 | pi-chat 的对话运行时与流式渲染，本仓库自带 curl、浏览器、Telegram 适配 |
| 网关层 | 连接保持与生命周期决策 | always-on-agent 的 `idle-suspender` 思想 |
| 平台层 | 调度、路由、快照、沙箱 | substrate |
| 运行时层 | agent 循环与工具执行 | `pi --mode rpc`，跑在 actor 内 |

核心原则是 presence 与 cognition 分离：

- 常驻网关作为普通进程运行，不进入 WorkerPool、不作为 actor；它持有频道连接、会话映射和聊天日志；
- 每个会话对应一个 substrate actor，actor 内运行 `pi --mode rpc`，保存 `/workspace`、session 文件与进程状态；
- 消息到达时网关把 turn 转发给 actor；actor 挂起时由 `atenet-router` 自动 resume；
- 收到 `agent_settled` 后开始空闲计时；超时且没有在飞工作时调用 suspend；
- 下一条消息重复上述过程，对话从 session 与快照续接。

### 状态归属

| 状态 | 位置 | 理由 |
|---|---|---|
| 频道配置、bot token、secrets | 网关本地 | presence 层，不能进入快照 |
| `channel.jsonl`、队列、附件 | 网关本地 | 断线、重放与会话重建依赖它 |
| memory、skills、代码、session 文件 | actor 的 `/workspace` | cognition 层，随快照迁移 |
| 进程内存、运行中的 turn | actor | MEMORY 快照可恢复温热进程 |
| placement、快照引用、身份 | substrate | 平台职责 |

### 设计目标

1. 频道发出消息后，挂起的 actor 自动恢复并流式回复。
2. turn 结束后经过配置的空闲窗口，actor 挂起并释放 worker。
3. 数小时后发下一条消息，同一会话继续，上下文与工作区不丢。
4. 多个会话共享一个较小的 WorkerPool，空闲会话不占 worker。
5. 真实模型凭证不进入沙箱，由 egress 策略注入。
6. 在全新机器上按 README 用一条命令启动，填上 token 即可对话。

## 组件

### 网关

standalone 进程，不运行 agent。

- **频道适配**：把外部消息变成一条 turn，把回复按该频道的渲染方式送回去。
- **对话运行时**：消息队列、会话锁、`channel.jsonl`、附件落盘。
- **会话映射**：按 conversation id 确定 actor 名，create-if-absent。
- **RPC 中继**：频道消息转换成 Pi RPC 命令，事件转换回流式渲染。
- **空闲挂起**：`agent_settled` 后计时，prompt 到达时取消。
- **控制面客户端**：create / resume / suspend。

### actor 镜像

- **WS ↔ stdio bridge**：接收 WebSocket 的 JSONL 行写入 `pi --mode rpc` 的 stdin，stdout 按行推回。
- **启动入口**：`pi --mode rpc --session-dir /workspace/.pi`，会话 id 由网关传入。
- **基础镜像**为 Node，版本以 Pi 的 `engines` 要求为准并固定。
- **`/workspace`** 声明为 durableDir；memory、skills、代码与 session 文件都在这里。

### 不修改的部分

- pi-chat 的频道、渲染、配置、secrets 模块。
- substrate 核心与 router。

## 核心模型

### 接口契约

#### 网关 → actor

- 传输：WebSocket，JSONL 记录，一行一个 JSON 对象。
- 路由：请求头 `ate-target-actor: <atespace>/<actor>`；URL 与 Host 不参与 actor 选择。
- 命令：`prompt`、`get_state`、`abort`、`clear_queue`、`new_session`。
- 事件：`message_update`、`tool_call`、`agent_settled` 以及 Pi 的其它会话事件。
- 相关性：命令携带 `id`，响应回显同一个 `id`；客户端按 id 关联，不依赖响应顺序。
- 背压：网关必须持续读取；WebSocket 慢不能阻塞 actor 的 stdout。

bridge 在此之上加两条扩展：

- `bridge_result`：回合结算时由 bridge 主动发出，带 `requestId`。Pi 自己的 `agent_settled` 不带 request id，这条记录才是网关结算的依据。它比 `agent_settled` 先发，因为网关收到第一条就结算，而一条裸的 `agent_settled` 会把失败当成空回复。
- `bridge_get_state` / `bridge_result` 查询：客户端重连后向 bridge 索取已完成回合的结果，而不是重发 prompt。

#### 网关 → 控制面

- 生产：ateapi，使用 podcert mTLS 或 ServiceAccount 身份。
- 本地：`kubectl-ate` 子进程。
- 操作：CreateActor、ResumeActor、SuspendActor、GetActor。

#### 客户端 → 网关

- 频道客户端走各自的适配器。
- 浏览器与 curl 走网关的 HTTP/WebSocket API；该 API 只转发 prompt 与事件，不直接触碰 actor。

### 投递状态机

每个 turn 是一个 job，运行时把记录追加到 `channel.jsonl`：

```
inbound -> job_queued -> job_dispatched -> outbound -> job_completed
```

`job_dispatched` 存一个对该 job 稳定的 request id。后端按 request id 幂等，频道按 delivery id 幂等。网关启动时扫描没有终态记录的 job，按日志位置恢复：

| 崩溃点 | 日志中的状态 | 恢复方式 |
|---|---|---|
| 提交前 | `job_queued` | 用 job id 作为 request id 重新提交 |
| 提交后、响应前 | `job_dispatched` | 用同一 request id 重试，后端返回同一个 turn |
| 频道已发送、`outbound` 未写 | `job_dispatched` | 重试缓存的 turn；频道按 delivery id 抑制重复投递 |
| `outbound` 已写、`job_completed` 未写 | `outbound` | 只补 completion，不再调用后端或频道 |

恢复路径从不重放已完成的 turn。

### 生命周期状态机

```text
IDLE ──prompt──> ACTIVE
ACTIVE ──agent_settled──> GRACE
GRACE ──prompt──> ACTIVE
GRACE ──超时且无在飞命令──> SUSPENDING
SUSPENDING ──完成──> SUSPENDED
SUSPENDED ──prompt/attach──> RESUMING ──ready──> ACTIVE
ACTIVE/GRACE ──actor crash──> CRASHED（需要 revert 或重建）
```

关键约束：

- 只有 `agent_settled` 之后才允许进入 `GRACE`；`prompt` 到达立即取消计时。
- suspend 是「取消在飞请求」而不是 drain，因此绝不能在 turn 中间触发。网关在 `turnStarted()` 时离开 `GRACE`，在回合完全记录之后才 `turnSettled()`。
- `turnStarted()` 之后发生的任何失败都必须结算一次，否则在飞计数不会归零，状态永远回不到 `GRACE`，actor 再也不会挂起。
- `SUSPENDING` 期间到达的 prompt 交给 router 的 resume 处理；网关不并发发起 suspend，晚到的 suspend 结果也不能把状态写回 `SUSPENDED`。
- 挂起失败回落到 `GRACE` 并重设空闲窗口，不把会话卡在 `SUSPENDING`。
- actor 崩溃不自动重试同一 turn；保留会话文件，由用户或策略决定 revert。

**连接与唤醒**：连接 bridge 这个动作本身就会唤醒 actor。因此 transport 不能自动重连——挂起后自动重连会立刻把 actor 叫醒，形成挂起—唤醒循环，actor 永远睡不满一个空闲窗口。下一次 turn 的 `connect()` 是唯一的唤醒动作。断线时后端必须清空已结算缓存：那些结果在旧 actor 的 bridge 进程里，恢复后的 actor 看不到它们。

### 会话映射

- 一个 conversation 对应一个 actor，actor 名由 conversation id 确定性生成（规范化成 Kubernetes 合法名，固定 `pi-` 前缀）。
- actor 不存在时按 golden template create-if-absent；模板不可变，变更需要新建模板。
- 同一 atespace 内 actor 名唯一；跨频道不共享 actor，除非显式配置。
- 每个会话独立 actor、独立日志、独立锁；一个会话失败不影响其余。

### 快照策略

- 默认 MEMORY：进程内存 + rootfs 变更 + durable data，恢复出温热进程，客户端重连后只需 `get_state`。
- 可选 DATA + session 文件：快照更小、跨运行时更稳，但恢复是冷启动，需要 `--session-id` 或 `--continue` 续接。
- 两种策略都必须保证 `/workspace` 中的 session 文件可读；网关不依赖快照中的内存。
- 恢复后 Pi 子进程可能已死。bridge 惰性启动 Pi，并在客户端连接时按固定 `--session-id` 重启，session 文件续接，不重跑上一回合。

### 重连与幂等

- 网关为每个 turn 分配 request id；同一 id 重试返回已有结果，不重复执行。
- 客户端断线期间，网关缓冲事件；重连后先 `get_state` 与读取会话历史，再继续推送。
- 挂起导致的断线不自动重放最后一个 turn；已提交的 turn 以 session 文件为准。
- RPC 客户端没有内建重连，重连逻辑由网关/中继负责。

### 错误传播

失败必须和「空回复」区分开，否则用户只看到沉默，运维也无法判断是模型问题还是网关问题。

- Pi 用 `message_end` 的 `stopReason: "error"` + `errorMessage` 报告 provider 失败；重试耗尽时另有 `auto_retry_end.success: false` + `finalError`。
- bridge 把这两类信号读成回合结果的一部分，随 `bridge_result` 发出。
- 后端把它放进 `AgentResponse.error`，网关记 `job_failed`，并通过频道的 `sendError` 把原因送到用户面前。
- 网关自身的异常（提交失败、transport 断开）走同一条上报路径，同时结算生命周期。

## 部署

### 形态与约束

- 单副本运行，每个 bot token 只维持一个活跃频道连接；个人场景使用单副本加重启策略，暂不做 leader election。
- 单用户部署时网关跑在用户机器上，通过 port-forward 连 router；集群内部署时用 Service DNS 直接访问 `atenet-router.ate-system.svc`。
- bot token 只存在网关一侧；模型 key 不进 actor，由 egress 在出站时注入。
- actor 不持有控制面凭据，不能自行 suspend；生命周期决策只能由网关发起。
- 重启后从 `channel.jsonl` 与会话映射恢复未完成的投递，不重放已提交的 turn。

### 可移植性

部署路径只有一条，本地与集群共用同一套清单，只切换存储、镜像仓库与 sandbox class：

- **清单结构一致。** Deployment、ActorTemplate、WorkerPool、ConfigMap/Secret 的字段相同，差异放在覆盖层。
- **一键安装。** 脚本负责构建或拉取镜像、创建 atespace 与模板、等待 golden snapshot、部署网关，并打印频道接入步骤。
- **配置收拢。** 频道 token、atespace、template、空闲秒数集中在一处；模型 key 走 credential provider 与 egress 策略。
- **无主机路径依赖。** 网关只使用集群内 Service DNS。

## 横切关注点

### 超时与容量

- `atenet-router` 的 `--route-timeout` 默认 10 秒，对整轮对话偏短，需要按部署调大。
- `--parked-request-budget` 默认 5 秒；冷节点或大快照需要更宽预算。
- 长连接存在流空闲超时，需要保活或由重连恢复。
- WorkerPool 的 worker 数决定并发会话上限：worker 用满时新 actor 会 park 或返回可诊断错误。

### 安全

- bot token 与模型 key 只存在网关或 Kubernetes Secret；actor 内使用占位值。
- 模型调用通过 egress 策略注入真实凭证，actor 与快照都不含明文。
- actor 不持有控制面凭据。
- 单用户或私有部署，不实现多租户 RBAC。

### 兼容性

- 固定 Pi 版本，并在网关中声明支持的 RPC 命令/事件集合。
- RPC 是版本相关的；升级 Pi 必须先跑 smoke，再滚动 actor 镜像。
- ActorTemplate 不可变；镜像 digest 变化会重建 golden snapshot。

## 测试设计

好的测试只验证外部行为：给定一条频道消息和一组 RPC 事件，网关是否产生正确的转发、挂起与重连行为；不觊觎内部状态对象或私有方法。

### Seam

最高 seam 放在网关边界。三组外部依赖都必须可注入：

- 频道入口：假频道注入消息，绕过真实频道；
- actor 传输：假 WebSocket 回放 RPC 记录；
- 控制面客户端：假 create/resume/suspend，记录调用顺序与次数。

断言网关发出的命令序列、挂起调用、渲染输出与状态迁移，不碰内部状态对象或私有方法。这样覆盖频道、会话映射、RPC 中继、空闲策略和重连，不需要真实集群与真实 Pi。

actor 侧的 bridge 有独立 seam：用假 pi 的 stdio 回放 JSONL，验证 WebSocket 双向转发、背压与断连。事件不要手写，从固定版本的 Pi 录制真实记录作为 fixture，覆盖严格 LF 分帧、CRLF、`U+2028`/`U+2029`、id 关联、stdout 只放协议、stderr 不参与协议。

空闲计时器使用可注入时钟；控制面客户端的 suspend 完成时机可控制，用于构造 `SUSPENDING` 期间到达 prompt 的竞态。

### 端到端

分三层，职责不同。

**核心链路（CI）**：集群里跑真实 actor 与真实 `pi --mode rpc`，LLM 用 OpenAI 兼容的 mock 返回固定内容与工具调用，保证可重复、零成本。断言流式回复、写 `/workspace` 文件、无手动命令自动挂起、下一条消息自动 resume、文件与 session 均续接。

**真实频道 smoke（手动或夜间）**：专用测试 bot 与测试聊天，验证频道适配器与真实 provider。确认流式 edit-in-place、分块与限流、自动挂起与恢复、附件与控制命令。

**失败与容量**：worker 用满时的排队与错误、resume 失败注入、actor 崩溃后 session 保留、网关重启矩阵、Pi 版本契约测试。

### 验收阈值

| 指标 | 目标 | 说明 |
|---|---|---|
| 自动挂起触发 | 空闲窗口 + ≤5 秒 | 无手动命令 |
| resume 到首 token | P50 ≤5 秒，P95 ≤10 秒 | 按机器校准 |
| 重连 | 0 重复帧，0 缺口 | 三种断线时机分别验证 |
| 100 次 suspend/resume | 无连接/内存增长趋势；session 条目与文件 hash 稳定 | soak |
| 凭证泄漏 | actor env、快照、日志中零命中真实 token/key | 安全 |
| 密度 | 2 会话 / 1 worker 空闲时全部挂起 | 资源 |

## 不做的部分

- 标准 Pi TUI 或 Claude Code TUI 的原生远端 attach。Pi TUI 不是 RPC 客户端，Claude 没有公开的 RPC/attach 模式。
- OpenClaw 与 ACP 的复用。只借用 always-on-agent 的生命周期思想，不依赖 OpenClaw。
- 多租户鉴权、RBAC、配额与计费。
- 产品化前端与移动端 App。浏览器页面只用于观察多会话与重放；正式入口是 curl 与 Telegram。
- 模型路由、A/B 测试、自动选择 provider。
- 在线迁移或跨集群调度。

## 参考

- `agent-substrate/always-on-agent`：`extensions/substrate/idle-suspender.ts`、`actor-router.ts`、`actor-provisioner.ts`、`manifests/actortemplate.yaml`（MEMORY 快照的取舍与「restoring a warm, already-thinking agent」）。
- `earendil-works/pi-chat`：`src/live`、`src/services`、`src/runtime.ts`、`src/render`、`src/gondolin.ts`（需要替换的沙箱层）。
- `earendil-works/pi`：`packages/coding-agent/docs/rpc.md`、`rpc-commands.md`、`cli.md`、`src/modes/rpc/rpc-client.ts`。
- substrate：`docs/architecture.md`、`cmd/atenet/internal/router/xds.go`（WebSocket upgrade 与 idle timeout）、`docs/integration-repos.md`、`docs/egress-credential-injection.md`、`docs/egress-trust-bundle.md`。
- substrate 的 kind e2e（`hack/run-e2e-kind.sh`、`internal/e2e`）与 always-on-agent 的 smoke 脚本，作为断言组织方式的参考。
