# cc-switch 接入：让引擎站在 Codex 与 cc-switch 之间

## 为什么需要它

cc-switch 在启动和切换供应商时，会把 Codex 的 `config.toml` 改回它自己：

```toml
[model_providers.custom]
base_url = "http://127.0.0.1:15721/v1"
```

这样一来，Codex 直接连到 cc-switch，附件管理器的引擎（17891）就不在请求路径上了。手动改配置没有用，下一次切换供应商又会被覆盖。

这个接入把路径改成：

```
Codex  →  引擎 17891  →  cc-switch 15721  →  真正的上游
```

引擎只做两件事：原样转发请求，按勾选改写图片。它不接触密钥，也不解析供应商配置。

## 两部分改动

- **引擎**：支持 `CAM_UPSTREAM_URL` 环境变量和 `--upstream` 参数。默认还是 `https://chatgpt.com`；指到本机地址时直接连接，不走系统代理。请求路径原样保留，所以 Codex 访问 `http://localhost:17891/v1/responses`，cc-switch 收到 `http://127.0.0.1:15721/v1/responses`。
- **修正器**：常驻小进程，监听 `config.toml`。cc-switch 每写回一次 `15721`，它在 150 毫秒内改回 `17891`。只有附件管理器的托管标记还在时才生效，所以面板里的“停用插件”仍然说了算。

## 安装

先在仓库根目录安装好插件（会重启引擎，让新代码生效）：

```powershell
cd E:\project\codex-attachment-manager-fork
node plugin\src\cam.ts install
```

再安装修正器：

```powershell
node integrations\cc-switch\setup.mjs install
```

安装脚本做四件事：把修正器复制到 `%USERPROFILE%\.codex-attachment-manager`，在“启动”文件夹放一个隐藏启动器，立刻启动一次，并把 `CAM_UPSTREAM_URL=http://127.0.0.1:15721` 写进当前用户的环变量。

改完环境变量后要重启 Codex，插件服务才会把它传给引擎。

## 验证

```powershell
# 引擎报告的上游应当是 cc-switch
curl.exe http://127.0.0.1:17891/__cam/health

# 修正器状态：currentProviderBaseUrl 应当指向 17891
node E:\project\codex-attachment-manager-fork\integrations\cc-switch\setup.mjs status
```

再用 Codex 发一条消息，`plugin\src\proxy.ts` 的日志里会出现 `/v1/responses`，说明请求确实经过了引擎。

## 卸载

```powershell
node integrations\cc-switch\setup.mjs uninstall
```

然后 `node plugin\src\cam.ts uninstall`，让 Codex 恢复直连并移除插件。

## 限制

- 修正器只认 `model_providers.custom` 这一张表；供应商名字不是 `custom` 时，通过 `--provider` 指定。
- 修正器是 Windows 专用（启动文件夹 + VBS 隐藏窗口）。macOS、Linux 上直接运行 `corrector.mjs`，借助系统的服务管理器常驻。
- `CAM_UPSTREAM_URL` 写在用户环境里。想换上游，改这个变量后重启 Codex，或者给 `setup.mjs install` 传 `--upstream`。
- cc-switch 自己仍然是 Codex 配置的拥有者：模型、供应商、密钥都由它写；修正器只碰 `base_url` 这一行。
