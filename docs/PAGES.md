# 网站发布（GitHub Pages）

在线演示：https://annoyingc.github.io/scene-cv/ ，就是这个仓库 `main` 分支的根目录。

网站全是静态文件，没有构建步骤：推送 `main` 就会更新。根目录有 `.nojekyll`，GitHub 原样发布文件，不跑 Jekyll。

## 第一次开 Pages

仓库的 Settings → Pages：Source 选 "Deploy from a branch"，分支选 `main`，目录选 `/ (root)`。之后每次推送，Actions 里会跑一次 `pages build and deployment`，成功以后网站就更新了。

只改 Pages 的设置不会触发构建；要马上重新发布，可以在 Actions 里重跑最近一次 `pages build and deployment`，或者用 GitHub CLI：

```sh
gh api -X POST repos/<你的账号>/<仓库名>/pages/builds
```

## 推送之前

```sh
npm test
npm run audit:public
```

`audit:public` 检查已跟踪文件里的本机路径、常见凭据特征和联系方式。放上去的东西访客都能看到、下载：只想留在本地的个人内容（真实简历、联系方式、照片、封面、配乐）放在 `.gitignore` 里列出的那几个文件夹，见 README 的"改内容"。

## 改成你自己的网站

Fork 或下载这个仓库，按 README 的"改内容"换掉 `index.html` 里的样例，推到你自己的仓库，再按上面开 Pages。网址是 `https://<你的账号>.github.io/<仓库名>/`。
