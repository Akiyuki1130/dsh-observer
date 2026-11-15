# dshmarket / awesome-dsh-plugin 上架材料

## 状态

- [x] GitHub 仓库：https://github.com/Akiyuki1130/dsh-observer
- [x] `dsh.bundle` manifest（`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`）
- [x] `dsh-plugin` topic 已加
- [x] 预构建 tarball：https://github.com/Akiyuki1130/dsh-observer/releases/download/v0.6.0/dsh-observer-0.6.0.tgz
- [ ] 仓库满 1 天后提 PR（CI 会检查仓库年龄）

## 提 PR 步骤

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 新增文件 `data/plugins/Akiyuki1130__dsh-observer.yml`，内容见 `market/awesome-dsh-plugin.yml`
3. 提交 PR，标题：`Add Akiyuki1130/dsh-observer`
4. 等 CI + 维护者 review（通常 1 天内合并，合并后网站与 dshmarket 自动收录）

## 注意

- 只加这一个文件，不要手改 README（README 由脚本生成）。
- 描述必须与代码一致（CI 会核对）。
- 一个 PR 最多 3 条，这里只有 1 条。
