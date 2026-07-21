# Ark Workbench

> 一个本地运行的火山方舟图片生成面板：提交提示词、观察队列、管理本机生成结果。

Contact: **Jacksun** · [qinji@jack-sun.com](mailto:qinji@jack-sun.com)

![Ark Workbench 主视觉：本地图片生成队列与素材管理的概念示意。](docs/assets/ark-workbench-hero-v1.png)

- 命令式输入生成
- 实时看任务状态
- 自动把图片保存到本地
- 随时打开文件夹管理素材
- 能对历史任务重跑、删除、打开

## 现在这版怎么用

1. 先设置环境变量 `ARK_API_KEY`
2. 启动服务
3. 在浏览器里输入 `gen` 命令提交图片

示例：

```bash
cd ark-workbench
export ARK_API_KEY=你的key
npm start
```

然后打开：

```text
http://localhost:8787
```

## 命令

- `gen <prompt>`: 直接生成图片
- `gen <prompt> --nw`: 无水印生成
- `gen <prompt> --size 2K`: 指定尺寸
- `gen <prompt> --model xxx`: 指定模型
- `reveal`: 打开图片文件夹
- `open <id>`: 打开某张图
- `rerun <id>`: 用同样参数重跑
- `delete <id>`: 删除本地图和记录

## 存储

图片会保存在：

```text
`~/Library/Application Support/Ark Workbench/generated-images`
```

程序会扫描这个本机目录中已有的图片。也可以设置 `ARK_WORKBENCH_DATA_DIR` 使用其他目录。

## 设计思路

这版刻意不做成复杂桌面软件，先做成一个本地网页工位：

- 比命令行更直观
- 比聊天更适合盯状态
- 比手工找文件更适合管理素材

后面如果你想继续，我可以再补这三块：

1. 分类标签和搜索
2. 批量重跑与多任务队列
3. 任务记录导出成 Markdown/CSV
