# 部署 deepcode 落地页

线上：https://deepcode.dirctable.com

- 服务器：47.115.229.192
- 域名：deepcode.dirctable.com（DNS A 记录 → 该 IP）

## 拓扑

静态站由一个小 nginx 容器 `deepcode-static` 提供，站点文件挂载自服务器 `/opt/deepcode-site`（只读）；再由服务器既有的前置 nginx 反向代理 + Let's Encrypt 证书对外提供 HTTPS。

## 更新内容（改了 `site/` 之后）

一条命令即可，容器只读挂载 + nginx 实时读盘，**无需重启**：

    rsync -avz --delete --exclude DEPLOY.md site/ root@47.115.229.192:/opt/deepcode-site/

## 首次部署（已完成，供重建参考）

1. 同步文件：`mkdir -p /opt/deepcode-site`，再跑上面的 rsync。
2. 起静态容器并接入前置 nginx 所在的 docker 网络：

       docker run -d --name deepcode-static --restart unless-stopped \
         -v /opt/deepcode-site:/usr/share/nginx/html:ro nginx:alpine
       docker network connect <前置nginx网络> deepcode-static

3. 签证书（webroot 走前置 nginx 的 acme-challenge）：

       certbot certonly --webroot -w /var/www/certbot -d deepcode.dirctable.com

4. 在前置 nginx 配置追加 `deepcode.dirctable.com` 的两个 server 块：
   - `listen 80`：`.well-known/acme-challenge` → `/var/www/certbot`，其余 `301` 跳 https；
   - `listen 443 ssl`：引用上面的证书，`proxy_pass http://deepcode-static:80` + 标准 proxy headers。

   然后 `nginx -t` 通过再 reload。

## 注意

改前置 nginx 前**先备份 + `nginx -t` 通过再 reload**（该 nginx 还服务其它站点，配置出错会波及）。
