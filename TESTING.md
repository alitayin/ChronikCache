# 测试开发文档

## 目标

本项目的测试体系主要服务于两件事：

1. 在升级 `chronik-client` 时，尽早暴露字段名、类型和事件语义变化带来的回归。
2. 在继续重构“缓存 / 预热器”逻辑时，锁住外部行为，避免 address 和 token 两条路径出现不一致。

## 测试分层

### 1. 单元测试

位置：`test/unit/**/*.test.js`

用途：

- 验证纯逻辑函数
- 验证单个类在 mock 依赖下的行为
- 快速执行，作为默认测试入口

当前默认命令：

```bash
npm test
```

等价于：

```bash
npm run test:unit
```

### 2. 集成测试

位置：`test/basic.test.js`

用途：

- 验证和真实 Chronik 节点联通时的基础可用性
- 只做 smoke test，不作为默认测试入口

命令：

```bash
npm run test:integration
```

默认情况下，这些用例会显示为 `pending`，不会真的访问外部 Chronik。
如果你要执行真实联网 smoke test，请使用：

```bash
npm run test:integration:live
```

## 测试优先级

补测试时，优先覆盖以下高风险区域：

1. `chronik-client` 升级影响的字段与类型边界
2. `bigint` 的序列化、持久化、读取和对外返回
3. 地址 / token 历史查询的状态机
4. 排序规则与分页命中逻辑
5. websocket 事件驱动的缓存刷新与失效

## Mock 策略

### ChronikClient

除集成测试外，不直接访问真实网络。对 `chronik` 使用最小 mock：

- `address(address).history()`
- `tokenId(tokenId).history()`
- `tx(txid)`
- `ws(config)`

单元测试只 mock 当前场景会触发的方法，不额外实现无关 API。

### ChronikCache 内部依赖

在测试 `ChronikCache` 主行为时，优先替换这些依赖：

- `db`
- `wsManager`
- `failover`
- `logger`
- `stats`

这样可以把测试聚焦在业务逻辑，而不是把数据库、定时器和 websocket 一起带进来。

### 数据库

`DbUtils` 本身使用真实临时目录进行测试，避免把序列化逻辑 mock 掉。

### 定时器

如果测试用例只验证定时器是否被注册、重置或清理，则优先 stub 方法调用而不是等待真实时间流逝。

## 命名约定

测试文件命名：

- `test/unit/<module>.test.js`

测试描述建议使用以下格式：

- `it('returns status 3 when cache misses and page size is small', ...)`
- `it('clears token cache and unsubscribes token websocket', ...)`

要求描述“行为”，不要描述“实现细节”。

## 覆盖范围建议

### `src/lib/sortTxIds.ts`

至少覆盖：

- confirmed 排序
- unconfirmed 排序
- txid tie-break

### `src/lib/dbUtils.ts`

至少覆盖：

- `bigint` round-trip
- 普通字符串不被误转成 `bigint`
- 分页删除
- metadata 读写

### `src/lib/WebSocketManager.ts`

至少覆盖：

- 首次订阅
- 重复订阅不重复添加
- 达到上限时驱逐最旧订阅
- `unsubscribeAddress` / `unsubscribeToken`
- `resetWsTimer`
- 只转发当前支持的消息类型

### `src/index.ts`

至少覆盖：

- `REJECT` 状态返回 `status: 2`
- 非 `LATEST` 且 `pageSize > 200` 返回 `status: 1`
- 非 `LATEST` 且小分页回退 Chronik API 返回 `status: 3`
- `LATEST` 时优先命中本地缓存
- `clearAddressCache`
- `clearTokenCache`
- `clearAllCache`
- `getCacheStatus`

### `src/lib/failover.ts`

至少覆盖：

- 成功重试
- 超过最大重试次数后抛错
- `handleDbOperation` 对 `NotFoundError` 返回 `null`

### `src/lib/TaskQueue.ts`

至少覆盖：

- 任务按顺序完成
- 并发上限生效

### `src/lib/CacheStats.ts`

至少覆盖：

- 基础统计结构返回正确
- 数据库异常时的兜底分支

## 开发原则

1. 默认优先写单元测试，不把外部网络波动引入默认测试流程。
2. 测试应锁定“行为契约”，而不是照着实现抄一遍。
3. 对当前已知 bug，可以先写失败测试，再最小修复。
4. 如果一个测试只能通过真实 Chronik 才有意义，就把它放到集成测试，而不是 unit。
5. 新增测试后，必须执行 `npm test`；如有必要，再额外执行 `npm run test:integration`。

## 当前执行顺序

建议每次改动都按以下顺序验证：

1. `npm test`
2. 如果改动涉及真实 Chronik 兼容或联网行为，再执行 `npm run test:integration`

## 后续补全方向

当前文档建立后，后续优先按这个顺序补测试：

1. `lib` 层单元测试补全
2. `ChronikCache` 主流程行为测试补全
3. `chronik-client` 类型与字段兼容测试
4. 集成测试断言增强
