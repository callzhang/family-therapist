# Changelog

## Unreleased

- 新增成员本人确认表达的认证 intake、原文 UUID 回执和原子持久 queued task；queued 仅证明入队，不表示 Therapist 已运行或回复，Hosted migration 与真实 provider 执行仍未验证。
- 新增认证双人讨论命令 API 与紧凑 CAS 投影，原子保存议题/提案事件、线程版本和双人确认的线程共识或全局共同原则；精确 UUID 重试返回原回执，尚无 worker 或 hosted 执行声明。
- 新增历史协议模块，定义已授权范围内基于服务器顺序的 UUID 游标分页与固定快照边界。
- 新增讨论协议模块，定义双人提案确认、议题状态、切换、结案与重开规则。
- 新增五个查询工具的协议和可恢复的 Responses 咨询执行循环，修复恢复时丢失原始输入、重复调用模型及作用域校验问题。
- 编写云端 Therapist Skill 和咨询方法参考；准备私密 Sites starter。真实生成验证仍被 API 余额耗尽阻塞。
- 编写本地 Therapist Assistant Skill、整理与初始化参考、运维边界及虚构行为评估案例规格；这是指令源交付，不包含客户端、实际传输、heartbeat 创建或升级执行。
