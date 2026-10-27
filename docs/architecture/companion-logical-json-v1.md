# Companion logical JSON v1

状态：协议与本地实现；本文不代表真实手机、跨网或账号链路已验收通过。共享的公开固定向量见 [companion-logical-v1-vector.json](fixtures/companion-logical-v1-vector.json)。

## 对象大小与交付

一个逻辑消息必须是 JSON 对象，序列化后的完整 UTF-8 长度最多 **1,048,576 字节（1 MiB）**，包括 RPC 的 `type`、`requestId`、`result` / `params` 等信封字段。不能只按模型列表或正文单独计量。超出一字节即明确拒绝。

序列化后不超过 5000 字节时直接发送原对象。超过 5000 字节时，压缩完整对象并分片。接收端在完整组装、长度、zlib、SHA-256 和 JSON 检查全部通过后，才向正常请求处理器或 UI 交付一次完整对象；部分分片不是部分目录或部分回复。

这不是扩大底层帧：文本通道每帧明文仍最多 5500 字节，服务器接受的 AES 文本帧仍最多 8192 字节。旧 peer 未协商该能力时不接收陌生分片；超出旧消息能力应返回明确的升级提示。

## 协商

电脑在原有、已认证的 `pair.approved` 中声明：

```json
{"logicalCodec":"zlib-parts-v1","logicalJsonMaxBytes":1048576}
```

手机确认匹配后，先通过当前已认证通道发送 `client.hello`，再开始依赖该能力的请求：

```json
{"type":"client.hello","logicalCodec":"zlib-parts-v1","logicalJsonMaxBytes":1048576,"sentAt":0}
```

`client.hello` 严格只有以上四个字段。示例中的 `sentAt` 只是占位，真实发送时使用当前毫秒时间。能力仅属于当前连接；direct / text 切换、重连或 epoch 改变必须重新协商，并清空旧的部分组装和未发送队列。能力协商不授予项目、会话或工具权限。

## 压缩与分片

采用 **zlib 包装的 DEFLATE**，兼容 Java 默认 `Deflater` / `Inflater`，不是 raw DEFLATE 或 gzip。压缩后的总字节数最多 1,114,112 字节，即 1 MiB + 64 KiB。

压缩字节按每片 3000 字节固定切分，最多 372 片。非末片必须恰好 3000 字节，末片必须恰好为余数；`total` 必须等于 `ceil(compressedBytes / 3000)`。每片 JSON 如下：

```json
{
  "type":"logical.part",
  "v":1,
  "transferId":"20000000-0000-4000-8000-000000000001",
  "index":0,
  "total":2,
  "decodedBytes":8012,
  "compressedBytes":3484,
  "sha256":"10f813d2e143127c5e86a56a91dea67f86755b9355063a1afe2f4b23cca5dde4",
  "requestId":"10000000-0000-4000-8000-000000000001",
  "codec":"zlib",
  "data":"..."
}
```

严格要求上述 11 个字段，仅允许 seal 额外添加数字 `sentAt`：

- `transferId` 为标准小写 UUID 字符串；`index` 从 0 开始，必须严格按序到达。
- `v`、`index`、`total`、长度字段为相应范围内的 JSON 整数，`v` 为 1。
- `decodedBytes` 为原完整对象的 UTF-8 字节数，`compressedBytes` 为完整 zlib 流长度。
- `sha256` 为原始未压缩 UTF-8 字节的 SHA-256，小写 64 位十六进制；不是解析后重新排列键的 JSON 哈希。
- `data` 为当前压缩片的规范 base64url，无 `=` padding；解码再编码必须相等。
- `requestId` 为原对象的字符串请求标识，缺少时为 `""`；最多 128 UTF-8 字节且不能含 NUL。它只用于关联等候和进度，不能替代请求授权或防重放记录。
- 同一 transfer 每片的标识、总片数、长度、哈希、请求标识和 codec 必须一致。

压缩率高的大对象也可能只有一个 `logical.part`。不能用片数推断原对象大小，也不能假设每片代表一条模型或一段消息。

## 接收、进度与取消

每个通道最多有一个正在组装的大型 transfer；小的普通消息可以穿插。不能把第二个大 transfer 的分片穿插进第一个。接收缓冲区受 `compressedBytes` 上限约束，解压输出受已声明 `decodedBytes` 和 1 MiB 上限约束。实现必须检查：

1. 精确字段、类型、规范 UUID / base64url、长度、顺序以及统一元数据。
2. zlib 正常结束、消费全部压缩输入、无尾随字节或拼接的第二个流、输出长度与声明完全一致。
3. SHA-256 一致、UTF-8 与 JSON 有效、结果为对象；不能用解压后的 `logical.*` 再次递归封装。当前实现还限制 JSON 容器深度为 20。
4. 原对象请求标识与分片元数据一致；随后仍执行正常方法、媒体、字段、账号、项目、会话和审批策略。

只接受完整且有效的下一片作为该 transfer 的进度。进度可报告 `transferId`、`requestId`、已收压缩字节数和总压缩字节数，不报告 `data` 或正文。其他小消息不延长该 transfer 的有效期。

使用本地单调时钟：连续 **30 秒无分片进度**即清空；无论进度如何，单个 transfer 总寿命最多 **60 分钟**。宿主在没有新数据时也必须检查超时。旧 transfer 已超时后，可以从不同 transferId 的新第 0 片重新开始；旧标识或非第 0 片不能续接。epoch 或连接销毁立即丢弃旧部分对象，不能跨连接拼接。

取消消息为：

```json
{"type":"logical.cancel","transferId":"20000000-0000-4000-8000-000000000001","sentAt":0}
```

严格只有 `type`、`transferId`，可选数字 `sentAt`；没有 `v` 字段。匹配时清空对应未完成接收，并移除该 transfer 尚未发送的分片。未知标识幂等忽略，不能取消其他 transfer。取消未确认的请求不等于撤销已执行的操作；读取状态确认，不自动重放 mutation。

## 发送调度、加密与配额

每片在真正发送前使用现有通道独立 seal，取得新的包标识、随机 nonce 和当前 `sentAt`。direct 仍通过原生 DataChannel，text 仍通过现有房间 / 角色 / epoch 绑定的 AEAD；zlib 压缩不替代加密或身份验证。

发送队列必须有界并保持每个大型对象的分片顺序。小型停止、拒绝和控制消息可以优先插入；等待限速额度时仍需接收和处理取消、退出及撤销。接收端不得在校验结束前把部分目录交给 UI。

服务器只转发现有 AES 密文帧，原有 **8192 字节帧上限、全局 8 KiB/s、账户 2 KiB/s、月度 2 GiB 硬限额**保持不变。压缩与分片不重置额度，不绕过限速，也不放宽文本模式的媒体和审批策略。

模型目录不带显式 `offset`、`limit` 或 `knownRevision` 时，在 1 MiB 逻辑上限内返回完整安全 `id` / `name` 列表；显式分页仍保留 4000 字节页预算与目录修订号。历史和单条正文分页继续可用。

## 设备票据续期

长传输不授予永久身份。只有服务器已声明支持时，才在现有 TLS 控制 socket 使用 `auth.refresh`，由服务器验证同一设备、账号、角色和房间绑定。只有匹配请求的 `auth.renewed` ACK 才更新本地授权截止时间；未确认、过期、退出、账号改变或撤销仍停止连接。房间密钥与 text epoch 不因票据续期而替换。

续期控制帧及其四字段 ACK 沿用账户传输契约；逻辑消息中的内容不能伪造授权续期。
