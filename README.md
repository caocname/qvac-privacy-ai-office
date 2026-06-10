# QVAC Assistant — 赛事提交物

## 项目信息

| 字段 | 内容 |
|---|---|
| **项目名称** | QVAC Assistant — 离线 AI 办公助手 |
| **参赛赛道** | 通用设备赛道 |
| **开源协议** | Apache 2.0 |
| **GitHub 仓库** | https://github.com/caocname/qvachackstext |
| **DoraHacks 平台** | https://dorahacks.io |
| **提交日期** | 2026-06-06 |
| **早鸟截止** | 2026-06-14 |

## 团队成员

| 姓名 | 背景 | 职责 |
|---|---|---|
| caocname | 软件工程 / 全栈开发 | 架构设计 + 前端 |
| lkdgithub | 系统开发 / AI 应用 | 后端 + AI 推理 |

## 团队所在地

中国

---

## 提交物清单

本目录包含以下完整的提交材料：

| 序号 | 文件/目录 | 说明 |
|---|---|---|
| 1 | `项目复现指南.md` | 完整硬件参数、软件环境、逐步骤复现说明 |
| 2 | `接口清单.md` | 全部 API 接口列表（按标准格式整理） |
| 3 | `审计日志/` | 标准审计日志（JSON + CSV），含 36,457 条记录 |
| 4 | `一键部署/` | 安装依赖.exe + QVAC开发启动器.exe |
| 5 | `README.md` | 本文件 — 项目总览与提交物索引 |

### 额外说明

- **演示视频**: [https://youtu.be/sHkjUeodIdg](https://youtu.be/sHkjUeodIdg)（YouTube 非公开），展示项目完整运行效果，时长 ≤ 5 分钟
- **系统资源时序日志**: 包含在 `审计日志/audit-log-full.json` 中，每条记录含 `absolute_datetime` 和 `relative_timestamp_ms`，时间轴误差 ≤ 500ms
- **硬件运行证明**: 见 `审计日志/hardware_snapshot.json` 及 `项目复现指南.md` 第 2 节
- **项目源码**: 完整源码托管于 [GitHub](https://github.com/caocname/qvachackstext)，基于 Apache 2.0 开源

---

## 技术亮点

1. **全离线架构**: 零外网连接，所有 AI 推理（LLM / Embedding / ASR / TTS）均基于 QVAC SDK 在本地 GPU 运行
2. **安全保障**: Kill Switch 网络探针（5s 检测周期）、AES-256-GCM 数据加密、Windows 凭据管理器密钥托管
3. **RAG 知识库**: FAISS 语义检索 + 512 Token 智能分片 + 多模态文档解析（PDF/DOCX/TXT/MD）
4. **流式推理**: SSE 逐 Token 推送 + OOM 防护动态截断 + 上下文窗口智能裁剪
5. **异步架构**: ASR/TTS/日志写入均通过 ThreadPoolExecutor 异步隔离，主对话流保持最高优先级
6. **绿色便携**: PyInstaller 打包 exe 一键启动，无需安装 Python/Node.js 解释器环境

---

## 性能数据（RTX 3060 6GB）

| 指标 | 实测值 | 基线要求 |
|---|---|---|
| TTFT（首 Token 延迟） | ~2.1s | ≤ 3s |
| 推理吞吐 | ~18 Tokens/s | ≥ 15 Tokens/s |
| GPU 显存占用 | ~718 MB（空闲）/ ~2.5 GB（推理峰值） | ≤ 11 GB |
| RAM 占用 | ~9 GB | ≤ 14 GB |
| 审计日志记录数 | 36,457 条 | - |

---

*QVAC Hackathon 2026 — QVAC Hackathon 离线 AI 办公助手（通用设备赛道）*
