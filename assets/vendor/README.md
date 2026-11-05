# 第三方 3D 素材

房间里的家具、灯和小物件来自别人公开发布的素材，分别采用 **CC0 1.0** 或 **CC BY 4.0** 许可。

**这些素材的许可证跟着素材本身走，不受这个仓库代码许可证的约束。** 就算仓库代码用 MIT 之类的许可证发布，下面这些素材也仍然是各自原来的许可证。每一项的作者、原链接和许可证都写在 [`credits.json`](credits.json) 里。

| 许可证 | 来源 | 你可以 | 条件 |
|---|---|---|---|
| [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Poly Haven | 随意使用、修改、再分发，包括商用 | 没有条件。写上作者是礼貌，不是义务 |
| [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Sketchfab | 随意使用、修改、再分发，包括商用 | 必须注明作者、原链接和许可证，并说明改了什么；不能暗示原作者为你背书 |

## 文件夹

- `assets/vendor/credits.json`：素材清单。每一项包括名字、作者、原链接、许可证，`changes` 记录我们对原作做了哪些修改（比如减面、缩小贴图），CC BY 4.0 要求写明这些修改。`excluded` 列出看过但没有用的素材，以及不用的原因。
- 当前使用的第三方素材已经处理并合并进 `assets/tower/tower.glb`；`assets/tower/manifest.json` 的 `vendor` 字段列出实际使用项。
- `vendor-src/`：原始文件，体积大，不进仓库。运行下面的命令重新下载：

```bash
node scripts/fetch_assets.mjs
```

Poly Haven 的文件会自动下载并校验。Sketchfab 必须登录才能下载，脚本只会打印链接：登录后选 glTF 格式下载，解压到它提示的文件夹。

## 加新素材之前

1. 确认许可证是 CC0 或 CC BY。不要用 CC BY-NC（禁止商用）和 CC BY-ND（禁止修改），因为我们一定会减面。
2. 读一遍作者写的说明。如果贴图或模型来自别的网站，作者未必有权把它们一起授权出去。旧地图（Old Map）就是因为这个没有用。
3. 在 `credits.json` 里加一项，处理完之后在 `changes` 里写明改了什么。
4. 塔楼的“素材致谢”从 `credits.json` 读取，并按场景 manifest 的使用清单筛选，不需要另外手写。

挑选素材时用的候选页面在 [`lab/assets.html`](../../lab/assets.html)，里面有 Poly Haven 和 Sketchfab 上的一百多个候选，可以照着它挑你自己的。
