# AI主理·道场看板 · 手机长期访问部署指南

看板是**纯静态单页**（`index.html` + 同目录 `data/`），无后端，手机浏览器直接打开即可。
两种部署方式，任选其一。

---

## 方式 A：GitHub Pages（最快，零成本，手机随时访问）

1. 把 `/workspace/daochang` 推到 GitHub 仓库（假设叫 `daochang`）：
   ```
   cd /workspace/daochang
   git init && git add . && git commit -m "daochang dashboard"
   git remote add origin https://github.com/<你的用户名>/daochang.git
   git push -u origin main
   ```
2. 仓库页 **Settings → Pages → Source** 选 *Deploy from a branch*，Branch 选 `main`，Folder 选 `/ (root)`，Save。
3. 等 1-2 分钟，访问：
   ```
   https://<你的用户名>.github.io/daochang/
   ```
   把该链接存到手机主屏即可，手机随时看。
4. 想要独立二级域名：加 `CNAME` 文件放仓库根目录，写你的域名（如 `daochang.yourdomain.com`）。

> 看板 JS 用**相对路径**读取 `./data/latest.json`，Pages 托管同目录文件即可，无需改代码。

---

## 方式 B：Nginx 服务器（你有公网 IP / 自有域名时）

```
sudo cp deploy/nginx.conf /etc/nginx/conf.d/daochang.conf
# 修改 nginx.conf 里的 server_name、root 为你的域名与看板路径
sudo scp -r /workspace/daochang/* user@你的服务器:/var/www/daochang/
sudo nginx -t && sudo systemctl reload nginx
```
配 HTTPS：
```
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d daochang.example.com
```

---

## 让看板"实时"刷新（配合定时任务）

定时任务（每小时）运行 `snapshot.js` 会把最新快照写入 `data/latest.json`，看板 JS 在打开时读取。

- **GitHub Pages 场景**：定时任务跑完后把 `data/latest.json` 也推到仓库（可加一条 cron/Action 自动 commit+push，Pages 自动更新），手机刷新页面即见最新。
- **Nginx 场景**：定时任务直接写服务器 `/var/www/daochang/data/latest.json`，手机刷新即最新（已设 `Cache-Control: no-cache` 避免浏览器缓存）。

---

## 移动端适配

`index.html` 已含：
- `<meta name="viewport" content="width=device-width, initial-scale=1">`
- 响应式网格（`.grid` 在 ≤820px 自动变单列，KPI 卡片自适应）
- 表格横向滚动、图表 ECharts 自适应

手机竖屏 / 横屏均可正常查看，无需 App。
