# 部署 deepcode 落地页

- 服务器:47.115.229.192
- 域名:deepcode.dirctable.com(DNS A 记录 → 47.115.229.192)

## 1. 上传

    rsync -avz --delete site/ root@47.115.229.192:/var/www/deepcode/

## 2. Nginx

/etc/nginx/conf.d/deepcode.conf:

    server {
      listen 80;
      server_name deepcode.dirctable.com;
      root /var/www/deepcode;
      index index.html;
      location / { try_files $uri $uri/ /index.html; }
    }

    nginx -t && systemctl reload nginx

## 3. HTTPS(可选)

    certbot --nginx -d deepcode.dirctable.com

## 更新

改完重跑第 1 步 rsync 即可(静态站,无需重启)。
