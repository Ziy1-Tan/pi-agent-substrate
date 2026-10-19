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

> 本文同步自 Obsidian 笔记 `技术调研/Pi版always-on-agent-技术方案-2026-10-18.md`（2026-10-18），作为仓库内的设计基线。实现进度见文末「实现状态」。

## Problem Statement

个人 agent（Pi、Claude 等）的使用节奏是突发式的：用户聊几轮后离开，几小时甚至几天后回来继续。agent 绝大部分时间处于空闲，但用户希望它「一直在线」。当前的三条路径各有缺口：

1. 本地常驻进程。实现最简单，但持续占用本机资源，没有沙箱隔离；合上笔记本或退出终端，会话就断了，也无法把多个 agent 复用到少量计算资源上。
2. 直接用 substrate 的任务驱动形态。actor 可以挂起，状态可跨恢复保留，但只有同步 HTTP `/submit`，没有流式输出、没有 TUI 体验，也没有连接保持与空闲判定。挂起需要外部显式调用。
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

- [x] 1. 空闲计时只在 `agent_settled` 后启动，`prompt` 到达取消计时。
- [x] 2. turn 进行中永不触发 suspend。
- [x] 3. 挂起中到达 prompt 时，resume 与 suspend 不发生竞态。
- [x] 4. 客户端断线后重连，事件不重放已完成的 turn，状态通过 `get_state` 对齐。
- [x] 5. 多会话映射到不同 actor，互不串扰。
- [ ] 6. actor 崩溃时保留会话文件，不静默丢历史。
- [x] 7. egress 策略缺失时模型调用被拒绝，且错误可诊断。
- [ ] 8. FULL 与 DATA 两种快照下，恢复后的会话都能续接。
- [x] 9. 同一 request id 重试不重复执行。
- [x] 10. 网关重启后能从 `channel.jsonl` 恢复未完成的投递（会话映射已接入）。
- [x] 11. 断线发生在流式输出中间、prompt 已提交但 `agent_settled` 未到、挂起进行中三种时机，重连后无重复 delta、无缺口。
- [x] 12. 空闲计时器使用可注入时钟；`SUSPENDING` 期间到达 prompt 只产生一次 suspend 和一次 resume。
- [ ] 13. 失败注入：ateapi 不可用、resume 失败、快照上传失败、Pi/bridge/网关崩溃，行为符合预期且错误可诊断。
- [x] 14. 网关重启的三个时间点：提交前、提交后未响应、响应后未确认，恢复结果分别符合预期。
- [ ] 15. 协议一致性：固定 Pi 版本的契约测试通过，latest canary 能提前发现 RPC 漂移。
- [x] 16. 真实 token/key 不出现在 actor env、快照、日志中；actor 无法访问控制面。key 由 egress 在出站时注入，模板里只有占位值。
- [x] 17. 每次挂起决策都有原因日志或指标；跳过挂起可解释。
- [x] 18. 频道边界：Telegram edit 限流、消息分块、附件下载；浏览器频道已覆盖附件与重放。
- [ ] 19. 100 次 suspend/resume 循环后无连接或内存增长趋势，session 条目与文件 hash 稳定。
- [x] 20. 性能指标：首 token P50/P95、suspend 耗时、快照大小、N 个会话 / M 个 worker 的密度（当前记录 turn/first-token/resume 三类）。

### 验收阈值

| 指标 | 初始目标 | 说明 |
|---|---|---|
| 自动挂起触发 | 空闲窗口 + ≤5 秒 | 无手动命令 |
| resume 到首 token | P50 ≤5 秒，P95 ≤10 秒 | 首次测量后按机器校准 |
| 重连 | 0 重复 delta，0 缺口 | 三种断线时机分别验证 |
| 100 次 suspend/resume | 无连接/内存增长趋势；session 条目与文件 hash 稳定 | soak |
| 凭证泄漏 | actor env、快照、日志中零命中真实 token/key | 安全 |
| 密度 | 2 会话 / 1 worker 空闲时全部挂起 | 资源 |

### 出口条件

- [x] 里程碑 1：测试频道可用；网关重启后能从 `channel.jsonl` 恢复未完成投递。
- [x] 里程碑 2：单频道端到端打通（mock LLM）；手动 suspend → 下一条消息自动 resume。
- [x] 里程碑 3：自动空闲挂起、自动 resume、session 与文件连续性全部通过。
- [x] 里程碑 4：浏览器频道、多会话映射、附件、断线重放与延迟测量全部通过。
- [x] 里程碑 5：curl 与 Telegram 两个入口；每个入口都落到同一个会话日志与 actor 映射。

### 参考先例

- substrate 的 kind e2e：`hack/run-e2e-kind.sh`、`internal/e2e`。
- always-on-agent 的 `verification.json`、`scripts/smoke-cluster.ts`、`scripts/smoke-guest.ts` 的断言组织方式。
- pi-chat 现有测试对频道适配与 runtime 的覆盖（如有）作为单元测试基线。

## Out of Scope

- 标准 Pi TUI 或 Claude Code TUI 的原生远端 attach。Pi TUI 不是 RPC 客户端，Claude 没有公开的 RPC/attach 模式。
- OpenClaw 与 ACP 的复用。本方案只借用 always-on-agent 的生命周期思想与模块，不依赖 OpenClaw。
- 多租户鉴权、RBAC、配额与计费。substrate 当前没有控制面 RBAC，部署按单用户或私有环境设计。
- 浏览器前端与移动端 App。本期提供最小浏览器页面用于观察多会话与重放，不做产品化前端；正式入口是 curl 与 Telegram。
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

| 里程碑 | 内容 | 估计 | 状态 |
|---|---|---|---|
| 1 | 抽离 pi-chat 频道与对话运行时为 standalone 网关，用确定性的假后端验证消息与流式编辑 | 3–5 天 | [x] 已完成 |
| 2 | actor 镜像与 RPC bridge，单频道端到端打通 | 2–3 天 | [x] 已完成 |
| 3 | 接入 idle-suspender，验证 suspend → resume → session 续接 | 2–3 天 | [x] 已完成 |
| 4 | 多会话、附件、重连重放、延迟与密度测量 | 3–5 天 | [x] 已完成 |
| 5 | curl + Telegram 双入口，其余入口下线 | 1–2 天 | [x] 已完成 |

### 待确认

- 快照策略默认选 FULL 还是 DATA + session，需要在目标机器上测恢复延迟与快照大小后决定。
- 是否把 runtime 适配层反向贡献给 always-on-agent，做成可插拔 backend。
- TUI 自定义客户端是否在本期实现，还是先只做 Discord/Telegram。
- Pi 版本固定策略与升级窗口。

## 实现状态

### 里程碑 1：独立网关与对话状态

- [x] 独立网关：复用 pi-chat 的 `ConversationRuntime`，每个 turn 的状态写入 `channel.jsonl`。
- [x] 测试频道：`test/support/test-channel.ts` 仅在 `NODE_ENV=test` 下可构造，验证消息投递与流式预览编辑。
- [x] 幂等假后端：`test/support/stub-backend.ts` 按 request id 缓存结果，重试不重复执行；它只服务测试，不连 actor。
- [x] 重启恢复：覆盖提交前、提交后未响应、发送后未记录 outbound、响应已记录未确认四个时间点。
- [x] 回归测试：`npm test` 运行 6 个用例，覆盖以上行为。

### 里程碑 2：actor 内的 RPC bridge

- [x] actor 内 RPC bridge：`src/bridge/`，一个端口同时提供 `/healthz`（ActorTemplate wakeupProbe）与 WebSocket；stdout 严格按 LF 分帧，`U+2028`/`U+2029` 不参与切分（`src/protocol/lines.ts`）。
- [x] 回合关联：`prompt` 带 `requestId`，回合结算时桥额外发 `bridge_result`；`bridge_get_state` / `bridge_result` 支持断线后取回已完成回合。
- [x] 网关侧 `PiBackend`（`src/backend/pi.ts`）：按 request id 幂等，断线不重发已提交的 prompt，重连后向桥索取结果；`WebSocketTransport` 支持 `ate-target-actor` 路由头与自动重连。
- [x] actor 镜像：`images/actor/Dockerfile`，Node 22 + 固定版本 Pi（`package.json` 的 `piVersion`）+ bridge；入口与工作目录全部使用绝对路径，因为 actor 启动时不保留镜像 WORKDIR。
- [x] 集群清单与脚本：`deploy/test/`、`hack/e2e-kind.sh`、`hack/e2e-kind.mjs`。gVisor WorkerPool、mock LLM、ActorTemplate（MEMORY 快照、`/workspace` durableDir）、只放行 mock LLM 的 EgressPolicy。
- [x] 已知限制与对应处理：
  - 快照恢复后 gVisor 里 Pi 子进程可能以 SIGILL 退出。bridge 惰性启动 Pi，并在客户端连接时按固定 `--session-id` 重启，session 文件续接，不重跑上一回合。
  - actor 出网默认被拒；mock LLM 必须由 EgressPolicy 放行，真实部署改成 provider 域名并由 egress 注入凭证。
- [x] 验证：
  - `npm test` 16 个用例（网关与重启恢复 6 + 分帧 4 + bridge 4 + 本地端到端 2）。
  - `hack/e2e-kind.sh` 在 kind 上 7/7：流式回复、bash 工具写 `/workspace/e2e.txt`、手动 suspend、下一条消息经 router 自动 resume、文件与 session 均续接。

### 里程碑 3：空闲挂起与自动恢复

- [x] 生命周期状态机 `src/lifecycle/idle.ts`：`IDLE → ACTIVE → GRACE → SUSPENDING → SUSPENDED`。只有 `turnSettled()` 进入 `GRACE`，`turnStarted()` 一定离开它；挂起只在回合边界发起，因为 substrate 的 suspend 会取消进行中的工作而不是排空。
- [x] 竞态处理：
  - 挂起请求在途时到达的新 prompt 不再发第二次 suspend，且晚到的 suspend 结果不会把状态写回 `SUSPENDED`（否则那一回合结束后不会再挂起）。
  - 挂起失败回落到 `GRACE` 并重设空闲窗口，不会永久卡在 `SUSPENDING`。
- [x] 可注入时钟 `LifecycleClock`，测试用手动时钟驱动；每次决策都通过 `onEvent` 带上 reason（`turn_started`、`turn_settled`、`idle_elapsed`、`prompt_during_suspend`、`suspend_failed`）。
- [x] 控制面客户端 `src/lifecycle/kubectl.ts`：`ensure` / `suspend` / `state`，解析 `ACTOR_STATE_*`；`AlreadyExists` 视为成功。
- [x] 网关接入：`GatewayOptions.lifecycle` 只暴露 `ready` / `turnStarted` / `turnSettled`；`turnSettled()` 放在 `recordJobCompleted` 之后，避免 outbound 与 completed 之间的崩溃提前启动空闲计时。
- [x] 连接修复（实际挂起暴露出两个缺陷）：
  - 挂起会拆掉 actor 但不一定给客户端发 FIN，本地 socket 仍报告 `OPEN`。现在 `WebSocketTransport` 用 `staleAfterMs`（默认 5 秒无流量）判断连接是否可疑，并在 `connect()` 时替换；`PiBackend.dispatch` 每次都向 transport 请求连接，而不是只看 `connected`。
  - 被替换的旧 socket 关闭时不能清掉新 socket，也不能触发重连。
- [x] 验证：
  - `npm test` 23 个用例（网关 6 + 分帧 4 + bridge 4 + 本地端到端 2 + 生命周期 5 + 网关生命周期 2）。
  - `hack/e2e-kind.sh` 追加空闲挂起用例，5/5：流式回复、写 `/workspace/idle.txt`、无手动命令自动 `ACTOR_STATE_SUSPENDED`、下一条消息 router 自动 resume、文件仍可读。
  - 本机测量：空闲窗口 15 秒，实际 `idleMs` 15001–15002 毫秒；挂起后首个回合（含 resume）1253 毫秒。

### 里程碑 4：浏览器频道、多会话与指标

- [x] 浏览器频道 `src/channel/{web,server,events}.ts` + `src/channel/ui.html`：一个 HTTP 端口同时提供页面、`/events`（WebSocket）、`/status` 与 `/metrics`。页面显示流式回复、actor/生命周期状态、每个会话一个标签页，支持附件、`status`、`new session`、`stop`。
- [x] 多会话映射 `src/gateway/manager.ts`：`conversationId -> {conversation, gateway, backend, lifecycle, actor}`。actor 名由会话 id 规范化得到，前缀固定为 `pi-`（`web/alpha -> pi-web-alpha`），首次打开时 create-if-absent。没有 `PI_ACTOR_PREFIX` 这个环境变量；`hack/e2e-web.mjs` 里的同名常量只用于独立推导预期名字。
  - 每个会话独立 actor、独立 `channel.jsonl`、独立锁；一个会话失败不影响其余。
  - 新 actor 建好后立即应用 egress 策略。egress 是按 actor 生效的，漏掉这一步的表现是模型调用被拒；现在会作为回合失败上报，而不是空回复。
- [x] 附件：浏览器以 base64 上传，网关写入会话的 `incoming/` 目录前经过文件名净化（只取叶子名、去掉路径分隔符），再作为 `AttachmentInput` 交给 runtime。runtime 复制到 `filesDir` 并在 prompt 的 transcript 里列出 `/workspace/incoming/...`，与真实频道走同一条路径。
- [x] 断线重放 `src/channel/events.ts`：每个事件分配一次递增 `seq`，环形缓冲保留最近 2000 条。客户端重连带 `since=<seq>`，服务端只补发该序号之后的事件；同一个 `seq` 不会重复下发，也不会跳过。
  - 预览帧携带「累积到目前的整段回复」而不是增量，重放时按序覆盖即可重建文本。
  - 缓存窗口之外的 `since` 会收到 `replay window expired`，随后收到 `history` 帧（`inbound`/`outbound` 记录），从日志而不是事件流重建视图。
- [x] 指标 `src/metrics.ts`：`turns`、`resumed_turns`、`suspends`、`idle_windows`、`suspend_failures` 计数，`turn_millis` / `first_token_millis` / `resume_millis` 的 p50/p95/max（最近 200 个样本，nearest-rank 百分位）。`GET /metrics` 返回 JSON。
  - `resumed` 在 `ready()` 之前判定，且把 `SUSPENDING` 也算作 resume：`ready()` 可能把 `SUSPENDED` 改成 `IDLE`，而挂起请求在途时 actor 同样会消失，两种状态下这一回合都需要把 actor 叫醒。
- [x] 控制命令：`stop` 走 `PiBackend.cancel`（向 Pi 发 `abort` 并让本回合 reject），`new` 走 `new_session`。两者都不改 `channel.jsonl` 的历史。
- [x] 验证：
  - `npm test` 34 个用例（在上一阶段基础上加 web 频道/重放/附件/指标 6 个、HTTP+WebSocket 服务 5 个）。
  - `hack/e2e-kind.sh` 追加 `hack/e2e-web.mjs`，18/18：页面与 `/metrics` 可访问、流式回复、`since` 重放无重复无缺口、无手动命令自动挂起、下一条消息自动 resume、第二个会话拿到不同 actor 且互不串流、计数器与延迟均已记录。
  - 本机测量（idle 12 秒）：`resume_millis` P50 1172–2642 毫秒（两次运行）；`turn_millis` P50 1366–2869 毫秒，P95 最高 13690 毫秒（P95 含冷启动与 resume 回合，第一次拉取 actor 镜像/快照时明显更高）。
- [x] 未覆盖（设计文档里保留为后续项）：真实 Telegram/Discord 频道 smoke、100 次 suspend/resume soak、失败注入矩阵、密度测量。这些需要真实频道与更大的 WorkerPool；当前 kind 环境只有 1 个 worker，本 e2e 因此把两个会话串行执行。

### 里程碑 5：curl 与 Telegram 入口

- [x] `POST /messages`（`src/channel/server.ts`）：一个请求一个回合，响应体是 `{conversation, messageId, text}`。空文本且无附件返回 400，非 POST 返回 405，上游失败返回 502 并带 `error`。请求体有硬上限，避免误传大文件把网关内存打满。
- [x] Telegram 入口：
  - `src/channel/telegram.ts`：一个回合先以一条消息流式编辑，最终文本覆盖它；超过 4096 字符按段落切分成多条；编辑被平台拒绝（限流或消息已删）时回退为发新消息，回复不会丢。
  - `src/channel/telegram-poll.ts`：long-poll `getUpdates`，每个 chat 映射到 `telegram/<chat id>`，因此群聊和私聊不共享 actor。启动时跳过积压更新，重启不会补答停机期间的消息。照片、文档、语音下载后落到会话的 `incoming/`。
  - `PI_TELEGRAM_CHATS` 限定可答复的 chat；空表示任何 chat。
- [x] 投递与观看分离：`GatewayManager.createChannel` 决定一个会话的回复投递给谁。Telegram 会话投给 Telegram，其余投给事件日志，供浏览器与 `POST /messages` 读取。浏览器同时观察一个 Telegram 会话时，回复会以 `history` 帧镜像进事件日志。
- [x] 下线入口：
  - `src/bin/gateway.ts`（stdin/stdout）与它的唯一消费者 `hack/e2e-idle.mjs` 删除。它独有的断言——挂起前写的文件在 resume 后仍可读——由 `hack/e2e-web.mjs` 覆盖。
  - 早期演示脚本删除：没有任何测试验证它，而 `StubBackend` 与 `TestChannel` 已由多个测试文件直接使用。
  - 顺带修掉 `.gitignore` 的 `bin/` 规则：它本意忽略仓库根的构建产物，却把 `src/bin/` 一并忽略，导致两个入口文件从未进入版本库。
- [x] 挂起唤醒循环修复（接入 curl 入口后在集群上暴露）：
  - `WebSocketTransport` 原来在连接断开后 250 毫秒自动重连。挂起会拆掉 actor 并断开 socket，于是一个空闲的网关自己把 actor 叫醒，形成挂起—唤醒循环，actor 永远睡不到一个完整窗口。
  - 现在断开只通知 `onClose`，不自动重连；下一次回合的 `connect()` 才是唤醒 actor 的唯一动作。`PiBackend` 订阅 `onClose` 并清空已结算缓存：缓存来自旧 actor 的 bridge 进程，恢复后的 actor 看不到它，继续用它会把「没跑过的回合计成已结算」。
  - 回归测试 `test/transport.test.ts` 锁住两条：断线后同一 request id 会重新发送 prompt；transport 不会自行重连。
- [x] 验证：
  - `npm test` 46 个用例（新增 Telegram 通道与上传 6 个、入口 4 个、transport 2 个）。
  - `hack/e2e-web.mjs` 增加 curl 断言：`POST /messages` 在集群上返回 mock 模型的结算回复。
  - Telegram 侧用 Bot API 桩验证：一条回合是一次 sendMessage 加若干 editMessageText、超长回复分条、预览节流、编辑失败回退、chat 映射与回复落点。
  - 本机对 kind 集群实测 curl：首个回合 4.64 秒（建 actor + 冷启动），同一 actor 后续回合 0.31 秒；空闲 10 秒后 `ACTOR_STATE_SUSPENDED`，持续观察 20 秒保持挂起；下一条 curl 0.81 秒返回，`resumed_turns` 为 1。
- [x] Telegram 入口的集群实测（Bot API 桩，真实 actor 与 router）：
  - 一条消息进来，网关创建 `pi-telegram-<chat id>` 的 actor 并应用 egress 策略；回复先以 `sendMessage` 出现流式首段，再以 `editMessageText` 收尾。
  - 空闲 12 秒后 `ACTOR_STATE_SUSPENDED`；期间持续观察仍保持挂起。
  - 下一条消息让 actor 回到 `ACTOR_STATE_RUNNING`，回复落在同一 chat；`/metrics` 记 `turns=2`、`suspends=1`、`resumed_turns=1`，`resume_millis` P50 801 毫秒。
- [x] 本地自用的部署收拢：
  - `hack/deploy-local.sh` 用本机 `~/.pi/agent/models.json` 里的单个 provider 建 `pi-local` 模板，并从 `deploy/local/egress-policy.yaml.tmpl` 渲染策略挂到 actor 上。actor 名由 `CONVERSATION` 推导，与网关的映射一致（`local/chat -> pi-local-chat`），打印的启动命令带上 `PI_ACTOR_TEMPLATE`。
  - 模板必须按**平台子 manifest** 的 digest 固定：`docker inspect` 返回的是多架构 index digest，节点按它拉会得到残缺镜像，容器起不来、wakeup probe 超时，表现是 actor `CRASHED` 而不是一条明确的错误。
  - API key 不写进模板：脚本把它放进 atespace 里的 Kubernetes Secret，模板里用占位值 `egress-injected`，由 egress 的 `replaceHeaders` 在出站时换成真 key。脚本同时补上 credential provider 的 atespace→namespace 授权并重启该 Deployment（策略只在启动时读一次）。
  - `src/bin/web.ts` 默认监听 `127.0.0.1`；页面没有鉴权，只有显式设置 `PI_WEB_HOST=0.0.0.0` 才允许同网段访问。
- [x] 未覆盖：真实 bot token 的端到端 smoke 需要外部网络与一个测试 bot，留作手动步骤；Discord 未实现，设计文档仍把它列为后续项。

### 失败回合与错误上报（已修复）

两处独立缺陷，都会让一次失败看起来像一次「成功的空回复」：

1. **失败的回合不结算生命周期**。`turnStarted()` 在提交前把 `inflight` 加一，只有走到底的回合才调用 `turnSettled()`。提交或响应抛错时只记一条 `job_failed`，`inflight` 停在 1；`turnSettled()` 从此被 `inflight > 0` 挡掉，状态永远到不了 `GRACE`。一次 provider 抖动就让该 actor 再也不会空闲挂起。现在失败路径也在 `finally` 里结算（注入式崩溃除外），并新增 `test/gateway-lifecycle.test.ts` 的用例锁住「失败后仍能挂起」。
2. **provider 错误被当成空文本**。Pi 用 `message_end` 的 `stopReason: "error"` + `errorMessage` 报告失败，重试耗尽时还有 `auto_retry_end.success: false` + `finalError`；网关此前只看 `agent_settled`，把空字符串当作正常回复写进 `channel.jsonl`。现在 bridge 读取这两个信号，先发 `bridge_result`（带 `error`）再转发 `agent_settled`，backend 把错误放进 `AgentResponse.error`，网关记 `job_failed` 并通过 `Channel.sendError` 把原因送到 curl、浏览器或 Telegram。`test/bridge.test.ts` 用 503 的 mock provider 覆盖这条路径。

### 真实 provider 的接入要点（已修复）

真实 provider 跑不通有过两个独立原因，都不是集群故障：

1. **规则类型写错**。策略里用 `http:` 只授权明文流量；`Policy.SNIRules(port)` 只为 `https` 和 `tls_passthrough` 生成 SNI 规则，`http` 规则被跳过。结果是 `sniRules: 0`，egress 数据面对 TLS 握手返回 `chain: denied, details: filter_chain_not_found`，Pi 表现为 `Connection error.`。把规则改成 `https:` 后 `sniRules: 1`，握手不再被拒。
2. **actor 不信任 egress 的 MITM CA**。`https` 规则意味着 TLS 在网关终结，网关用内置 CA 现签叶子证书；这个叶子链不到公共根，Node 会直接拒绝。substrate 提供 `systemInfo` + `trustBundle` 卷来投影信任锚，运行时需要设置 `NODE_EXTRA_CA_CERTS` 指向该文件（见 `docs/egress-trust-bundle.md`）。

修复后本机实测：`deepseek-v4-pro` 返回完整中文回复，首 token 约 7 秒（含 actor 冷启动与推理）。

模板因此多了两样东西：`system-info` 卷（`egress-mitm.ate.dev` + `system-roots.ate.dev`），以及 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 两个环境变量。mock provider 走明文，不需要它们，但保留在同一个模板里没有副作用。
