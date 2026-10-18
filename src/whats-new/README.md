# LoliCode 更新摘要（应用内弹窗）

用户升级后第一次打开 LoliCode，应用会汇总从上次已读版本到当前版本的摘要。数据来自本目录的 JSON，构建时打进安装包，由 `src/lib/whatsNew.ts` 读取；摘要本身不需要联网。

LoliCode 的对外发布信息使用自己的[更新记录](../../CHANGELOG.md)、[GitHub Releases](https://github.com/treasureGrove/LoliCode-Releases/releases)和[产品下载页](https://lolicode.com/)。旧 JSON 中保留的 CC Switch 版本属于历史记录，不是当前产品身份或下载入口。

## 每个版本一个文件

文件名与应用版本一致，例如 `4.0.17.json`：

```json
{
  "version": "4.0.17",
  "items": [
    {
      "type": "improve",
      "zh": "改进工作台导航与账户菜单",
      "zh-TW": "改善工作台導覽與帳戶選單",
      "en": "Improve workspace navigation and the account menu",
      "ja": "ワークスペースの操作とアカウントメニューを改善"
    }
  ]
}
```

- `type` 为 `new`（新增）、`fix`（修复）或 `improve`（改进）。
- 每版最多 4 条，每条一句话。中文、繁中不超过 40 字，日文不超过 50 字，英文不超过 100 个字符。
- 四种语言都要填写，按用户能感知的影响排序，不把规划功能写成已交付功能。
- `"items": []` 表示该版不弹窗，例如纯构建变更；版本文件仍需保留。

规则由 `tests/config/whatsNewEntries.test.ts` 检查。版本摘要应与应用版本及真实发布内容同时更新，打 tag 前完成核对。

打包、签名和独立更新源的发布步骤见 [LoliCode 发布指南](../../docs/guides/lolicode-release.md)。
