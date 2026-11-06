// 오라클 새 서버를 만들 때 붙여 넣을 cloud-init.yaml을 만든다.
// 실행: node make-cloud-init.mjs  → cloud-init.yaml
// 서버가 처음 켜질 때: Node·Caddy 설치 → 승강장 서버 등록 → 80/443 방화벽 열기 → https 인증서(sslip.io) 자동 발급
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const server = await readFile(join(HERE, "station-server.mjs"), "utf8");
const pkg = await readFile(join(HERE, "package.json"), "utf8");
const pub = (await readFile(join(homedir(), ".ssh", "oracle_station.pub"), "utf8")).trim();

const unit = `[Unit]
Description=time-price station websocket
After=network-online.target

[Service]
WorkingDirectory=/opt/station
Environment=PORT=8787
Environment=ALLOW_ORIGINS=https://seangold8888.github.io,http://localhost:5178
ExecStart=/usr/bin/node /opt/station/station-server.mjs
Restart=always
RestartSec=3
User=station
NoNewPrivileges=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

const setup = `#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y nodejs npm curl debian-keyring debian-archive-keyring apt-transport-https gnupg iptables-persistent
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
id station || useradd --system --home /opt/station --shell /usr/sbin/nologin station
cd /opt/station && npm install --omit=dev && chown -R station:station /opt/station
systemctl daemon-reload && systemctl enable --now station
# 오라클 우분투 이미지의 기본 방화벽은 22번만 연다 → 80/443 추가
iptables -I INPUT 5 -p tcp --dport 80 -m state --state NEW -j ACCEPT
iptables -I INPUT 5 -p tcp --dport 443 -m state --state NEW -j ACCEPT
netfilter-persistent save
IP=$(curl -s https://ifconfig.me || curl -s https://api.ipify.org)
HOST="$(echo "$IP" | tr . -).sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  reverse_proxy /station* 127.0.0.1:8787
  reverse_proxy /health 127.0.0.1:8787
  respond 404
}
EOF
systemctl restart caddy
echo "$HOST" > /opt/station/HOST
`;

const yaml = `#cloud-config
# 내시간역 실시간 서버 (time-price station). make-cloud-init.mjs가 만든 파일.
ssh_authorized_keys:
  - ${pub}
write_files:
  - path: /opt/station/station-server.mjs
    encoding: b64
    content: ${b64(server)}
  - path: /opt/station/package.json
    encoding: b64
    content: ${b64(pkg)}
  - path: /etc/systemd/system/station.service
    encoding: b64
    content: ${b64(unit)}
  - path: /opt/station/setup.sh
    permissions: "0755"
    encoding: b64
    content: ${b64(setup)}
runcmd:
  - [bash, /opt/station/setup.sh]
`;
await writeFile(join(HERE, "cloud-init.yaml"), yaml, "utf8");
console.log("cloud-init.yaml 저장", yaml.length, "bytes");
