---
title: Pi 版 always-on-agent 技术方案
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

> 本文同步自 Obsidian 笔记 `技术调研/Pi版always-on-agent-技术方案-2026-10-18.md`（2026-10-18），作为仓库内的设计基线。截至同一天，M1 已实现并提交，M2 及之后未开始；实现范围见文末「实现状态」。

## Problem Statement

个人 agent（Pi、Claude 等）的使用节奏是突发式的：用户聊几轮后离开，几小时甚至几天后回来继续。agent 绝大部分时间处于空闲，但用户希望它「一直在线」。当前的三条路径各有缺口：

1. 本地常驻进程。实现最简单，但持续占用本机资源，没有沙箱隔离；合上笔记本或退出终端，会话就断了，也无法把多个 agent 复用到少量计算资源上。
2. substrate 的任务驱动形态（A 方案）。actor 可以挂起，状态可跨恢复保留，但只有同步 HTTP `/submit`，没有流式输出、没有 TUI 体验，也没有连接保持与空闲判定。挂起需要外部显式调用。
3. pi-chat。有 Discord/Telegram 频道、对话日志、流式渲染、附件和 secrets 交换，但每个频道拉起本地 Gondolin micro-VM 与 tmux worker，没有挂起概念，也不能交给 substrate 调度。

同时存在三个平台侧限制：

- substrate 没有 exec/attach，标准 Pi/Claude TUI 不能直接连到远端 actor；
- 当前代码没有自动空闲挂起，`internal/ateomsuspend` 的上报通道没有调用方，suspend 都是显式触发；
- 挂起会断开连接。内存快照能恢复进程，但对端 socket 不会复活，恢复后必须重连并重新对齐状态。

结果是用户只能在两种损失之间选择：牺牲体验（只能通过 API 或自制 UI 使用），或者牺牲效率（把 agent 常驻在本机）。

## Solution

把系统拆成四层，各自负责一件事：

| 层 | 角色 | 来源 |
|---|---|---|
| 频道层 | 人在哪里说话 | 复用 pi-chat 的 Discord/Telegram 适配、对话运行时、流式渲染 |
| 网关层 | 连接保持与生命周期决策 | 复用 always-on-agent 的 `idle-suspender`、`actor-router`、`actor-provisioner` |
| 平台层 | 调度、路由、快照、沙箱 | substrate |
| 运行时层 | agent 循环与工具执行 | `pi --mode rpc`，跑在 actor 内 |

核心原则是 presence 与 cognition 分离：

- 常驻网关作为集群内的普通 Deployment 运行，不进入 WorkerPool、不作为 actor；它持有 Discord/Telegram 连接、会话映射和聊天日志；
- 每个会话对应一个 substrate actor，actor 内运行 `pi --mode rpc`，保存 `/workspace`、session 文件与进程状态；
- 消息到达时网关把 turn 转发给 actor；actor 挂起时由 `atenet-router` 自动 resume；
- 收到 `agent_settled` 后开始空闲计时；超时且没有在飞工作时调用 suspend；
- 下一条消息重复上述过程，对话从 session 与快照续接。

状态归属明确：

| 状态 | 位置 | 理由 |
|---|---|---|
| 频道配置、bot token、secrets | 网关本地 | presence 层，不能进入快照 |
| `channel.jsonl`、队列、附件 | 网关本地 | 断线、重放与会话重建依赖它 |
| memory、skills、代码、session 文件 | actor 的 `/workspace` | cognition 层，随快照迁移 |
| 进程内存、运行中的 turn | actor | FULL 快照可恢复温热进程 |
| placement、快照引用、身份 | substrate | 平台职责 |

成功标准：

1. Discord 或 Telegram 发出消息后，挂起的 actor 自动恢复并流式回复。
2. turn 结束后经过配置的空闲窗口，actor 挂起并释放 worker。
3. 数小时后发下一条消息，同一会话继续，上下文与工作区不丢。
4. 多个会话共享一个较小的 WorkerPool，空闲会话不占 worker。
5. 真实 LLM 凭证不进入沙箱，由 egress 策略注入。
6. 在全新机器上按 README 用一条命令在 kind 或 GKE 启动，按提示接入 Discord/Telegram 后即可对话。

## User Stories

1. 作为个人 agent 用户，我希望通过 Discord 或 Telegram 与 Pi 对话，这样不需要在本机常驻一个进程。
2. 作为个人 agent 用户，我希望 agent 在我空闲时仍然显示在线，这样我不需要先等待冷启动才能发消息。
3. 作为个人 agent 用户，我希望聊完一轮后可以离开，agent 自动挂起，这样我的计算资源不会被长期占用。
4. 作为个人 agent 用户，我希望几小时后回来还能继续同一个对话，这样上下文和已完成的文件工作不会丢失。
5. 作为个人 agent 用户，我希望下一条消息自动唤醒 agent，这样我不需要执行 resume 命令。
6. 作为个人 agent 用户，我希望回复是流式的，这样长回合不会看起来像卡死。
7. 作为个人 agent 用户，我希望看到工具调用与执行状态，这样我能判断 agent 正在做什么。
8. 作为个人 agent 用户，我希望能够停止当前回合、查看状态、开始新会话，这样我可以控制运行中的 agent。
9. 作为个人 agent 用户，我希望可以发送文件附件，这样 agent 能处理本机之外的资料。
10. 作为个人 agent 用户，我希望 memory 与 skills 跨会话保留，这样 agent 会随着使用变得更有用。
11. 作为个人 agent 用户，我希望断网或切换设备后重连还能继续，这样网络波动不会破坏对话。
12. 作为运维者，我希望多个会话复用少量 worker，这样成本随活跃回合增长，而不是随会话总数增长。
13. 作为运维者，我希望挂起只发生在回合边界，这样不会丢失正在执行的工具调用。
14. 作为运维者，我希望快照存放在 rustfs 或 GCS，这样 actor 可以迁移到任意空闲 worker。
15. 作为运维者，我希望每个 atespace 有独立的 egress 策略，这样 LLM 凭证不会出现在沙箱或快照里。
16. 作为开发者，我希望网关与 actor 之间是清晰的协议边界，这样我可以用假 actor 测试网关，而不需要真实集群。
17. 作为开发者，我希望复用 pi-chat 的频道层，这样不需要重写 Discord/Telegram 的连接、附件和渲染逻辑。
18. 作为开发者，我希望复用 always-on-agent 的空闲挂起状态机，这样挂起时机与竞态处理有现成参考。
19. 作为开发者，我希望 actor 侧使用 Pi RPC，这样 turn 边界和流式事件是结构化的，而不是解析终端字节流。
20. 作为开发者，我希望明确标准 Pi TUI 不在本期范围内，这样不会把工作量低估成一个配置项。
21. 作为开发者，我希望 Pi 版本被固定并声明支持的 RPC 范围，这样上游协议变化不会悄悄破坏网关。
22. 作为运维者，我希望每个会话的日志、挂起次数和恢复延迟可观测，这样能定位「为什么没有挂起」或「为什么恢复很慢」。
23. 作为首次使用的用户，我希望按照 README 在 kind 或 GKE 上各用一条命令启动，这样我不需要理解内部组件或改代码就能用起来。
24. 作为把仓库带到自己环境的用户，我希望 kind 与 GKE 共用同一套清单，只切换存储、镜像仓库与 sandbox class 的覆盖层，这样部署路径只有一条。

## Implementation Decisions

### 部署形态

代码放在 substrate 核心之外的独立集成仓库，遵循 `docs/integration-repos.md` 的约定：非平凡端到端集成独立成库，core 的缺口先在上游落地，不在集成仓库里打补丁。仓库按能力命名，不按 runtime 命名，因为该能力不绑定 Pi。

交付物包括：standalone 网关镜像、actor 镜像、WorkerPool 与 ActorTemplate 清单、端到端 smoke 脚本。

语言统一用 TypeScript（Node.js）。网关和 actor 侧的 bridge 都跑在 Node 上，这样可以直接复用 pi-chat 与 always-on-agent 的 TypeScript 模块。substrate、Pi 与 ateapi 只通过进程边界和网络协议交互，不要求同语言。镜像方面，网关用多阶段 Node 构建；actor 基于 Node 基础镜像，安装 Pi 与 bridge。

部署上，网关以普通 Deployment 形式运行在集群内，推荐放在独立命名空间（如 `pi-gateway`），不要放进 WorkerPool，也不要作为 actor。它属于 presence 层，必须与集群同生命周期，不能被 suspend/resume；actor 只承载 cognition。

部署约束如下：

- 单副本运行，每个 bot token 只维持一个活跃频道连接；个人场景使用单副本加重启策略，暂不做 leader election。
- 通过 ServiceAccount 与 ateapi 认证（ServiceAccount JWT 或 podcert mTLS），用该身份调用 actor 的 create/resume/suspend。ateapi 目前没有 RBAC，任何已认证调用方都拥有全量权限，因此权限边界依赖独立命名空间、最小化 Secret 暴露和部署管理。
- 直接使用集群内 Service DNS 访问 `atenet-router.ate-system.svc` 与 `api.ate-system.svc`，不需要 port-forward。
- bot token 与 LLM key 放在 Kubernetes Secret，以环境变量或文件挂载给网关；actor 内仍只使用占位值，真实 LLM key 由 egress 策略注入。
- 出网：需要访问 Discord/Telegram 的 WebSocket；确认 NetworkPolicy 放行网关命名空间的出站流量，并允许访问集群 DNS。
- 配置 readiness/liveness 探针；重启后从 `channel.jsonl` 与会话映射恢复未完成的投递，不重放已提交的 turn。

### 仓库与代码来源

所有代码集中在一个新建的集成仓库 `pi-agent-substrate`，许可证用 Apache-2.0。两个上游只取需要的模块，不整仓 fork：

| 来源 | 用途 | 许可证 | 处理方式 |
|---|---|---|---|
| `earendil-works/pi-chat` | Discord/Telegram 适配、ConversationRuntime、流式渲染、配置与 secrets | Apache-2.0 | 复制 `src/live`、`src/services`、`src/runtime.ts`、`src/render`、`src/config.ts`、`src/secrets.ts` 到 `third_party/pi-chat/`；丢弃 `src/gondolin.ts` 与 Pi 扩展入口 |
| `agent-substrate/always-on-agent` | `idle-suspender`、`actor-router`、`actor-provisioner`、控制面客户端 | Apache-2.0 | 复制 5 个 TS 文件到 `third_party/always-on-agent/`；丢弃 OpenClaw 插件入口、ACP runtime 与 actor 镜像 |
| `earendil-works/pi` | actor 内 `pi --mode rpc` | MIT | 作为运行时依赖安装，固定版本；镜像内附 MIT 声明 |
| `agent-substrate/substrate` | 集群运行时 | Apache-2.0 | 只安装与调用 API，不复制代码 |

代码来源约定：

- 每个 `third_party/<project>/` 目录放 `README.md`，记录仓库 URL、commit SHA、复制文件清单与改动摘要。
- 保留原文件的版权头；修改过的文件加一行 `Modified from <repo> at <commit> for pi-agent-substrate, <date>.`
- 仓库根目录放 Apache-2.0 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`；镜像内放 `/licenses/`。
- README 声明与 Pi、OpenClaw、Google、Agent Substrate 无隶属关系，不使用其商标暗示背书。

长期策略是上游优先：先给 pi-chat 提「抽出可复用的 channel/runtime 包、worker 传输可插拔」，给 always-on-agent 提「runtime backend 可插拔」。上游接受后，用依赖替换 `third_party/` 副本；在过渡期，所有复制模块都放在接口后面（`Channel`、`Transport`、`ActorBackend`、`Lifecycle`），替换时只改适配层。

### 可移植性与快速启动

目标是「任何人把仓库拿过去，在本地 kind 或 GKE 上都能一条命令用起来」，因此部署路径只保留一条：

- **同一套清单，两个覆盖层。** Deployment、ActorTemplate、WorkerPool、ConfigMap/Secret 的结构一致；kind 与 GKE 只切换 kustomize overlay：
  - kind：`localhost:5001` 本地 registry、rustfs、按宿主能力选择 microVM 或 gVisor；
  - GKE：Artifact Registry 或 GCR、GCS、gVisor 或开启 nested virtualization 的 microVM。
- **一键安装脚本。** 脚本放在集成仓库（如 `hack/install-kind.sh`、`hack/install-gke.sh`），内部调用 substrate 官方安装器与本仓库清单，命令形式对齐 `install-ate-kind.sh` / `install-ate.sh`。脚本负责构建或拉取镜像、创建 atespace 与模板、等待 golden snapshot、部署网关，并打印频道接入步骤。
- **配置收拢。** 频道 token、atespace、template、空闲秒数、快照策略集中在一个 ConfigMap/Secret 中；LLM key 走 credential provider 与 egress 策略，不挂载给 actor。
- **镜像可发布。** 网关与 actor 镜像发布到公共 registry 并 pin digest；同时支持从源码构建（`docker buildx`；substrate 组件继续用 ko），避免用户必须自己推镜像。
- **无主机路径依赖。** 网关只使用集群内 Service DNS；本地与 GKE 都不需要 port-forward 或额外反向代理。
- **README 双路径 quickstart。** kind 与 GKE 各有一节，每步可验证；首次使用者按提示填 bot token、选频道即可对话。
- **客户端一致。** 前端是 Discord/Telegram，所以本地 kind 与 GKE 的使用体验相同；本地 TUI 不在本期范围。

### 组件划分

#### 网关（集群内 standalone TypeScript 服务，不运行 agent）

- 频道适配：复用 pi-chat 的 Discord/Telegram 实现。
- 对话运行时：复用 pi-chat 的消息队列、会话锁、`channel.jsonl`、附件落盘。
- 会话映射：按 conversation id 确定 actor 名，create-if-absent。
- RPC 中继：频道消息转换成 Pi RPC 命令，事件转换回流式渲染。
- 空闲挂起：`agent_settled` 后计时，prompt 到达时取消。
- 控制面客户端：create/resume/suspend；本地 kind 用 `kubectl ate` 回退即可。

#### actor 镜像

- WS ↔ stdio bridge：接收 WebSocket 的 JSONL 行写入 `pi --mode rpc` 的 stdin，stdout 按行推回。bridge 用 TypeScript/Node 编写。
- 启动入口：`pi --mode rpc --session-dir /workspace/.pi`，会话 id 由网关传入。
- 基础镜像为 Node，版本以 Pi 的 `engines` 要求为准并固定。
- `/workspace` 声明为 durableDir；memory、skills、代码与 session 文件都在这里。

#### 不修改的部分

- pi-chat 的频道、渲染、配置、secrets 模块。
- substrate 核心与 router。

### 接口契约

#### 网关 → actor

- 传输：WebSocket，JSONL 记录，一行一个 JSON 对象。
- 路由：请求头 `ate-target-actor: <atespace>/<actor>`；URL 与 Host 不参与 actor 选择。
- 命令：`prompt`、`get_state`、`abort`、`clear_queue`、`new_session`。
- 事件：`message_update`、`tool_call`、`agent_settled` 以及 Pi 的其它会话事件。
- 相关性：命令携带 `id`，响应回显同一个 `id`；客户端按 id 关联，不依赖响应顺序。
- 背压：网关必须持续读取；WebSocket 慢不能阻塞 actor 的 stdout。

#### 网关 → 控制面

- 生产：ateapi gRPC，使用 podcert mTLS 或 ServiceAccount 身份。
- 本地：`kubectl ate` 子进程回退。
- 操作：CreateActor、ResumeActor、SuspendActor、GetActor。

#### 客户端 → 网关

- 频道客户端走 pi-chat 现有适配器。
- 未来的 TUI/自定义客户端通过网关暴露的 WebSocket API 接入；该 API 只转发 prompt 与事件，不直接触碰 actor。

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
- suspend 是「取消在飞请求」而不是 drain，因此绝不能在 turn 中间触发。
- `SUSPENDING` 期间到达的 prompt 交给 router 的 resume 处理；网关不并发发起 suspend。
- actor 崩溃不自动重试同一 turn；保留会话文件，由用户或策略决定 revert。

### 会话映射

- 一个 conversation 对应一个 actor，actor 名由 conversation id 确定性生成。
- actor 不存在时按 golden template create-if-absent；模板不可变，变更需要新建模板。
- 同一 atespace 内 actor 名唯一；跨频道不共享 actor，除非显式配置。

### 快照策略

- 默认 FULL：进程内存 + rootfs 变更 + durable data，恢复出温热进程，客户端重连后只需 `get_state`。
- 可选 DATA + session 文件：快照更小、跨运行时更稳，但恢复是冷启动，需要 `--session-id` 或 `--continue` 续接。
- 两种策略都必须保证 `/workspace` 中的 session 文件可读；网关不依赖快照中的内存。

### 重连与幂等

- 网关为每个 turn 分配 request id；同一 id 重试返回已有结果，不重复执行。
- 客户端断线期间，网关缓冲事件；重连后先 `get_state` 与读取会话历史，再继续推送。
- 挂起导致的断线不自动重放最后一个 turn；已提交的 turn 以 session 文件为准。
- RPC 客户端没有内建重连，重连逻辑由网关/中继负责。

### 超时与容量

- `atenet-router` 的 `--route-timeout` 默认 10 秒，对整轮对话偏短，需要按部署调大。
- `--parked-request-budget` 默认 5 秒；官方 always-on-agent 的实测 resume P50 约 3.4 秒，冷节点或大快照需要更宽预算。
- 长连接存在 5 分钟流空闲超时，需要保活或由重连恢复。

### 安全

- bot token 与 LLM key 只存在网关；actor 内使用占位值。
- LLM 调用通过 egress 策略注入真实凭证，actor 与快照都不含明文。
- actor 不持有控制面凭据，不能自行 suspend；生命周期决策只能由网关发起。
- 本机或私有部署，不实现多租户 RBAC；网关的频道访问控制就是用户边界。

### 兼容性

- 固定 Pi 版本，并在网关中声明支持的 RPC 命令/事件集合。
- RPC 是版本相关的；升级 Pi 必须先跑 smoke，再滚动 actor 镜像。
- ActorTemplate 不可变；镜像 digest 变化会重建 golden snapshot。

## Testing Decisions

好的测试只验证外部行为：给定一条频道消息和一组 RPC 事件，网关是否产生正确的转发、挂起与重连行为；不觊觎内部状态对象或私有方法。

### Seam 提案

最高 seam 放在网关边界。这里实际涉及网关的三组外部依赖，三者都必须可注入：

- 频道入口：假频道适配器注入消息，绕过 Discord/Telegram；
- actor 传输：假 WebSocket 回放 RPC 记录；
- 控制面客户端：假 create/resume/suspend，记录调用顺序与次数。

断言网关发出的命令序列、挂起调用、渲染输出与状态迁移，不碰内部状态对象或私有方法。这样覆盖频道、会话映射、RPC 中继、空闲策略和重连，不需要真实集群与真实 Pi。

actor 侧的 bridge 必须有独立 seam：用假 pi 的 stdio 回放 JSONL，验证 WebSocket 双向转发、背压与断连。事件不要手写，从固定版本的 Pi 录制真实记录作为 fixture，覆盖严格 LF 分帧、CRLF、`U+2028`/`U+2029`、id 关联、stdout 只放协议、stderr 不参与协议。

空闲计时器使用可注入时钟；控制面客户端的 suspend 完成时机可控制，用于构造 `SUSPENDING` 期间到达 prompt 的竞态。测试频道只在测试构建中启用。

### 端到端验证

e2e 分三层，职责不同。

#### 第一层：自动化核心链路（CI）

集群里跑真实 actor 与真实 `pi --mode rpc`，用测试频道代替 Telegram，LLM 用 OpenAI 兼容的 mock 服务返回固定内容与工具调用，保证可重复、零成本。mock 不验证真实 provider 与 egress，这一部分交给第二层。

准备：

1. `hack/create-kind-cluster.sh`，确认输出 micro-VM support enabled。
2. `hack/install-ate-kind.sh --deploy-ate-system --credential-provider='{"name":"k8s.io"}'`。
3. `hack/install-microvm-deps.sh --install`。
4. 构建并推送网关与 actor 镜像到 `localhost:5001`。
5. 应用 WorkerPool、ActorTemplate、网关 Deployment；空闲窗口设为 10–20 秒；测试频道与 mock LLM 只在测试 overlay 中启用。
6. 等待 golden snapshot 与网关 readiness。

步骤与断言：

| 步骤 | 操作 | 断言 |
|---|---|---|
| 1 | 测试频道发消息 | 收到流式事件与最终消息；会话 id 已分配 |
| 2 | 让 agent 写 `/workspace/e2e.txt` | 记录内容 hash |
| 3 | 不执行任何 suspend 命令，轮询 actor 状态 | 空闲窗口 + 5 秒内变为 `ACTOR_STATE_SUSPENDED` |
| 4 | 检查 worker | 原 worker 已释放 |
| 5 | 再发一条消息 | 状态 `SUSPENDED → RESUMING → RUNNING`；首 token 在阈值内 |
| 6 | 让 agent 读回 `/workspace/e2e.txt` | 内容 hash 一致 |
| 7 | 追问上一轮内容 | 回答能引用上一轮；session id 与 session 文件不变 |
| 8 | 手动 `kubectl ate suspend` 后发消息 | router 自动 resume；与自动挂起分开记录结果 |
| 9 | 2 个会话 / 1 个 worker | 同时空闲时都挂起；同时活跃时按预期排队 |

失败条件：缺少 Docker/kind/KVM 时必须失败而不是跳过；用命名谓词判断环境，参考 `cmd/ateapi/internal/store/dockerenv.Required()`。

#### 第二层：真实频道 smoke（手动或夜间）

用专用测试 bot 与测试聊天，验证频道适配器与真实 provider。

1. 创建测试 bot，token 写入网关 Secret，只加入一个测试频道。
2. 发消息，确认流式 edit-in-place、分块与限流处理正常。
3. 让 agent 写文件，等待空闲窗口，确认 actor 变为 SUSPENDED。
4. 再发消息，不手动 resume，确认自动恢复且上下文连续。
5. 依次验证附件、`stop`、`status`、`new`。
6. 删除 actor 与测试消息。

这层不进每次 PR；release 前或每晚一次。

#### 第三层：失败与容量

- WorkerPool 只留 1 个 worker，开 2 个会话：第二个请求进入 parked，超时返回可诊断错误，网关不崩溃。
- resume 失败：注入控制面错误，断言状态、重试与错误上报。
- actor 崩溃：断言 session 文件保留，不静默丢历史。
- 网关重启矩阵：提交前、提交后未响应、响应后未确认，三个恢复点分别断言。
- Pi 版本升级：固定版本契约测试 + latest canary，提前发现 RPC schema 漂移。

### 需要覆盖的行为

- [ ] 1. 空闲计时只在 `agent_settled` 后启动，`prompt` 到达取消计时。
- [ ] 2. turn 进行中永不触发 suspend。
- [ ] 3. 挂起中到达 prompt 时，resume 与 suspend 不发生竞态。
- [ ] 4. 客户端断线后重连，事件不重放已完成的 turn，状态通过 `get_state` 对齐。
- [ ] 5. 多会话映射到不同 actor，互不串扰。
- [ ] 6. actor 崩溃时保留会话文件，不静默丢历史。
- [ ] 7. egress 策略缺失时 LLM 调用被拒绝，且错误可诊断。
- [ ] 8. FULL 与 DATA 两种快照下，恢复后的会话都能续接。
- [x] 9. 同一 request id 重试不重复执行。
- [x] 10. 网关重启后能从 `channel.jsonl` 恢复未完成的投递（当前为单会话；会话映射尚未接入）。
- [ ] 11. 断线发生在流式输出中间、prompt 已提交但 `agent_settled` 未到、挂起进行中三种时机，重连后无重复 delta、无缺口。
- [ ] 12. 空闲计时器使用可注入时钟；`SUSPENDING` 期间到达 prompt 只产生一次 suspend 和一次 resume。
- [ ] 13. 失败注入：ateapi 不可用、resume 失败、快照上传失败、Pi/bridge/网关崩溃，行为符合预期且错误可诊断。
- [x] 14. 网关重启的三个时间点：提交前、提交后未响应、响应后未确认，恢复结果分别符合预期。
- [ ] 15. 协议一致性：固定 Pi 版本的契约测试通过，latest canary 能提前发现 RPC 漂移。
- [ ] 16. 真实 token/key 不出现在 actor env、快照、日志中；actor 无法访问控制面。
- [ ] 17. 每次挂起决策都有原因日志或指标；跳过挂起可解释。
- [ ] 18. 频道边界：Discord/Telegram 事件重放、edit 限流、消息分块、附件处理。
- [ ] 19. 100 次 suspend/resume 循环后无连接或内存增长趋势，session 条目与文件 hash 稳定。
- [ ] 20. 性能指标：首 token P50/P95、suspend 耗时、快照大小、N 个会话 / M 个 worker 的密度。

### 验收阈值

| 指标 | 初始目标 | 说明 |
|---|---|---|
| 自动挂起触发 | 空闲窗口 + ≤5 秒 | 无手动命令 |
| resume 到首 token | P50 ≤5 秒，P95 ≤10 秒 | 首次测量后按机器校准 |
| 重连 | 0 重复 delta，0 缺口 | 三种断线时机分别验证 |
| 100 次 suspend/resume | 无连接/内存增长趋势；session 条目与文件 hash 稳定 | soak |
| 凭证泄漏 | actor env、快照、日志中零命中真实 token/key | 安全 |
| 密度 | 2 会话 / 1 worker 空闲时全部挂起 | 资源 |

### 里程碑出口条件

- [x] M1：测试频道 echo 可用；网关重启后能从 `channel.jsonl` 恢复未完成投递。
- [ ] M2：单频道端到端打通（mock LLM）；手动 suspend → 下一条消息自动 resume。
- [ ] M3：自动空闲挂起、自动 resume、session 与文件连续性全部通过。
- [ ] M4：真实频道 smoke、失败与容量用例、100 次 soak、性能报告。

### 参考先例

- substrate 的 kind e2e：`hack/run-e2e-kind.sh`、`internal/e2e`。
- always-on-agent 的 `verification.json`、`scripts/smoke-cluster.ts`、`scripts/smoke-guest.ts` 的断言组织方式。
- pi-chat 现有测试对频道适配与 runtime 的覆盖（如有）作为单元测试基线。

## Out of Scope

- 标准 Pi TUI 或 Claude Code TUI 的原生远端 attach。Pi TUI 不是 RPC 客户端，Claude 没有公开的 RPC/attach 模式。
- OpenClaw 与 ACP 的复用。本方案只借用 always-on-agent 的生命周期思想与模块，不依赖 OpenClaw。
- 多租户鉴权、RBAC、配额与计费。substrate 当前没有控制面 RBAC，部署按单用户或私有环境设计。
- 浏览器前端、移动端 App、频道生态扩展（Slack、WhatsApp）。
- 模型路由、A/B 测试、自动选择 provider。
- Windows 原生部署；本机开发以 WSL2 + microVM 为准。
- 在线迁移或跨集群调度。

## Further Notes

### 关键参考

- `agent-substrate/always-on-agent`：`extensions/substrate/idle-suspender.ts`、`actor-router.ts`、`actor-provisioner.ts`、`manifests/actortemplate.yaml`（FULL 快照的取舍与「restoring a warm, already-thinking agent」）。
- `earendil-works/pi-chat`：`src/live`、`src/services`、`src/runtime.ts`、`src/render`、`src/gondolin.ts`（需要替换的沙箱层）。
- `earendil-works/pi`：`packages/coding-agent/docs/rpc.md`、`rpc-commands.md`、`cli.md`、`src/modes/rpc/rpc-client.ts`。
- substrate：`docs/architecture.md`、`cmd/atenet/internal/router/xds.go`（WebSocket upgrade 与 idle timeout）、`docs/integration-repos.md`（能力命名与上游优先）。
- 本机环境笔记（Obsidian）：substrate-WSL2-开发环境重建-runbook、substrate-quickstart-WSL2-环境排错、substrate。

### 已知约束与风险

- 这台 WSL2 上 gVisor systrap 会崩，只能用 microVM sandbox class；template 与 WorkerPool 都需要相应修改。
- kind 的 rustfs PVC 默认 1 GiB，FULL 快照可能不够，需要先实测再决定是否调大。
- 官方 demo README 描述「空闲自动挂起」，但当前 main 代码里没有找到自动空闲检测，挂起是显式的；本方案的挂起逻辑必须自己实现并测试。
- pi-chat 是 Pi 扩展，必须抽离成 standalone 网关，不能把 agent 留在网关进程里。
- 网关部署在集群内并不等于系统始终在线：本地 kind 的在线时间等于机器开机时间，这对本地使用足够；真正的 24/7 需要集群常开（GKE、常开主机或 homelab）。
- `pi --mode rpc` 的传输是 stdio，远程接入必须自带 bridge；`RpcClient` 没有重连，需要自建。
- 5 分钟流空闲超时、10 秒 route timeout、5 秒 parked budget 都需要按部署调优。

### 里程碑

| 阶段 | 内容 | 估计 | 状态 |
|---|---|---|---|
| M1 | 抽离 pi-chat 频道与对话运行时为 standalone 网关，echo 后端验证消息与流式编辑 | 3–5 天 | [x] 已完成 |
| M2 | actor 镜像与 RPC bridge，单频道端到端打通 | 2–3 天 | [ ] 未开始 |
| M3 | 接入 idle-suspender，验证 suspend → resume → session 续接 | 2–3 天 | [ ] 未开始 |
| M4 | 多频道、附件、重连重放、延迟与密度测量 | 3–5 天 | [ ] 未开始 |

### 待确认

- 快照策略默认选 FULL 还是 DATA + session，需要在目标机器上测恢复延迟与快照大小后决定。
- 是否把 runtime 适配层反向贡献给 always-on-agent，做成可插拔 backend。
- TUI 自定义客户端是否在本期实现，还是先只做 Discord/Telegram。
- Pi 版本固定策略与升级窗口。

## 实现状态

### M1（已完成）

- [x] 独立网关：复用 pi-chat 的 `ConversationRuntime`，每个 turn 的状态写入 `channel.jsonl`。
- [x] 测试频道：`test/support/test-channel.ts` 仅在 `NODE_ENV=test` 下可构造，验证消息投递与流式预览编辑。
- [x] 幂等 echo 后端：`src/backend/echo.ts` 按 request id 缓存结果，重试不重复执行。
- [x] 重启恢复：覆盖提交前、提交后未响应、发送后未记录 outbound、响应已记录未确认四个时间点。
- [x] 回归测试：`npm test` 运行 6 个用例，覆盖以上行为。

### M2 及之后（未开始）

- [ ] actor 镜像与 Pi RPC bridge。
- [ ] 真实模型 provider 与本地 Pi 配置接入。
- [ ] 单频道端到端链路。
- [ ] 手动 suspend → 下一条消息自动 resume。
- [ ] 自动空闲挂起、真实频道、失败与容量用例。
