# 家庭关系咨询系统

本仓库实现一对伴侣共用的咨询工作流。已用清楚标记为虚构的双人案例跑通私密 Sites → 公开 configured provider Responses 网关 → 正式回复与自动理解 → UUID 增量读取 → 文件导出与双方确认结案。线上任务用 provider3.8-27b 完成于约 73 秒，原表达、回复和检查点身份保持不变，双方收据与网页结果均已读回。网站仍为只读；各自实际 Agent 的安装、每小时 heartbeat 和关闭客户端后的无人值守执行仍需独立配置与验收。

源码仓库：[callzhang/family-therapist](https://github.com/callzhang/family-therapist)（私有）。网站：[我们之间](https://YOUR_SITE_HOSTNAME)（保持 Sites 原有私密访问范围）。服务端模型配置、密钥和成员校验信息分别存储在 Sites；本地草稿、真实 Token 与测试数据库不包含在源码或发布包内。

开发入口：

```sh
# 全部协议、治疗师、本地客户端和网站测试
node --test tests/therapist/*.test.mjs tests/local/*.test.mjs tests/protocol/*.test.mjs tests/site/*.test.mjs

# 构建网站源代码
npm run build
```

网站源代码位于 [`sites/family-therapist`](sites/family-therapist)。成员 Token 的本地配置和新 D1 初始化流程见[成员 Token 运维说明](docs/operations/member-tokens.md)。不要将明文 Token 或服务端 seed 配置提交到仓库。

现有 Sites 的模型配置、D1 迁移、成员初始化和 R2 导出已验证；新部署仍需独立完成这些操作。本地客户端在本人确认并提交完整表达后，可调用 processTherapist 处理排队表达，等待状态流，再通过原 UUID 收据和同步获取正式回复。断流先查原收据；失败后的有限重试是显式操作，不重新提交表达，也不自动批准共识。证据与操作边界见[configured provider 线上验证记录](docs/verification/2026-10-09-provider-responses-runtime.md)及[本地客户端说明](docs/operations/local-client.md)。

产品范围和阶段状态见[系统设计](docs/superpowers/specs/2026-10-08-family-therapist-design.md)及[路线图](docs/superpowers/plans/2026-10-08-family-therapist-roadmap.md)。

当前发布检查包括 211 项确定性测试、应用类型检查、Worker 构建及真实托管模型与文件读回。此前生产依赖的 5 项已知漏洞已升级至补丁版本，该次生产依赖审计为 0 项；此结论不包括开发依赖、未重跑的审计、GitHub CI 或一般咨询质量评估，详见[依赖验证说明](docs/operations/production-dependency-security.md)。
